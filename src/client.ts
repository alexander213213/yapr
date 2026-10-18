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
  shareHistoryDoneRequest,
  type GroupCreatedFrame,
  type GroupsFrame,
  type HistoryDoneFrame,
  type HistoryRequestFrame,
  type IncomingFrame,
  type KeysFrame,
  type ServerAckFrame,
  type ServerFrame,
} from "./protocol.js";
import { loadOrCreateIdentity, openEnvelope, sealText, UNREADABLE_PLACEHOLDER } from "./crypto.js";
import type { ForwardBlock, NickPayload } from "./crypto.js";
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

/** History backfill: rows per auto round, process cap per group, stall horizon. */
const HISTORY_SYNC_ROUND_LIMIT = 20;
const HISTORY_SYNC_MAX_TOTAL = 100;
const HISTORY_SYNC_STALL_MS = 60_000;
/** Re-drive tick: open gaps re-request on their own instead of waiting for
 *  an unrelated membership refresh (a parked gap used to die quietly). */
const HISTORY_SYNC_REDRIVE_MS = 30_000;

/** Per-group backfill loop state. `tried`/`target` drive the fallback walk:
 *  sharers that answered empty, and the explicitly targeted sharer, if any.
 *  `cursor`/`full` drive interior walks (leave/rejoin holes): the exclusive
 *  upper bound of the served window and whether this campaign scans it. */
type HistorySyncState = {
  total: number;
  done: boolean;
  inFlight: boolean;
  lastActivityAt: number;
  tried?: string[] | undefined;
  target?: string | undefined;
  cursor?: number | undefined;
  full?: boolean | undefined;
};

