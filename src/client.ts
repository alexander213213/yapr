import tls from "node:tls";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  ackRequest,
  addMembersRequest,
  createGroupRequest,
  fetchGroupsRequest,
  fetchKeysRequest,
  identifyRequest,
  leaveGroupRequest,
  parseServerFrame,
  pongFrame,
  readRequest,
  reclaimRequest,
  registerRequest,
  removeMemberRequest,
  renameGroupRequest,
  requestHistoryRequest,
  sendGroupRequest,
  sendRequest,
  type GroupCreatedFrame,
  type GroupsFrame,
  type IncomingFrame,
  type KeysFrame,
  type ServerAckFrame,
  type ServerFrame,
} from "./protocol.js";
import { loadOrCreateIdentity, openEnvelope, sealText, UNREADABLE_PLACEHOLDER } from "./crypto.js";
import * as store from "./store.js";
import { loadReclaimToken, resolveDataDir, saveReclaimToken } from "./storage.js";
import { socketBus } from "./eventStore.js";
import type { MessageRow } from "./types.js";

export type ConnState = "offline" | "connecting" | "online";

/** Packaged default: the staging relay. Explicit HOST/PORT always win. */
export const DEFAULT_HOST = "nozomi.proxy.rlwy.net";
export const DEFAULT_PORT = 15038;

export type Endpoint = { host: string; port: number; fromDefault: boolean };

