import tls from "node:tls";
import fs from "node:fs";
import {
  ackRequest,
  fetchKeysRequest,
  identifyRequest,
  parseServerFrame,
  pongFrame,
  readRequest,
  registerRequest,
  sendRequest,
  type KeysFrame,
  type ServerAckFrame,
  type ServerFrame,
} from "./protocol.js";
import { loadOrCreateIdentity, openEnvelope, sealText, UNREADABLE_PLACEHOLDER } from "./crypto.js";
import * as store from "./store.js";
import { socketBus } from "./eventStore.js";
import type { MessageRow } from "./types.js";

export type ConnState = "offline" | "connecting" | "online";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "9000");
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT ?? "(unset)"}`);
}

const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES ?? 64 * 1024);
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const KEYS_TIMEOUT_MS = 10_000;

function tlsOptions(): tls.ConnectionOptions {
  const caFile = process.env.YAPR_CA_FILE;
  if (caFile) {
    return { ca: fs.readFileSync(caFile, "utf8") };
  }
  if (process.env.YAPR_INSECURE === "1") {
    return { rejectUnauthorized: false };
  }
  // System CAs: works with real production certs, fails loudly on self-signed.
  return {};
}

function backoffDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

class YaprClient {
  private socket: tls.TLSSocket | null = null;
  private buffer = "";
  private state: ConnState = "offline";
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keysChain: Promise<void> = Promise.resolve();
  private keysWaiter: ((keys: Record<string, string>) => void) | null = null;

  get online(): boolean {
    return this.state === "online";
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.setState("offline");
  }

  private setState(next: ConnState): void {
    if (this.state === next) return;
    this.state = next;
    socketBus.emit("connection", next === "online");
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    this.buffer = "";
    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({ host: HOST, port: PORT, ...tlsOptions() });
    } catch (err) {
      this.scheduleReconnect(String(err));
      return;
    }
    this.socket = socket;
    socket.setEncoding("utf8");

    socket.once("secureConnect", () => {
      if (this.socket !== socket) {
        socket.destroy();
        return;
      }
      this.reconnectAttempt = 0;
      this.setState("online");
      this.registerOrIdentify();
    });

    socket.on("data", (chunk: string) => this.onData(socket, chunk));
    socket.once("close", (hadError: boolean) => {
      void hadError;
      this.onClose(socket);
    });
    socket.on("error", (err: Error) => {
      void err;
      // Close follows; handled there. Never throws on peer input.
    });
  }

  private onClose(socket: tls.TLSSocket): void {
    // Stale sockets (superseded by a newer connect) must not touch state.
    if (this.socket !== socket) return;
    this.socket = null;
    this.setState("offline");
    this.scheduleReconnect("connection closed");
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    // Intentionally ref'd: a messenger must stay alive across reconnects.
    // stop() clears the timer so the process can still exit cleanly.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    void reason;
  }

  private sendFrame(payload: object): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    socket.write(JSON.stringify(payload) + "\n");
    return true;
  }

  private registerOrIdentify(): void {
    const user = store.getSessionUser();
    if (!user) {
      const { publicKeyB64 } = loadOrCreateIdentity();
      this.sendFrame(registerRequest(publicKeyB64));
      return;
    }
    this.sendFrame(identifyRequest(user.user_id, user.secret));
  }

  private onData(socket: tls.TLSSocket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_BYTES + 1024) {
      socket.destroy();
      return;
    }
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const raw = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (raw.length > 0) {
        if (raw.length > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const parsed = parseServerFrame(raw);
        if (parsed) {
          try {
            this.dispatch(parsed);
          } catch {
            // Never let peer input crash the client.
          }
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.type) {
      case "registered":
        store.saveSessionUser(frame.userId, frame.secret);
        this.sendFrame(identifyRequest(frame.userId, frame.secret));
        break;
      case "identified":
        socketBus.emit("identified");
        void this.flushOutbox();
        break;
      case "keys":
        this.resolveKeys(frame);
        break;
      case "server_ack":
        store.markMessageSent(frame.clientMessageId, frame.messageId, frame.timestamp);
        socketBus.emit("send_ack", frame);
        break;
      case "incoming":
        void this.handleIncoming(frame);
        break;
      case "pending_done":
        break;
      case "read_receipt":
        store.markMessageRead(frame.messageId);
        socketBus.emit("read_receipt", frame);
        break;
      case "ping":
        this.sendFrame(pongFrame());
        break;
      case "error":
        socketBus.emit("server_error", frame);
        break;
    }
  }

  private resolveKeys(frame: KeysFrame): void {
    const waiter = this.keysWaiter;
    this.keysWaiter = null;
    if (waiter) waiter(frame.keys);
  }

  /** Fetch missing pubkeys (cached in store). Serialized; concurrent callers queue. */
  async requestKeys(userIds: string[]): Promise<Record<string, string>> {
    const cached: Record<string, string> = {};
    const missing = userIds.filter((id) => {
      const key = store.getPeerKey(id);
      if (key) {
        cached[id] = key;
        return false;
      }
      return true;
    });
    if (missing.length === 0) return cached;
    const fetchedP: Promise<Record<string, string>> = this.keysChain.then(() =>
      this.fetchKeysRoundTrip(missing)
    );
    this.keysChain = fetchedP.then(
      () => undefined,
      () => undefined
    );
    const fetched = await fetchedP;
    for (const [id, key] of Object.entries(fetched)) {
      store.setPeerKey(id, key);
      cached[id] = key;
    }
    return cached;
  }

  private fetchKeysRoundTrip(userIds: string[]): Promise<Record<string, string>> {
    if (!this.sendFrame(fetchKeysRequest(userIds))) {
      return Promise.reject(new Error("offline"));
    }
    return new Promise<Record<string, string>>((resolve, reject) => {
      this.keysWaiter = resolve;
      const timer = setTimeout(() => {
        if (this.keysWaiter) {
          this.keysWaiter = null;
          reject(new Error("keys lookup timed out"));
        }
      }, KEYS_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });
  }

  private peerKeyOrThrow(peerId: string, keys: Record<string, string>): string {
    const key = keys[peerId] ?? store.getPeerKey(peerId);
    if (!key) throw new Error(`no public key for ${peerId}`);
    return key;
  }

  /** Seal + transmit one message. Throws when offline or keyless (row stays pending). */
  async sendChatText(to: string, clientMessageId: string, text: string): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    const keys = await this.requestKeys([to]);
    const envelope = sealText(this.peerKeyOrThrow(to, keys), user.user_id, to, text);
    if (!this.sendFrame(sendRequest(to, clientMessageId, envelope))) {
      throw new Error("offline");
    }
  }

  /** Resend unsent outbox rows with their original ids (idempotent server-side). */
  async flushOutbox(): Promise<void> {
    for (const row of store.getPendingOutbox()) {
      if (!this.online || !row.client_message_id) break;
      try {
        await this.sendChatText(row.peer_id, row.client_message_id, row.text);
      } catch {
        break;
      }
    }
  }

  private async handleIncoming(frame: {
    from: string;
    messageId: string;
    ciphertext: string;
    nonce: string;
    timestamp: number;
  }): Promise<void> {
    const user = store.getSessionUser();
    let senderKey: string | null = store.getPeerKey(frame.from);
    if (!senderKey) {
      try {
        const keys = await this.requestKeys([frame.from]);
        senderKey = keys[frame.from] ?? null;
      } catch {
        senderKey = null;
      }
    }
    const opened = openEnvelope(senderKey, user?.user_id ?? "", frame.from, {
      ciphertext: frame.ciphertext,
      nonce: frame.nonce,
    });
    const text = opened.ok ? opened.text : UNREADABLE_PLACEHOLDER;
    const stored = store.insertIncomingMessage(frame.from, frame.messageId, text, frame.timestamp);
    if (store.ensureContact(frame.from)) {
      socketBus.emit("new_contact");
    }
    if (stored.inserted) {
      const msg: MessageRow = {
        id: stored.rowId,
        peer_id: frame.from,
        direction: "in",
        message_id: frame.messageId,
        text,
        created_at: frame.timestamp,
        status: "received",
      };
      socketBus.emit("incoming_message", msg);
    }
    this.sendFrame(ackRequest(frame.messageId));
  }

  /** Queue a read receipt for C3 thread views. */
  sendReadReceipt(messageId: string): void {
    this.sendFrame(readRequest(messageId));
  }
}

export const client = new YaprClient();
export type { ServerAckFrame };

/** Module-level send used by the outbox UI. */
export function sendChatText(to: string, clientMessageId: string, text: string): Promise<void> {
  return client.sendChatText(to, clientMessageId, text);
}