/** Groups with an unfinished backfill (survives restarts via settings). */
function getPendingHistorySync(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(store.getSetting("history_sync_pending"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function setPendingHistorySync(ids: Set<string>): void {
  try {
    store.setSetting("history_sync_pending", JSON.stringify([...ids]));
  } catch {
    // Best effort: worst case a restart mid-sync stalls one gap window.
  }
}

/**
 * Interior-walk completion markers: { [groupId]: joinedAt } for memberships
 * whose full newest-to-floor walk finished. A member holding rows older than
 * its own joined_at with a stale (or missing) marker is a rejoiner with a
 * leave-window hole. Cleared implicitly: rejoin bumps joined_at, which
 * mismatches the recorded value. Best effort like the pending set.
 */
function getFullSyncMarkers(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(store.getSetting("history_full_sync"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function fullSyncDoneFor(groupId: string, joinedAt: number): boolean {
  return getFullSyncMarkers()[groupId] === joinedAt;
}

function setFullSyncDone(groupId: string, joinedAt: number): void {
  try {
    const markers = getFullSyncMarkers();
    markers[groupId] = joinedAt;
    store.setSetting("history_full_sync", JSON.stringify(markers));
  } catch {
    // Best effort: worst case the next boot re-walks (dedup absorbs it).
  }
}

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
  // Membership snapshot waiters: a SET, not a slot. Overlapping refreshes
  // (e.g. a group_updated broadcast landing mid-refresh — which creation
  // always triggers) must all settle; a single slot lets the second request
  // clobber the first, orphaning its promise past its own timeout. Snapshot
  // reads are idempotent, so one answer resolves every pending waiter.
  private groupsWaiters = new Set<{
    resolve: (groups: GroupsFrame) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
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
  // Automatic history backfill per group. Stateless across restarts by design:
  // a repeat round after reboot simply re-resolves against current earliest
  // rows, and dedup absorbs overlaps. `done` stops all future rounds.
  private historySync = new Map<string, HistorySyncState>();
  // Backfill re-drive: maybeSyncGroups otherwise runs only on membership
  // refreshes, so a round killed by a momentary ghost (offline electee,
  // lost done) parks forever. Started in start(), cleared in stop().
  private syncTimer: NodeJS.Timeout | null = null;
  // Poisoned-history migration runs once per process (reconnects must not
  // re-wipe; the delete is idempotent anyway, but re-queueing would spam).
  private poisonMigrated = false;

  get online(): boolean {
    return this.state === "online";
  }

  start(): void {
    this.stopped = false;
    if (!this.syncTimer) {
      this.syncTimer = setInterval(() => {
        if (!this.stopped && this.online) {
          this.redriveHistorySync();
        }
      }, HISTORY_SYNC_REDRIVE_MS);
      if (this.syncTimer.unref) this.syncTimer.unref();
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
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
        // No prompt, by design: the elected member shares the requested gap
        // window immediately. Best effort — the requester's stall guard
        // re-requests when a share never completes.
        void this.autoShareHistory(frame).catch(() => {});
        break;
      case "history_done":
        this.onHistoryDone(frame);
        break;
      case "error":
        if (frame.code === "OFFLINE") {
          // Most often a history election with nobody electable (or a
          // targeted share at a departed member): unpark open gaps so the
          // re-drive timer retries instead of stalling to the next refresh.
          // Done/cap/tried state is kept; a redundant round is dedup-safe.
          this.unparkHistorySync();
        }
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
    // Fan-out: every pending refresh shares the latest snapshot. Late
    // duplicates (a second answer to already-settled requests) find an
    // empty set and drop.
    const pending = [...this.groupsWaiters];
    this.groupsWaiters.clear();
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
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
    this.migratePoisonedHistoryOnce();
    await this.flushOutbox();
  }

  /**
   * One-time cleanup for pre-fix backfill rows (thread key filed as sender).
   * Deletes them and re-queues the affected gaps; the normal loop refires on
   * the refresh below and fixed sharers re-send with correct attribution.
   * Idempotent: later runs find nothing and skip silently.
   */
  private migratePoisonedHistoryOnce(): void {
    if (this.poisonMigrated) return;
    this.poisonMigrated = true;
    let affected: string[];
    try {
      affected = store.deletePoisonedHistory();
    } catch {
      return;
    }
    if (affected.length === 0) return;
    const pending = getPendingHistorySync();
    let changed = false;
    for (const id of affected) {
      if (!pending.has(id)) {
        pending.add(id);
        changed = true;
      }
    }
    if (changed) setPendingHistorySync(pending);
    socketBus.emit("chats_changed");
    // Re-evaluate immediately so re-queued gaps don't wait for the next
    // unrelated refresh to refire.
    this.maybeSyncGroups();
  }

  /** Pull the membership snapshot into the local cache. */
  async refreshGroups(): Promise<void> {
    if (!this.online) throw new Error("offline");
    type GroupsEntry = {
      resolve: (groups: GroupsFrame) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    };
    const frame = await new Promise<GroupsFrame>((resolve, reject) => {
      if (!this.sendFrame(fetchGroupsRequest())) {
        reject(new Error("offline"));
        return;
      }
      // Own entry, own timer: a sibling settling first only removes its own
      // entry, so overlapping refreshes can neither orphan nor double-settle
      // each other.
      let entry: GroupsEntry;
      const timer = setTimeout(() => {
        if (this.groupsWaiters.delete(entry)) {
          entry.reject(new Error("groups lookup timed out"));
        }
      }, KEYS_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      entry = { resolve, reject, timer };
      this.groupsWaiters.add(entry);
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
    // Single choke point: every membership refresh (identify, invites,
    // reconnects, group updates) re-evaluates backfill gaps. Guards inside
    // make repeats no-ops.
    this.maybeSyncGroups();
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
    groupId?: string,
    fwd?: ForwardBlock
  ): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    const keys = await this.requestKeys([to]);
    const nick = store.nickForContext(groupId ?? null, user.user_id);
    const envelope = sealText(this.peerKeyOrThrow(to, keys), user.user_id, to, text, nick, fwd);
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

  /**
   * Share a gap window of thread history with a member: rows older than
   * `before`, up to `limit`, each re-sealed to the requester with its
   * ORIGINAL attribution inside the envelope (stable original message id for
   * cross-sharer dedup). Always closes with a done notice — including zero —
   * so the requester can tell "floor reached" from failure. Rows the sharer
   * cannot decrypt are skipped. Returns the served count and the floor
   * (oldest created_at served, null when nothing was): the requester's
   * cursor for the next window.
   */
  async shareHistoryGap(
    groupId: string,
    toUserId: string,
    before: number,
    limit: number
  ): Promise<{ count: number; floor: number | null }> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    const rows = store.getGroupMessagesBefore(groupId, before, limit).reverse();
    let shared = 0;
    let floor: number | null = null;
    for (const row of rows) {
      if (row.text === UNREADABLE_PLACEHOLDER) continue;
      if (!row.message_id) continue;
      await this.sendHistoryRow(groupId, toUserId, row);
      shared += 1;
      if (floor === null || row.created_at < floor) floor = row.created_at;
    }
    this.sendFrame(shareHistoryDoneRequest(toUserId, groupId, shared, floor));
    return { count: shared, floor };
  }

  private async sendHistoryRow(
    groupId: string,
    toUserId: string,
    row: MessageRow
  ): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    if (!row.message_id) throw new Error("history row without id");
    const keys = await this.requestKeys([toUserId]);
    const nick = store.nickForContext(groupId, user.user_id);
    // Outbound rows store the thread key ("g:…") as peer_id by convention —
    // re-sealing that would poison the requester with an unresolvable sender.
    // The author is always this device's owner, so attribute to self.
    const from = row.direction === "out" ? user.user_id : row.peer_id;
    const originNick = row.direction === "out" ? nick : (row.sender_nick ?? "");
    const envelope = sealText(
      this.peerKeyOrThrow(toUserId, keys),
      user.user_id,
      toUserId,
      row.text,
      nick,
      {
        id: row.message_id,
        from,
        nick: originNick,
        sentAt: row.created_at,
      }
    );
    if (!this.sendFrame(sendRequest(toUserId, randomUUID(), envelope, groupId))) {
      throw new Error("offline");
    }
  }

  /** Elected-sharer entry: share the requested gap window, no prompt. */
  private async autoShareHistory(frame: HistoryRequestFrame): Promise<void> {
    // Don't share to self — the requester already has these rows locally.
    if (frame.requester === store.getSessionUser()?.user_id) {
      this.sendFrame(shareHistoryDoneRequest(frame.requester, frame.groupId, 0));
      return;
    }
    // Legacy bounds-absent requests (old manual flow) keep old semantics:
    // the most recent window. New requests carry the true gap bounds.
    const before = frame.before ?? Date.now();
    const limit = frame.limit ?? HISTORY_SYNC_ROUND_LIMIT;
    await this.shareHistoryGap(frame.groupId, frame.requester, before, limit);
    // Piggyback the nickname master: newcomers otherwise miss every nick
    // set before they joined (updates only fan out to current members).
    // Unconditional — even an empty window carries it — and LWW merge makes
    // repeats harmless. Best effort: failure must not disturb the done
    // signal already sent above.
    try {
      await this.sendNickSnapshot(frame.groupId, frame.requester);
    } catch {
      // The next served round re-sends; live updates heal it meanwhile.
    }
  }

  /** Clear in-flight marks after a failure so the re-drive timer retries. */
  private unparkHistorySync(): void {
    const now = Date.now();
    for (const st of this.historySync.values()) {
      if (!st.done && st.inFlight) {
        st.inFlight = false;
        st.lastActivityAt = now;
      }
    }
  }

  /** Periodic tick: re-evaluate open gaps (stalled rounds retry on their own). */
  private redriveHistorySync(): void {
    try {
      this.maybeSyncGroups();
    } catch {
      // Best effort; the next tick retries.
    }
  }

  /**
   * Request one backfill round for a group. Completion arrives via
   * history_done. Absent `to` = automatic mode (server elects); a `to`
   * targets one member explicitly (fallback walk — same server path).
   * `before` overrides the window's upper bound (cursor walks); absent means
   * the requester's earliest row (outer window). `full` marks an interior
   * (leave-window) campaign: continuation advances by the sharer's floor
   * instead of earliest-tightening.
   */
  requestHistoryGap(groupId: string, to?: string, before?: number, full?: boolean): void {
    if (!this.online) return;
    const st = this.historySync.get(groupId) ?? {
      total: 0,
      done: false,
      inFlight: false,
      lastActivityAt: 0,
    };
    if (st.done || st.inFlight || st.total >= HISTORY_SYNC_MAX_TOTAL) return;
    st.inFlight = true;
    st.lastActivityAt = Date.now();
    st.target = to;
    const earliest = store.getGroupEarliestCreatedAt(groupId);
    const bound = before ?? earliest ?? Date.now();
    st.cursor = bound;
    st.full = full;
    this.historySync.set(groupId, st);
    const pending = getPendingHistorySync();
    pending.add(groupId);
    setPendingHistorySync(pending);
    socketBus.emit("history_sync_state", { groupId, waiting: true });
    this.sendFrame(requestHistoryRequest(groupId, to, bound, HISTORY_SYNC_ROUND_LIMIT));
  }

  /**
   * Request one round per group that may hold a gap. Runs after every
   * membership refresh (identify, invites, reconnects): fresh joins have
   * empty threads, established members converge pre-join gaps they never
   * fetched, and restarts simply re-resolve (dedup absorbs overlaps).
   * Completed groups stay quiet for the process lifetime.
   */
  private maybeSyncGroups(): void {
    if (!this.online) return;
    const me = store.getSessionUser()?.user_id;
    const now = Date.now();
    // Resume groups left pending by a previous process (restart mid-sync),
    // and drop entries for groups we no longer belong to (they can never
    // complete).
    const cachedIds = new Set(store.listGroupCache().map((g) => g.groupId));
    const pending = getPendingHistorySync();
    let pendingChanged = false;
    for (const id of [...pending]) {
      if (!cachedIds.has(id)) {
        pending.delete(id);
        pendingChanged = true;
      } else if (!this.historySync.has(id)) {
        this.historySync.set(id, { total: 0, done: false, inFlight: false, lastActivityAt: 0 });
      }
    }
    if (pendingChanged) setPendingHistorySync(pending);
    for (const g of store.listGroupCache()) {
      const st = this.historySync.get(g.groupId);
      if (st?.done) continue;
      if (st?.inFlight && now - st.lastActivityAt < HISTORY_SYNC_STALL_MS) continue;
      if (st && st.inFlight) {
        // Stale round (sharer went quiet): allow exactly one more attempt.
        // The next done or timeout re-arms from here.
        st.inFlight = false;
        st.lastActivityAt = now;
      }
      if ((st?.total ?? 0) >= HISTORY_SYNC_MAX_TOTAL) {
        this.historySync.set(g.groupId, {
          total: st?.total ?? 0,
          done: true,
          inFlight: false,
          lastActivityAt: now,
          tried: st?.tried,
          target: st?.target,
          cursor: st?.cursor,
          full: st?.full,
        });
        socketBus.emit("history_sync_state", { groupId: g.groupId, waiting: false });
        continue;
      }
      const members = store.getGroupMembers(g.groupId);
      const own = me ? members.find((m) => m.user_id === me) : undefined;
      if (!own) continue; // Not (or no longer) a member: nothing to sync.
      const oldest = members.reduce((m, x) => Math.min(m, x.joined_at), Infinity);
      if (own.joined_at <= oldest) {
        // Joined at genesis (creator/initials share one joinedAt): no older
        // messages can exist. Settle quietly — this also keeps group creation
        // itself from firing a pointless self-request.
        this.historySync.set(g.groupId, {
          total: st?.total ?? 0,
          done: true,
          inFlight: false,
          lastActivityAt: now,
          tried: st?.tried,
          target: st?.target,
          cursor: st?.cursor,
          full: st?.full,
        });
        socketBus.emit("history_sync_state", { groupId: g.groupId, waiting: false });
        continue;
      }
      // Resume an interior campaign where it stalled (same cursor, fresh
      // election — the previous target may be the one that went quiet).
      // Otherwise continue a fallback walk if we have tried sharers or a
      // targeted round in progress (prevents ghost re-election loops).
      // Otherwise start one for suspected rejoins, else the outer window.
      if (st?.full && st?.cursor !== undefined) {
        this.requestHistoryGap(g.groupId, undefined, st.cursor, true);
        continue;
      }
      if ((st?.tried && st.tried.length > 0) || st?.target) {
        const tried = st?.tried ?? [];
        const target = st?.target;
        const next = target && !tried.includes(target) ? target : this.nextUntriedSharer(g.groupId, tried);
        if (next) {
          this.requestHistoryGap(g.groupId, next, st?.cursor, st?.full);
          continue;
        }
        // Exhausted: fall through to outer logic (will settle on next done{0}).
      }
      const earliest = store.getGroupEarliestCreatedAt(g.groupId);
      if (earliest !== null && earliest < own.joined_at && !fullSyncDoneFor(g.groupId, own.joined_at)) {
        this.requestHistoryGap(g.groupId, undefined, Date.now() + 1, true);
        continue;
      }
      this.requestHistoryGap(g.groupId);
    }
  }

  private onHistoryDone(frame: HistoryDoneFrame): void {
    const now = Date.now();
    const st = this.historySync.get(frame.groupId) ?? {
      total: 0,
      done: false,
      inFlight: false,
      lastActivityAt: 0,
    };
    st.inFlight = false;
    st.lastActivityAt = now;
    st.total += frame.count;
    const tried = st.tried ?? [];
    if (frame.from && !tried.includes(frame.from)) tried.push(frame.from);
    st.tried = tried;
    if (frame.count > 0) {
      // Progress: the serving path works, so future stalls start the
      // fallback walk from scratch.
      st.tried = [];
      socketBus.emit("history_sync", { groupId: frame.groupId, count: frame.count });
      // Silent thread refresh: rows arrived read-marked, so no badges bump.
      socketBus.emit("chats_changed");
    }
    if (frame.count === HISTORY_SYNC_ROUND_LIMIT) {
      if (st.total >= HISTORY_SYNC_MAX_TOTAL) {
        // Process cap: coverage unknown (the floor may sit deeper), so
        // settle WITHOUT the marker — a reboot re-walks (dedup absorbs it).
        this.settleHistorySync(frame.groupId, st, false);
        return;
      }
      // Full batch: the gap runs deeper. A targeted round stays targeted:
      // the serving sharer just proved depth.
      if (st.full) {
        // Interior walk: advance by the sharer's floor, not the requester's
        // earliest (already-held rows would re-serve the same window
        // forever). +1 keeps same-millisecond rows inclusive: the window is
        // created_at < before, so before = floor would drop them.
        const floor = frame.floor ?? null;
        if (floor === null) {
          // Legacy sharer predates cursors: settle rather than loop the same
          // window. No marker — coverage is unknown, a reboot re-walks.
          this.settleHistorySync(frame.groupId, st, false);
          return;
        }
        st.cursor = floor + 1;
        this.historySync.set(frame.groupId, st);
        this.requestHistoryGap(frame.groupId, st.target, st.cursor, true);
        return;
      }
      // Outer walk: the next round re-reads the current earliest row, so the
      // window always tightens.
      this.historySync.set(frame.groupId, st);
      this.requestHistoryGap(frame.groupId, st.target);
    } else if (frame.count === 0) {
      // Floor claimed — but possibly by a ghost electee holding nothing.
      // Walk the tenure order past already-tried sharers before believing it.
      const next = this.nextUntriedSharer(frame.groupId, tried);
      if (next) {
        this.historySync.set(frame.groupId, st);
        this.requestHistoryGap(frame.groupId, next, st.cursor, st.full);
      } else {
        this.settleHistorySync(frame.groupId, st, true);
      }
    } else {
      this.settleHistorySync(frame.groupId, st, true);
    }
  }

  /** Oldest member (tenure order) that is neither us nor already tried. */
  private nextUntriedSharer(groupId: string, tried: string[]): string | undefined {
    const me = store.getSessionUser()?.user_id;
    for (const m of store.getGroupMembers(groupId)) {
      if (m.user_id !== me && !tried.includes(m.user_id)) return m.user_id;
    }
    return undefined;
  }

  /** Close a gap: mark done, drop the pending flag, clear any waiting UI.
   *  `markFull` records the interior-walk completion marker for the current
   *  membership, so reboots stay on cheap outer checks — set only when the
   *  walk actually reached a floor, never on cap settles or legacy cutoffs.
   *  Holders offline throughout are never consulted (same epistemic limit as
   *  `done` itself): the marker claims "walked all online holders". */
  private settleHistorySync(groupId: string, st: HistorySyncState, markFull: boolean): void {
    st.done = true;
    this.historySync.set(groupId, st);
    const pending = getPendingHistorySync();
    pending.delete(groupId);
    setPendingHistorySync(pending);
    if (markFull) {
      const me = store.getSessionUser()?.user_id;
      const own = me ? store.getGroupMembers(groupId).find((m) => m.user_id === me) : undefined;
      if (own) setFullSyncDone(groupId, own.joined_at);
    }
    socketBus.emit("history_sync_state", { groupId, waiting: false });
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

  leaveGroup(groupId: string, heir?: string): void {
    this.sendFrame(leaveGroupRequest(groupId, heir));
  }

  /**
   * Propose a nickname to the group's admin (any member may propose any
   * member's nick, own included — trust group). Delivered as an E2EE
   * machine frame inside a normal DM; the admin merges by LWW and pushes.
   * Throws when offline, keyless, or when no admin is known.
   */
  async proposeNick(groupId: string, target: string, nick: string | null): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    const admin = store.getGroupMembers(groupId).find((m) => m.role === "admin");
    if (!admin || admin.user_id === user.user_id) {
      throw new Error(admin ? "propose to others only" : "no admin known");
    }
    const keys = await this.requestKeys([admin.user_id]);
    const envelope = sealText(
      this.peerKeyOrThrow(admin.user_id, keys),
      user.user_id,
      admin.user_id,
      "",
      store.nickForContext(groupId, user.user_id),
      undefined,
      { kind: "nick-proposal", target, nick, updatedAt: Date.now() }
    );
    if (!this.sendFrame(sendRequest(admin.user_id, randomUUID(), envelope, groupId))) {
      throw new Error("offline");
    }
  }

  /**
   * Push a merged nickname to every current member (admin only). Mirrors the
   * group text fan-out: one shared payload, per-member seals.
   */
  async pushNickUpdate(
    groupId: string,
    target: string,
    nick: string | null,
    updatedAt: number
  ): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    if (!store.isGroupAdmin(groupId, user.user_id)) throw new Error("not the admin");
    let members = store.getGroupMembers(groupId).filter((m) => m.user_id !== user.user_id);
    if (members.length === 0) {
      await this.refreshGroups();
      members = store.getGroupMembers(groupId).filter((m) => m.user_id !== user.user_id);
    }
    if (members.length === 0) return;
    const keys = await this.requestKeys(members.map((m) => m.user_id));
    const envelopes = members.map((m) => ({
      to: m.user_id,
      ...sealText(this.peerKeyOrThrow(m.user_id, keys), user.user_id, m.user_id, "", "", undefined, {
        kind: "nick-update",
        target,
        nick,
        updatedAt,
      } satisfies NickPayload),
    }));
    if (!this.sendFrame(sendGroupRequest(groupId, randomUUID(), envelopes))) {
      throw new Error("offline");
    }
  }

  /**
   * Hand the full nickname master to the chosen heir (admin leaving).
   * Single DM; the heir merges row-by-row by LWW on receipt.
   */
  async sendNickSnapshot(groupId: string, toUserId: string): Promise<void> {
    const user = store.getSessionUser();
    if (!user) throw new Error("not registered");
    if (!this.online) throw new Error("offline");
    const keys = await this.requestKeys([toUserId]);
    const envelope = sealText(
      this.peerKeyOrThrow(toUserId, keys),
      user.user_id,
      toUserId,
      "",
      store.nickForContext(groupId, user.user_id),
      undefined,
      { kind: "nick-snapshot", nicks: store.getSharedNicks(groupId) }
    );
    if (!this.sendFrame(sendRequest(toUserId, randomUUID(), envelope, groupId))) {
      throw new Error("offline");
    }
  }

  /**
   * Apply one merged nickname row locally. Returns true when the stored
   * record changed (caller repaints).
   */
  private applySharedNick(
    groupId: string,
    target: string,
    nick: string | null,
    updatedAt: number
  ): boolean {
    const merged = store.mergeSharedNick(store.getSharedNick(groupId, target), {
      nick,
      updatedAt,
    });
    if (!merged) return false;
    const current = store.getSharedNick(groupId, target);
    if (current && current.nick === merged.nick && current.updatedAt === merged.updatedAt) {
      return false;
    }
    store.setSharedNick(groupId, target, merged.nick, merged.updatedAt);
    return true;
  }

  /**
   * Route a decrypted machine frame. Group-tagged per current-membership
   * rules on send; the receiver additionally requires the group to be known
   * (else ack-and-drop). Never files chat, badges, or receipts.
   */
  private async handleNickFrame(
    frame: IncomingFrame,
    kind: NickPayload
  ): Promise<void> {
    const user = store.getSessionUser();
    if (!user) return;
    if (kind.kind === "nick-proposal") {
      // Only the current admin merges proposals; anyone else ack-and-drops
      // (e.g. proposals overtaken by an admin change in flight).
      if (!frame.groupId || !store.isGroupAdmin(frame.groupId, user.user_id)) return;
      if (this.applySharedNick(frame.groupId, kind.target, kind.nick, kind.updatedAt)) {
        socketBus.emit("nicks_changed");
        socketBus.emit("chats_changed");
        try {
          await this.pushNickUpdate(frame.groupId, kind.target, kind.nick, kind.updatedAt);
        } catch {
          // Best effort: the next proposal or snapshot heals it.
        }
      }
      return;
    }
    if (kind.kind === "nick-update") {
      if (!frame.groupId) return;
      if (this.applySharedNick(frame.groupId, kind.target, kind.nick, kind.updatedAt)) {
        socketBus.emit("nicks_changed");
        socketBus.emit("chats_changed");
      }
      return;
    }
    // Snapshot: merge row-by-row by LWW; single repaint when anything moved.
    let moved = false;
    for (const row of kind.nicks) {
      if (!frame.groupId) break;
      if (this.applySharedNick(frame.groupId, row.userId, row.nick, row.updatedAt)) {
        moved = true;
      }
    }
    if (moved) {
      socketBus.emit("nicks_changed");
      socketBus.emit("chats_changed");
    }
  }

  renameGroup(groupId: string, name: string): void {
    this.sendFrame(renameGroupRequest(groupId, name));
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
    if (opened.ok && opened.kind) {
      // Machine frame (nickname control): route to the nick machinery, ack
      // for server cleanup, and never file chat, badges, or receipts.
      await this.handleNickFrame(frame, opened.kind);
      this.sendFrame(ackRequest(frame.messageId));
      return;
    }
    if (opened.ok && opened.fwd && frame.groupId) {
      // Backfilled history row: file silently with ORIGINAL attribution and
      // timestamp, then ack like any other row (the server must drop its
      // pending copy). No badges, no nick adoption, no receipts — the row
      // arrives already read so later thread opens stay quiet too.
      await this.fileBackfilledRow(frame.groupId, opened.fwd, opened.text);
      this.sendFrame(ackRequest(frame.messageId));
      return;
    }
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

  /**
   * File one backfilled row with its original sender, nick and timestamp.
   * Overlapping shares from several approvers dedupe on the stable original
   * message id. Rows for groups we no longer belong to are acked and dropped.
   */
  private async fileBackfilledRow(
    groupId: string,
    fwd: ForwardBlock,
    text: string
  ): Promise<void> {
    if (!store.getGroupCache(groupId)) {
      try {
        await this.refreshGroups();
      } catch {
        // Best effort; the next snapshot heals it.
      }
      if (!store.getGroupCache(groupId)) return;
    }
    if (!fwd.from || store.isGroupThreadKey(fwd.from)) {
      // Poisoned attribution from a pre-fix sharer (outbound rows filed with
      // the thread key as sender). Drop the row — the gap re-resolves on the
      // next round once sharers upgrade. The caller still acks.
      return;
    }
    const stored = store.insertIncomingMessage(
      fwd.from,
      fwd.id,
      text,
      fwd.sentAt,
      groupId,
      fwd.nick
    );
    if (stored.inserted) {
      store.markInboundMessageRead(fwd.id);
    }
    store.openChat(store.groupThreadKey(groupId));
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