export function resolveEndpoint(env: NodeJS.ProcessEnv = process.env): Endpoint {
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const port = Number(env.PORT ?? String(DEFAULT_PORT));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT ?? "(unset)"}`);
  }
  return { host, port, fromDefault: !env.HOST && env.PORT === undefined };
}

export type TlsSource = "ca-file" | "insecure-explicit" | "insecure-default";
export type TlsTrust = { options: tls.ConnectionOptions; verified: boolean; source: TlsSource };

export function resolveTlsOptions(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => fs.readFileSync(p, "utf8")
): TlsTrust {
  const caFile = env.YAPR_CA_FILE?.trim();
  if (caFile) {
    return { options: { ca: readFile(caFile) }, verified: true, source: "ca-file" };
  }
  // Staging default until the domain lands: the relay's cert is self-signed,
  // so verification would fail for every default install. Message content
  // stays E2EE-confidential regardless; only relay authentication is
  // conceded. Set YAPR_CA_FILE to verify.
  const insecure = { rejectUnauthorized: false };
  if (env.YAPR_INSECURE === "1") {
    return { options: insecure, verified: false, source: "insecure-explicit" };
  }
  return { options: insecure, verified: false, source: "insecure-default" };
}

const { host: HOST, port: PORT } = resolveEndpoint();
const trust = resolveTlsOptions();
if (!process.env.VITEST) {
  // Runs at import, before the TUI takes the screen (same as the data-dir log).
  console.log(
    `yapr endpoint ${HOST}:${PORT} (${
      trust.verified
        ? "TLS verified"
        : "TLS verification OFF — staging default until the domain lands; set YAPR_CA_FILE to verify"
    })`
  );
}

const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES ?? 64 * 1024);
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const KEYS_TIMEOUT_MS = 10_000;

function tlsOptions(): tls.ConnectionOptions {
  return trust.options;
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
  private groupsWaiter: ((groups: GroupsFrame) => void) | null = null;
  // Group creation resolves on group_created but must ALSO reject on error
  // frames: without this, a server rejection (rate limit, unknown member)
  // leaves the caller hanging until timeout with the error toast hidden
  // behind the fullscreen modal.
  private groupCreatedWaiter: {
    resolve: (created: GroupCreatedFrame) => void;
    reject: (err: Error) => void;
  } | null = null;
  // Silent account recovery (see reclaim flow below). All three reset per
  // connection: each reconnect cycle gets exactly one reclaim attempt.
  private identifyPendingUserId: string | null = null;
  private reclaimAttempted = false;
  private reclaimInFlight = false;
  private pendingReclaimCreds: { userId: string; secret: string } | null = null;

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
    this.reclaimAttempted = false;
    this.reclaimInFlight = false;
    this.pendingReclaimCreds = null;
    this.identifyPendingUserId = null;
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
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt += 1;
    // Visible, every time: a silent reconnect loop is indistinguishable from
    // a hang (learned the hard way). The UI holds the latest notice until a
    // connection succeeds.
    socketBus.emit("connection_notice", { attempt, reason, delayMs: delay });
    // Intentionally ref'd: a messenger must stay alive across reconnects.
    // stop() clears the timer so the process can still exit cleanly.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
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
    this.identifyPendingUserId = user.user_id;
    this.sendFrame(identifyRequest(user.user_id, user.secret));
  }

  /**
   * Silent account recovery after server data loss. Triggered once per
   * connection when an identify is rejected while we hold a stored session
   * and a recovery token: the token re-creates our id on the fresh server
   * (fresh secret), then we identify normally. Never falls through to a
   * fresh registration while a token exists — that would silently fork our
   * identity and orphan every contact/history anchor.
   */
  private attemptReclaim(): void {
    if (this.reclaimAttempted) return;
    const user = store.getSessionUser();
    if (!user) return;
    let token: string | null = null;
    try {
      token = loadReclaimToken(resolveDataDir());
    } catch {
      token = null;
    }
    if (!token) return;
    this.reclaimAttempted = true;
    this.reclaimInFlight = true;
    const { publicKeyB64 } = loadOrCreateIdentity();
    this.sendFrame(reclaimRequest(token, publicKeyB64));
  }

  private persistReclaimToken(token: string | undefined): void {
    if (!token) return;
    try {
      saveReclaimToken(resolveDataDir(), token);
    } catch {
      // Best effort: the server re-mints on every identify, so a missed
      // write heals on the next login.
    }
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
        this.persistReclaimToken(frame.reclaimToken);
        if (this.reclaimInFlight) {
          // Recovery reply: hold the fresh secret in memory and identify.
          // The stored session is overwritten only after identify succeeds,
          // so a failed identify never destroys our old credentials.
          this.reclaimInFlight = false;
          this.pendingReclaimCreds = { userId: frame.userId, secret: frame.secret };
          this.identifyPendingUserId = frame.userId;
          this.sendFrame(identifyRequest(frame.userId, frame.secret));
        } else {
          store.saveSessionUser(frame.userId, frame.secret);
          this.identifyPendingUserId = frame.userId;
          this.sendFrame(identifyRequest(frame.userId, frame.secret));
        }
        break;
      case "identified":
        this.persistReclaimToken(frame.reclaimToken);
        this.identifyPendingUserId = null;
        if (this.pendingReclaimCreds && this.pendingReclaimCreds.userId === frame.userId) {
          store.saveSessionUser(this.pendingReclaimCreds.userId, this.pendingReclaimCreds.secret);
          this.pendingReclaimCreds = null;
          socketBus.emit("reclaim_status", {
            ok: true,
            message: `account ${frame.userId} recovered on ${HOST}:${PORT}`,
          });
        }
        socketBus.emit("identified");
        void this.syncAfterIdentify();
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
      case "groups":
        this.resolveGroups(frame);
        break;
      case "group_created":
        this.resolveGroupCreated(frame);
        break;
      case "group_updated":
        void this.refreshGroups();
        break;
      case "history_request":
        socketBus.emit("history_request", frame);
        break;
      case "error":
        // A pending group creation must fail fast with the server's message
        // (surfaced inline by the modal) instead of hanging to timeout.
        // The toast still emits for every other consumer.
        if (this.groupCreatedWaiter) {
          this.rejectGroupCreated(new Error(`${frame.code}: ${frame.message}`));
        }
        if (this.reclaimInFlight) {
          // Our recovery attempt was rejected (unknown id taken, recovery
          // unavailable, rate-limited): surface persistently, stay on the old
          // session, and never fork to a fresh registration.
          this.reclaimInFlight = false;
          this.pendingReclaimCreds = null;
          socketBus.emit("reclaim_status", {
            ok: false,
            message: `account recovery failed (${frame.code}) — contact operator`,
          });
          break;
        }
        if (frame.code === "UNAUTH" && this.identifyPendingUserId && !this.reclaimAttempted) {
          // Identify rejected while we hold a stored session: the server
          // likely lost its database. Try silent recovery; the original
          // UNAUTH stays silent unless recovery also fails.
          this.identifyPendingUserId = null;
          this.attemptReclaim();
          if (this.reclaimInFlight) break;
        }
        socketBus.emit("server_error", frame);
        break;
    }
  }

  private resolveKeys(frame: KeysFrame): void {
    const waiter = this.keysWaiter;
    this.keysWaiter = null;
    if (waiter) waiter(frame.keys);
  }

  private resolveGroups(frame: GroupsFrame): void {
    const waiter = this.groupsWaiter;
    this.groupsWaiter = null;
    if (waiter) waiter(frame);
  }

  private resolveGroupCreated(frame: GroupCreatedFrame): void {
    const waiter = this.groupCreatedWaiter;
    this.groupCreatedWaiter = null;
    if (waiter) waiter.resolve(frame);
  }

  private rejectGroupCreated(err: Error): void {
    const waiter = this.groupCreatedWaiter;
    this.groupCreatedWaiter = null;
    if (waiter) waiter.reject(err);
  }

  /** After identify: refresh group membership first (flush may target groups). */
  private async syncAfterIdentify(): Promise<void> {
    try {
      await this.refreshGroups();
    } catch {
      // Offline races resolve on reconnect; keep going.
    }
    await this.flushOutbox();
  }

  /** Pull the membership snapshot into the local cache. */
  async refreshGroups(): Promise<void> {
    if (!this.online) throw new Error("offline");
    const frame = await new Promise<GroupsFrame>((resolve, reject) => {
      if (!this.sendFrame(fetchGroupsRequest())) {
        reject(new Error("offline"));
        return;
      }
      this.groupsWaiter = resolve;
      const timer = setTimeout(() => {
        if (this.groupsWaiter) {
          this.groupsWaiter = null;
          reject(new Error("groups lookup timed out"));
        }
      }, KEYS_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });
    const seen = new Set<string>();
    const knownBefore = new Set(store.listGroupCache().map((g) => g.groupId));
    for (const g of frame.groups) {
      seen.add(g.groupId);
      store.upsertGroupCache(
        g.groupId,
        g.name,
        g.members.map((m) => ({ user_id: m.userId, role: m.role, joined_at: m.joinedAt }))
      );
      // Newly discovered groups (invites) open a sidebar thread automatically.
      if (!knownBefore.has(g.groupId)) {
        store.openChat(store.groupThreadKey(g.groupId));
      }
    }
    for (const cached of store.listGroupCache()) {
      if (!seen.has(cached.groupId)) {
        store.dropGroupCache(cached.groupId);
      }
    }
    socketBus.emit("groups_changed");
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

  /** Seal + transmit one DM (or group-tagged share). Throws when offline or
   *  keyless (row stays pending). Nicknames ride inside the envelope. */
  async sendChatText(
    to: string,
    clientMessageId: string,
    text: string,
    groupId?: string
  ): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    const keys = await this.requestKeys([to]);
    const nick = store.nickForContext(groupId ?? null, user.user_id);
    const envelope = sealText(this.peerKeyOrThrow(to, keys), user.user_id, to, text, nick);
    if (!this.sendFrame(sendRequest(to, clientMessageId, envelope, groupId))) {
      throw new Error("offline");
    }
  }

  /** Seal to every current member and fan out with one shared clientMessageId. */
  async sendGroupText(groupId: string, clientMessageId: string, text: string): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    let members = store.getGroupMembers(groupId).filter((m) => m.user_id !== user.user_id);
    if (members.length === 0) {
      await this.refreshGroups();
      members = store.getGroupMembers(groupId).filter((m) => m.user_id !== user.user_id);
    }
    if (members.length === 0) throw new Error("not a group member");
    const keys = await this.requestKeys(members.map((m) => m.user_id));
    const nick = store.nickForContext(groupId, user.user_id);
    const envelopes = members.map((m) => ({
      to: m.user_id,
      ...sealText(this.peerKeyOrThrow(m.user_id, keys), user.user_id, m.user_id, text, nick),
    }));
    if (!this.sendFrame(sendGroupRequest(groupId, clientMessageId, envelopes))) {
      throw new Error("offline");
    }
  }

  /** Resend unsent outbox rows with their original ids (idempotent server-side). */
  async flushOutbox(): Promise<void> {
    for (const row of store.getPendingOutbox()) {
      if (!this.online || !row.client_message_id) break;
      try {
        if (row.group_id) {
          await this.sendGroupText(
            row.group_id,
            row.client_message_id,
            row.text
          );
        } else {
          await this.sendChatText(row.peer_id, row.client_message_id, row.text);
        }
      } catch {
        break;
      }
    }
  }

  /** Share recent thread history with a member (explicit approval only — G3 UI). */
  async shareHistory(groupId: string, toUserId: string, limit: number = 20): Promise<number> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    const rows = store.getGroupMessages(groupId).slice(-limit);
    let shared = 0;
    for (const row of rows) {
      if (row.text === UNREADABLE_PLACEHOLDER) continue;
      await this.sendChatText(toUserId, randomUUID(), row.text, groupId);
      shared += 1;
    }
    return shared;
  }

  async createGroup(name: string, memberIds: string[]): Promise<string> {
    if (!this.online) throw new Error("offline");
    const created = await new Promise<GroupCreatedFrame>((resolve, reject) => {
      if (!this.sendFrame(createGroupRequest(name, memberIds))) {
        reject(new Error("offline"));
        return;
      }
      this.groupCreatedWaiter = { resolve, reject };
      const timer = setTimeout(() => {
        if (this.groupCreatedWaiter) {
          this.groupCreatedWaiter = null;
          reject(new Error("create group timed out"));
        }
      }, KEYS_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });
    await this.refreshGroups();
    return created.groupId;
  }

  addMembers(groupId: string, userIds: string[]): void {
    this.sendFrame(addMembersRequest(groupId, userIds));
  }

  removeMember(groupId: string, userId: string): void {
    this.sendFrame(removeMemberRequest(groupId, userId));
  }

  leaveGroup(groupId: string): void {
    this.sendFrame(leaveGroupRequest(groupId));
  }

  renameGroup(groupId: string, name: string): void {
    this.sendFrame(renameGroupRequest(groupId, name));
  }

  requestGroupHistory(groupId: string, toUserId: string): void {
    this.sendFrame(requestHistoryRequest(groupId, toUserId));
  }

  private async handleIncoming(frame: IncomingFrame): Promise<void> {
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
    const nick = opened.ok ? opened.nick : "";
    const stored = store.insertIncomingMessage(
      frame.from,
      frame.messageId,
      text,
      frame.timestamp,
      frame.groupId,
      nick
    );
    if (frame.groupId) {
      // Group mail files into the group thread; ensure membership is known.
      if (!store.getGroupCache(frame.groupId)) {
        try {
          await this.refreshGroups();
        } catch {
          // Best effort; the next snapshot heals it.
        }
      }
      store.openChat(store.groupThreadKey(frame.groupId));
    } else if (store.ensureContact(frame.from)) {
      socketBus.emit("new_contact");
    }
    if (!frame.groupId && nick) {
      // DM only: surface a newcomer's advertised name (blank aliases only).
      store.adoptAdvertisedNick(frame.from, nick);
    }
    if (stored.inserted) {
      const msg: MessageRow = {
        id: stored.rowId,
        peer_id: frame.from,
        direction: "in",
        message_id: frame.messageId,
        group_id: frame.groupId ?? null,
        sender_nick: nick || null,
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
export function sendChatText(
  to: string,
  clientMessageId: string,
  text: string,
  groupId?: string
): Promise<void> {
  return client.sendChatText(to, clientMessageId, text, groupId);
}

/** Module-level read receipt used by thread views. */
export function sendReadReceipt(messageId: string): void {
  client.sendReadReceipt(messageId);
}

/** Module-level group send used by group thread views. */
export function sendGroupText(
  groupId: string,
  clientMessageId: string,
  text: string
): Promise<void> {
  return client.sendGroupText(groupId, clientMessageId, text);
}
