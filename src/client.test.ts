import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// client transitively opens the DB (via store at import time), so pin an
// isolated dir before the dynamic import below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-client-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { resolveEndpoint, resolveTlsOptions, DEFAULT_HOST, DEFAULT_PORT, client } = await import("./client.js");
const { socketBus } = await import("./eventStore.js");
const store = await import("./store.js");
const { loadOrCreateIdentity, sealText, openEnvelope } = await import("./crypto.js");
describe("resolveEndpoint", () => {
  it("defaults to the staging relay", () => {
    expect(resolveEndpoint({})).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, fromDefault: true });
    expect(DEFAULT_HOST).toBe("nozomi.proxy.rlwy.net");
    expect(DEFAULT_PORT).toBe(15038);
  });

  it("prefers explicit env", () => {
    expect(resolveEndpoint({ HOST: "example.com", PORT: "1234" })).toEqual({
      host: "example.com",
      port: 1234,
      fromDefault: false,
    });
  });

  it("trims and falls back on blank host", () => {
    expect(resolveEndpoint({ HOST: "  " }).host).toBe(DEFAULT_HOST);
  });

  it("rejects bad ports like before", () => {
    expect(() => resolveEndpoint({ PORT: "abc" })).toThrow(/Invalid PORT/);
    expect(() => resolveEndpoint({ PORT: "0" })).toThrow(/Invalid PORT/);
    expect(() => resolveEndpoint({ PORT: "70000" })).toThrow(/Invalid PORT/);
  });
});

describe("resolveTlsOptions", () => {
  it("verifies against YAPR_CA_FILE", () => {
    const r = resolveTlsOptions({ YAPR_CA_FILE: "/ca.pem" }, () => "CERT");
    expect(r.verified).toBe(true);
    expect(r.source).toBe("ca-file");
    expect(r.options).toEqual({ ca: "CERT" });
  });

  it("is insecure by staging default", () => {
    const r = resolveTlsOptions({});
    expect(r.verified).toBe(false);
    expect(r.source).toBe("insecure-default");
    expect(r.options).toEqual({ rejectUnauthorized: false });
  });

  it("honors the explicit insecure flag", () => {
    const r = resolveTlsOptions({ YAPR_INSECURE: "1" });
    expect(r.verified).toBe(false);
    expect(r.source).toBe("insecure-explicit");
  });
});

describe("groupCreatedWaiter", () => {
  // Private-member backdoor: dispatch is side-effect free for these frames
  // (no sockets touched), so the waiter lifecycle is unit-testable.
  type Backdoor = {
    dispatch: (frame: { v: 2; type: string; [k: string]: unknown }) => void;
    groupCreatedWaiter: { resolve: (c: unknown) => void; reject: (e: Error) => void } | null;
  };
  const backdoor = () => client as unknown as Backdoor;

  it("rejects the pending create on error frames instead of hanging to timeout", () => {
    const b = backdoor();
    let rejected: Error | null = null;
    let resolved: unknown = null;
    b.groupCreatedWaiter = {
      resolve: (c) => { resolved = c; },
      reject: (e) => { rejected = e; },
    };
    let toasted: unknown = null;
    const onErr = (m: unknown) => { toasted = m; };
    socketBus.on("server_error", onErr);
    try {
      b.dispatch({ v: 2, type: "error", code: "RATE_LIMITED", message: "too many group operations" });
    } finally {
      socketBus.off("server_error", onErr);
    }
    expect(rejected).toMatchObject({ message: "RATE_LIMITED: too many group operations" });
    expect(resolved).toBeNull();
    expect(b.groupCreatedWaiter).toBeNull();
    expect(toasted).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("still resolves on group_created", () => {
    const b = backdoor();
    let resolved: unknown = null;
    b.groupCreatedWaiter = {
      resolve: (c) => { resolved = c; },
      reject: () => { throw new Error("must not reject"); },
    };
    b.dispatch({ v: 2, type: "group_created", groupId: "grp_1" });
    expect(resolved).toMatchObject({ groupId: "grp_1" });
    expect(b.groupCreatedWaiter).toBeNull();
  });

  it("emits server_error normally when no create is pending", () => {
    const b = backdoor();
    b.groupCreatedWaiter = null;
    let toasted: unknown = null;
    const onErr = (m: unknown) => { toasted = m; };
    socketBus.on("server_error", onErr);
    try {
      b.dispatch({ v: 2, type: "error", code: "NOT_FOUND", message: "member not found" });
    } finally {
      socketBus.off("server_error", onErr);
    }
    expect(toasted).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("connection_notice", () => {
  type Backdoor = {
    stopped: boolean;
    reconnectAttempt: number;
    reconnectTimer: unknown;
    scheduleReconnect: (reason: string) => void;
  };
  const backdoor = () => client as unknown as Backdoor;

  it("emits attempt/reason/delay on every scheduled reconnect", () => {
    const b = backdoor();
    const prev = { stopped: b.stopped, attempt: b.reconnectAttempt, timer: b.reconnectTimer };
    const notices: unknown[] = [];
    const onNotice = (m: unknown) => { notices.push(m); };
    socketBus.on("connection_notice", onNotice);
    try {
      b.stopped = false;
      b.reconnectAttempt = 0;
      b.scheduleReconnect("connection closed");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ attempt: 1, reason: "connection closed" });
      expect((notices[0] as { delayMs: number }).delayMs).toBeGreaterThan(0);
      // A pending retry suppresses duplicates (single timer by design).
      b.scheduleReconnect("connection closed");
      expect(notices).toHaveLength(1);
    } finally {
      socketBus.off("connection_notice", onNotice);
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer as ReturnType<typeof setTimeout>);
      b.stopped = prev.stopped;
      b.reconnectAttempt = prev.attempt;
      b.reconnectTimer = prev.timer;
    }
  });
});

describe("history auto-loop", () => {
  type SyncState = { total: number; done: boolean; inFlight: boolean; lastActivityAt: number };
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
    historySync: Map<string, SyncState>;
  };
  const backdoor = () => client as unknown as Backdoor;
  // The loop gates on transport state and raw socket writes; both are
  // stubbed so the tests never touch the network.
  const withOnlineStubbedSender = (fn: (sent: unknown[]) => void) => {
    const c = client as unknown as { state: string; sendFrame: (o: object) => boolean };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    try {
      fn(sent);
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
    }
  };

  it("prompts the next round on a full batch and tightens the window", () => {
    const b = backdoor();
    b.historySync.set("g-loop", { total: 20, done: false, inFlight: true, lastActivityAt: Date.now() });
    withOnlineStubbedSender((sent) => {
      b.dispatch({ v: 2, type: "history_done", groupId: "g-loop", count: 20, from: "u" });
      const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ groupId: "g-loop" });
    });
    const st = b.historySync.get("g-loop");
    expect(st).toMatchObject({ total: 40, done: false, inFlight: true });
    b.historySync.delete("g-loop");
  });

  it("stops on a partial batch and toasts the landed count", () => {
    const b = backdoor();
    b.historySync.set("g-stop", { total: 20, done: false, inFlight: true, lastActivityAt: Date.now() });
    let toasted: unknown = null;
    const onSync = (m: unknown) => { toasted = m; };
    socketBus.on("history_sync", onSync);
    try {
      withOnlineStubbedSender((sent) => {
        b.dispatch({ v: 2, type: "history_done", groupId: "g-stop", count: 5, from: "u" });
        expect(sent.filter((f) => (f as { type?: string }).type === "request_history")).toHaveLength(0);
      });
    } finally {
      socketBus.off("history_sync", onSync);
    }
    expect(toasted).toMatchObject({ groupId: "g-stop", count: 5 });
    expect(b.historySync.get("g-stop")).toMatchObject({ total: 25, done: true });
    b.historySync.delete("g-stop");
  });

  it("stops at the process cap even on full batches", () => {
    const b = backdoor();
    b.historySync.set("g-cap", { total: 100, done: false, inFlight: true, lastActivityAt: Date.now() });
    withOnlineStubbedSender((sent) => {
      b.dispatch({ v: 2, type: "history_done", groupId: "g-cap", count: 20, from: "u" });
      expect(sent.filter((f) => (f as { type?: string }).type === "request_history")).toHaveLength(0);
    });
    expect(b.historySync.get("g-cap")).toMatchObject({ done: true });
    b.historySync.delete("g-cap");
  });
});

describe("groupsWaiter fan-out", () => {
  type Entry = {
    resolve: (g: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
    groupsWaiters: Set<Entry>;
    refreshGroups: () => Promise<void>;
  };
  const backdoor = () => client as unknown as Backdoor;
  const entry = (fns: { resolve: (g: unknown) => void; reject: (e: Error) => void }) => ({
    ...fns,
    timer: setTimeout(() => {}, 60000),
  });
  const clearAll = (b: Backdoor) => {
    for (const w of b.groupsWaiters) clearTimeout(w.timer);
    b.groupsWaiters.clear();
  };

  it("resolves every pending refresh with one snapshot, then drops late duplicates", () => {
    const b = backdoor();
    const got: unknown[] = [];
    const errs: Error[] = [];
    b.groupsWaiters.add(entry({ resolve: (g) => { got.push(["a", g]); }, reject: (e) => { errs.push(e); } }));
    b.groupsWaiters.add(entry({ resolve: (g) => { got.push(["b", g]); }, reject: (e) => { errs.push(e); } }));
    try {
      b.dispatch({ v: 2, type: "groups", groups: [] });
      expect(got).toHaveLength(2);
      expect(errs).toHaveLength(0);
      expect(b.groupsWaiters.size).toBe(0);
      // Late duplicate answer: nobody pending, nothing happens, no crash.
      b.dispatch({ v: 2, type: "groups", groups: [] });
      expect(got).toHaveLength(2);
    } finally {
      clearAll(b);
    }
  });

  it("times out each waiter independently (no cross-talk)", async () => {
    vi.useFakeTimers();
    const b = backdoor();
    const c = client as unknown as { state: string; sendFrame: (o: object) => boolean };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    c.state = "online";
    c.sendFrame = () => true;
    try {
      const p1 = b.refreshGroups().then(
        () => "resolved",
        (e: Error) => `rejected:${e.message}`
      );
      const p2 = b.refreshGroups().then(
        () => "resolved",
        (e: Error) => `rejected:${e.message}`
      );
      expect(b.groupsWaiters.size).toBe(2);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await p1).toBe("rejected:groups lookup timed out");
      expect(await p2).toBe("rejected:groups lookup timed out");
      expect(b.groupsWaiters.size).toBe(0);
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
      clearAll(b);
      vi.useRealTimers();
    }
  });
});

describe("nick machine frames", () => {
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
  };
  const backdoor = () => client as unknown as Backdoor;
  const SENDER_DIR = path.join(os.tmpdir(), `yapr-nick-sender-${process.pid}-${Date.now()}`);
  fs.rmSync(SENDER_DIR, { recursive: true, force: true });

  it("files nick updates silently with no unread bump or chat fanfare", async () => {
    const me = `me-nick-${Date.now()}`;
    const sender = `sender-nick-${Date.now()}`;
    const target = `target-nick-${Date.now()}`;
    const gid = `g-nick-${Date.now()}`;
    // Receiver identity + session in the isolated test dir.
    const mePub = loadOrCreateIdentity().publicKeyB64;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    // Sender identity in its own dir; seal there so the sender private key
    // is the one used (mirrors two devices).
    process.env.YAPR_DATA_DIR = SENDER_DIR;
    const senderPub = loadOrCreateIdentity().publicKeyB64;
    const env = sealText(mePub, sender, me, "", "", undefined, {
      kind: "nick-update",
      target,
      nick: "Bobo",
      updatedAt: 1700000000000,
    });
    process.env.YAPR_DATA_DIR = TEST_DIR;
    // Pre-seed the sender key so no network lookup is needed.
    store.setPeerKey(sender, senderPub);

    const incoming: string[] = [];
    let syncs = 0;
    const onIncoming = (m: unknown) => { incoming.push(m as string); };
    const onSync = () => { syncs += 1; };
    socketBus.on("incoming_message", onIncoming);
    socketBus.on("history_sync", onSync);
    socketBus.on("nicks_changed", onSync);
    try {
      backdoor().dispatch({
        v: 2,
        type: "incoming",
        from: sender,
        messageId: "m-nick-1",
        ciphertext: env.ciphertext,
        nonce: env.nonce,
        timestamp: 1700000000001,
        groupId: gid,
      });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      socketBus.off("incoming_message", onIncoming);
      socketBus.off("history_sync", onSync);
      socketBus.off("nicks_changed", onSync);
    }
    expect(store.getSharedNick(gid, target)).toEqual({ nick: "Bobo", updatedAt: 1700000000000 });
    expect(incoming).toHaveLength(0);
    expect(store.getUnreadCounts()[sender] ?? 0).toBe(0);
    expect(syncs).toBeGreaterThan(0);
  });
});

describe("poisoned history migration", () => {
  type Backdoor = {
    migratePoisonedHistoryOnce: () => void;
    poisonMigrated: boolean;
  };
  const backdoor = () => client as unknown as Backdoor;

  it("wipes thread-key rows once and re-queues their groups", () => {
    const g = `mig-${Date.now()}`;
    store.insertIncomingMessage(`g:${g}`, `mig-bad-${Date.now()}`, "poisoned", 1000, g);
    store.insertIncomingMessage(`good-${Date.now()}`, `mig-ok-${Date.now()}`, "fine", 2000, g, "G");
    const b = backdoor();
    b.poisonMigrated = false;
    b.migratePoisonedHistoryOnce();
    // Poisoned row gone, legit row kept.
    expect(store.getUnreadCounts()[`g:${g}`] ?? 0).toBe(0);
    // Group re-queued for backfill.
    expect(JSON.parse(store.getSetting("history_sync_pending"))).toContain(g);
    // Second run is a no-op (flag set, nothing left).
    b.migratePoisonedHistoryOnce();
    expect(JSON.parse(store.getSetting("history_sync_pending"))).toContain(g);
    b.poisonMigrated = false;
  });
});

describe("history fallback walk", () => {
  type SyncState = {
    total: number;
    done: boolean;
    inFlight: boolean;
    lastActivityAt: number;
    tried?: string[];
    target?: string;
  };
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
    historySync: Map<string, SyncState>;
  };
  const backdoor = () => client as unknown as Backdoor;
  const withOnlineStubbedSender = (fn: (sent: unknown[]) => void) => {
    const c = client as unknown as { state: string; sendFrame: (o: object) => boolean };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    try {
      fn(sent);
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
    }
  };

  it("walks past a ghost electee to the next-oldest member, then settles on exhaustion", () => {
    const tag = Date.now();
    const me = `req-fb-${tag}`;
    const ghost = `ghost-fb-${tag}`;
    const mid = `mid-fb-${tag}`;
    const gid = `g-fb-${tag}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    store.upsertGroupCache(gid, "FB", [
      { user_id: ghost, role: "member", joined_at: 1000 },
      { user_id: mid, role: "member", joined_at: 2000 },
      { user_id: me, role: "member", joined_at: 3000 },
    ]);
    const b = backdoor();
    b.historySync.set(gid, { total: 0, done: false, inFlight: true, lastActivityAt: Date.now() });
    try {
      // Ghost electee claims the floor: targeted re-request at next-oldest.
      withOnlineStubbedSender((sent) => {
        b.dispatch({ v: 2, type: "history_done", groupId: gid, count: 0, from: ghost });
        const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
        expect(reqs).toHaveLength(1);
        expect(reqs[0]).toMatchObject({ groupId: gid, to: mid });
      });
      expect(b.historySync.get(gid)).toMatchObject({
        done: false,
        inFlight: true,
        target: mid,
        tried: [ghost],
      });
      // Second member also empty and nobody untried remains: settle quietly.
      withOnlineStubbedSender((sent) => {
        b.dispatch({ v: 2, type: "history_done", groupId: gid, count: 0, from: mid });
        expect(sent.filter((f) => (f as { type?: string }).type === "request_history")).toHaveLength(0);
      });
      const st = b.historySync.get(gid);
      expect(st).toMatchObject({ done: true, inFlight: false });
      expect(st?.tried ?? []).toEqual(expect.arrayContaining([ghost, mid]));
      expect(JSON.parse(store.getSetting("history_sync_pending"))).not.toContain(gid);
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
    }
  });

  it("resets the tried walk when a sharer actually delivers", () => {
    const tag = `r${Date.now()}`;
    const me = `req-rst-${tag}`;
    const a = `a-rst-${tag}`;
    const c = `c-rst-${tag}`;
    const gid = `g-rst-${tag}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    store.upsertGroupCache(gid, "RST", [
      { user_id: a, role: "member", joined_at: 1000 },
      { user_id: c, role: "member", joined_at: 2000 },
      { user_id: me, role: "member", joined_at: 3000 },
    ]);
    const b = backdoor();
    b.historySync.set(gid, {
      total: 0,
      done: false,
      inFlight: true,
      lastActivityAt: Date.now(),
      tried: [a],
      target: c,
    });
    try {
      withOnlineStubbedSender((sent) => {
        void sent;
        b.dispatch({ v: 2, type: "history_done", groupId: gid, count: 3, from: c });
      });
      expect(b.historySync.get(gid)).toMatchObject({ total: 3, done: true, tried: [] });
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
    }
  });
});

describe("history error unpark and redrive", () => {
  type SyncState = {
    total: number;
    done: boolean;
    inFlight: boolean;
    lastActivityAt: number;
    tried?: string[];
    target?: string;
  };
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
    historySync: Map<string, SyncState>;
    redriveHistorySync: () => void;
  };
  const backdoor = () => client as unknown as Backdoor;
  const withOnlineStubbedSender = (fn: (sent: unknown[]) => void) => {
    const c = client as unknown as { state: string; sendFrame: (o: object) => boolean };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    try {
      fn(sent);
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
    }
  };

  it("unparks open gaps on OFFLINE but keeps the error toast", () => {
    const b = backdoor();
    b.historySync.set("g-unpark", { total: 5, done: false, inFlight: true, lastActivityAt: Date.now() });
    let toasted: unknown = null;
    const onErr = (m: unknown) => { toasted = m; };
    socketBus.on("server_error", onErr);
    try {
      b.dispatch({ v: 2, type: "error", code: "OFFLINE", message: "no members online" });
    } finally {
      socketBus.off("server_error", onErr);
      b.historySync.delete("g-unpark");
    }
    expect(toasted).toMatchObject({ code: "OFFLINE" });
    // Entry removed above; re-check via a fresh plant that unpark clears
    // inFlight without touching done/total.
    b.historySync.set("g-unpark2", { total: 5, done: false, inFlight: true, lastActivityAt: 1 });
    try {
      b.dispatch({ v: 2, type: "error", code: "OFFLINE", message: "no members online" });
      expect(b.historySync.get("g-unpark2")).toMatchObject({ total: 5, done: false, inFlight: false });
    } finally {
      b.historySync.delete("g-unpark2");
    }
  });

  it("redrives stalled gaps on tick while fresh and done gaps stay quiet", () => {
    const tag = Date.now();
    const me = `req-rd-${tag}`;
    const old = `old-rd-${tag}`;
    const gid = `g-rd-${tag}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    store.upsertGroupCache(gid, "RD", [
      { user_id: old, role: "member", joined_at: 1000 },
      { user_id: me, role: "member", joined_at: 2000 },
    ]);
    const b = backdoor();
    try {
      // Fresh in-flight round: the tick leaves it alone.
      b.historySync.set(gid, { total: 0, done: false, inFlight: true, lastActivityAt: Date.now() });
      withOnlineStubbedSender((sent) => {
        b.redriveHistorySync();
        expect(sent.filter((f) => (f as { type?: string }).type === "request_history")).toHaveLength(0);
      });
      // Stale in-flight round: the tick re-arms and re-requests.
      b.historySync.set(gid, { total: 0, done: false, inFlight: true, lastActivityAt: Date.now() - 61_000 });
      withOnlineStubbedSender((sent) => {
        b.redriveHistorySync();
        const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
        expect(reqs).toHaveLength(1);
        expect(reqs[0]).toMatchObject({ groupId: gid });
      });
      expect(b.historySync.get(gid)).toMatchObject({ inFlight: true, done: false });
      // Settled gap: quiet forever.
      b.historySync.set(gid, { total: 2, done: true, inFlight: false, lastActivityAt: Date.now() });
      withOnlineStubbedSender((sent) => {
        b.redriveHistorySync();
        expect(sent.filter((f) => (f as { type?: string }).type === "request_history")).toHaveLength(0);
      });
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
    }
  });
});

describe("history share piggybacks nick snapshot", () => {
  type Backdoor = {
    autoShareHistory: (f: { v: 2; type: string; [k: string]: unknown }) => Promise<void>;
  };
  const backdoor = () => client as unknown as Backdoor;
  const RECIP_DIR = path.join(os.tmpdir(), `yapr-snap-recip-${process.pid}-${Date.now()}`);
  fs.rmSync(RECIP_DIR, { recursive: true, force: true });

  it("sends rows, done, and a mergeable nick-snapshot to the requester", async () => {
    const tag = Date.now();
    const sharer = `sharer-snap-${tag}`;
    const recip = `recip-snap-${tag}`;
    const target = `nicktarget-snap-${tag}`;
    const gid = `g-snap-${tag}`;
    // Sharer identity + session in the isolated test dir.
    const sharerPub = loadOrCreateIdentity().publicKeyB64;
    store.clearSession();
    store.saveSessionUser(sharer, "s3cret");
    // Recipient identity in its own dir (mirrors two devices).
    process.env.YAPR_DATA_DIR = RECIP_DIR;
    const recipPub = loadOrCreateIdentity().publicKeyB64;
    process.env.YAPR_DATA_DIR = TEST_DIR;
    // One shareable row + one master nick row on the sharer.
    store.insertIncomingMessage(`other-snap-${tag}`, `snap-row-${tag}`, "old hello", 1000, gid);
    store.setSharedNick(gid, target, "Phone", 1700000000000);

    const c = client as unknown as {
      state: string;
      sendFrame: (o: object) => boolean;
      requestKeys: (ids: string[]) => Promise<Record<string, string>>;
    };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const prevKeys = c.requestKeys.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    c.requestKeys = async () => ({ [recip]: recipPub });
    try {
      await backdoor().autoShareHistory({
        v: 2,
        type: "history_request",
        groupId: gid,
        requester: recip,
        before: 9999,
        limit: 20,
      });
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
      c.requestKeys = prevKeys;
    }
    // Done reports the served row.
    const dones = sent.filter((f) => (f as { type?: string }).type === "share_history_done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ groupId: gid, to: recip, count: 1 });
    // Two DMs to the requester: the history row + the snapshot.
    const sends = sent.filter(
      (f) => (f as { type?: string }).type === "send" && (f as { to?: string }).to === recip
    );
    expect(sends).toHaveLength(2);
    // The snapshot opens as a nick-snapshot carrying the master row.
    process.env.YAPR_DATA_DIR = RECIP_DIR;
    try {
      const kinds = sends.map((f) => {
        const frame = f as { ciphertext: string; nonce: string };
        return openEnvelope(sharerPub, recip, sharer, {
          ciphertext: frame.ciphertext,
          nonce: frame.nonce,
        });
      });
      const snaps = kinds.filter((k) => k.ok && k.kind && k.kind.kind === "nick-snapshot");
      expect(snaps).toHaveLength(1);
      const snap = snaps[0];
      if (!snap || !snap.ok || !snap.kind || snap.kind.kind !== "nick-snapshot") {
        throw new Error("snapshot frame did not parse as nick-snapshot");
      }
      expect(snap.kind.nicks).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: target, nick: "Phone" })])
      );
    } finally {
      process.env.YAPR_DATA_DIR = TEST_DIR;
    }
  });
});

describe("history floor cursor", () => {
  type SyncState = {
    total: number;
    done: boolean;
    inFlight: boolean;
    lastActivityAt: number;
    tried?: string[];
    target?: string;
    cursor?: number;
    full?: boolean;
  };
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
    historySync: Map<string, SyncState>;
    shareHistoryGap: (
      groupId: string,
      toUserId: string,
      before: number,
      limit: number
    ) => Promise<{ count: number; floor: number | null }>;
  };
  const backdoor = () => client as unknown as Backdoor;
  const withOnlineStubbedSender = (fn: (sent: unknown[]) => void) => {
    const c = client as unknown as { state: string; sendFrame: (o: object) => boolean };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    try {
      fn(sent);
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
    }
  };

  it("reports the oldest served timestamp as floor, null when nothing served", async () => {
    const tag = Date.now();
    const sharer = `sharer-fl-${tag}`;
    const recip = `recip-fl-${tag}`;
    const gid = `g-fl-${tag}`;
    const recipPub = loadOrCreateIdentity().publicKeyB64;
    store.clearSession();
    store.saveSessionUser(sharer, "s3cret");
    store.insertIncomingMessage(`o-fl-${tag}`, `fl-1-${tag}`, "one", 1000, gid);
    store.insertIncomingMessage(`o-fl-${tag}`, `fl-2-${tag}`, "two", 2000, gid);
    store.insertIncomingMessage(`o-fl-${tag}`, `fl-3-${tag}`, "three", 3000, gid);
    const c = client as unknown as {
      state: string;
      sendFrame: (o: object) => boolean;
      requestKeys: (ids: string[]) => Promise<Record<string, string>>;
    };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const prevKeys = c.requestKeys.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    c.requestKeys = async () => ({ [recip]: recipPub });
    try {
      const full = await backdoor().shareHistoryGap(gid, recip, 9999, 20);
      expect(full).toEqual({ count: 3, floor: 1000 });
      const empty = await backdoor().shareHistoryGap(gid, recip, 500, 20);
      expect(empty).toEqual({ count: 0, floor: null });
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
      c.requestKeys = prevKeys;
    }
    const dones = sent.filter((f) => (f as { type?: string }).type === "share_history_done");
    expect(dones).toHaveLength(2);
    expect(dones[0]).toMatchObject({ groupId: gid, to: recip, count: 3, floor: 1000 });
    expect(dones[1]).toMatchObject({ groupId: gid, to: recip, count: 0 });
    // Empty windows omit the cursor entirely (legacy-compatible).
    expect("floor" in (dones[1] as object)).toBe(false);
  });

  it("continues full walks from the sharer floor, not the local earliest", () => {
    const tag = Date.now();
    const gid = `g-flc-${tag}`;
    store.insertIncomingMessage(`o-flc-${tag}`, `flc-old-${tag}`, "ancient", 100, gid);
    const b = backdoor();
    b.historySync.set(gid, {
      total: 20,
      done: false,
      inFlight: true,
      lastActivityAt: Date.now(),
      cursor: 9000,
      full: true,
    });
    try {
      withOnlineStubbedSender((sent) => {
        b.dispatch({ v: 2, type: "history_done", groupId: gid, count: 20, from: "u", floor: 5000 });
        const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
        expect(reqs).toHaveLength(1);
        // +1 keeps same-millisecond rows inclusive (window is created_at < before).
        expect(reqs[0]).toMatchObject({ groupId: gid, before: 5001 });
      });
      expect(b.historySync.get(gid)).toMatchObject({
        total: 40,
        done: false,
        inFlight: true,
        cursor: 5001,
        full: true,
      });
    } finally {
      b.historySync.delete(gid);
    }
  });

  it("settles a full walk without marker when the sharer predates cursors", () => {
    const tag = Date.now();
    const gid = `g-flnc-${tag}`;
    const b = backdoor();
    b.historySync.set(gid, {
      total: 20,
      done: false,
      inFlight: true,
      lastActivityAt: Date.now(),
      cursor: 9000,
      full: true,
    });
    try {
      withOnlineStubbedSender((sent) => {
        // Legacy done: full batch, no floor — must not loop the same window.
        b.dispatch({ v: 2, type: "history_done", groupId: gid, count: 20, from: "u" });
        expect(sent.filter((f) => (f as { type?: string }).type === "request_history")).toHaveLength(0);
      });
      expect(b.historySync.get(gid)).toMatchObject({ done: true });
      expect(JSON.parse(store.getSetting("history_full_sync"))[gid]).toBeUndefined();
    } finally {
      b.historySync.delete(gid);
    }
  });
});

describe("history rejoin detection", () => {
  type SyncState = {
    total: number;
    done: boolean;
    inFlight: boolean;
    lastActivityAt: number;
    tried?: string[];
    target?: string;
    cursor?: number;
    full?: boolean;
  };
  type Backdoor = {
    dispatch: (f: { v: 2; type: string; [k: string]: unknown }) => void;
    historySync: Map<string, SyncState>;
    redriveHistorySync: () => void;
  };
  const backdoor = () => client as unknown as Backdoor;
  const withOnlineStubbedSender = (fn: (sent: unknown[]) => void) => {
    const c = client as unknown as { state: string; sendFrame: (o: object) => boolean };
    const prevState = c.state;
    const prevSend = c.sendFrame.bind(client);
    const sent: unknown[] = [];
    c.state = "online";
    c.sendFrame = (o: object) => { sent.push(o); return true; };
    try {
      fn(sent);
    } finally {
      c.state = prevState;
      c.sendFrame = prevSend;
    }
  };
  const seedRejoiner = (tag: string) => {
    const me = `req-rj-${tag}`;
    const old = `old-rj-${tag}`;
    const gid = `g-rj-${tag}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    store.upsertGroupCache(gid, "RJ", [
      { user_id: old, role: "member", joined_at: 1000 },
      { user_id: me, role: "member", joined_at: 3000 },
    ]);
    // Pre-leave first message + a post-rejoin one: the hole is between them.
    store.insertIncomingMessage(old, `rj-first-${tag}`, "first", 2000, gid);
    store.insertIncomingMessage(old, `rj-latest-${tag}`, "latest", 4000, gid);
    return { me, gid };
  };

  it("walks newest-first with a cursor when rows predate the membership", () => {
    const tag = `${Date.now()}`;
    const { gid } = seedRejoiner(tag);
    const b = backdoor();
    try {
      withOnlineStubbedSender((sent) => {
        b.redriveHistorySync();
        const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
        expect(reqs).toHaveLength(1);
        // Newest-first, not earliest-tightened: the hole sits above earliest.
        expect((reqs[0] as { before: number }).before).toBeGreaterThan(4000);
        expect(reqs[0]).toMatchObject({ groupId: gid });
      });
      expect(b.historySync.get(gid)).toMatchObject({ full: true, done: false, inFlight: true });
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
    }
  });

  it("stays on cheap outer checks once the marker matches the membership", () => {
    const tag = `m${Date.now()}`;
    const { gid } = seedRejoiner(tag);
    store.setSetting("history_full_sync", JSON.stringify({ [gid]: 3000 }));
    const b = backdoor();
    try {
      withOnlineStubbedSender((sent) => {
        b.redriveHistorySync();
        const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
        expect(reqs).toHaveLength(1);
        // Outer window: rows older than the local earliest only.
        expect(reqs[0]).toMatchObject({ groupId: gid, before: 2000 });
      });
      expect(b.historySync.get(gid)?.full).toBeFalsy();
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
      const markers = JSON.parse(store.getSetting("history_full_sync"));
      delete markers[gid];
      store.setSetting("history_full_sync", JSON.stringify(markers));
    }
  });

  it("records the marker on floor settles but never on cap settles", () => {
    const tag = `s${Date.now()}`;
    const me = `req-mk-${tag}`;
    const old = `old-mk-${tag}`;
    const gid = `g-mk-${tag}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    store.upsertGroupCache(gid, "MK", [
      { user_id: old, role: "member", joined_at: 1000 },
      { user_id: me, role: "member", joined_at: 3000 },
    ]);
    const b = backdoor();
    try {
      // Partial batch = floor reached: marker records this membership.
      b.historySync.set(gid, { total: 3, done: false, inFlight: true, lastActivityAt: Date.now() });
      b.dispatch({ v: 2, type: "history_done", groupId: gid, count: 3, from: old });
      expect(b.historySync.get(gid)).toMatchObject({ done: true });
      expect(JSON.parse(store.getSetting("history_full_sync"))[gid]).toBe(3000);
      // Cap settle = coverage unknown: done, but no marker (reboot re-walks).
      const gid2 = `g-mk2-${tag}`;
      store.upsertGroupCache(gid2, "MK2", [
        { user_id: old, role: "member", joined_at: 1000 },
        { user_id: me, role: "member", joined_at: 3000 },
      ]);
      b.historySync.set(gid2, { total: 100, done: false, inFlight: true, lastActivityAt: Date.now() });
      withOnlineStubbedSender((sent) => {
        void sent;
        b.dispatch({ v: 2, type: "history_done", groupId: gid2, count: 20, from: old });
      });
      expect(b.historySync.get(gid2)).toMatchObject({ done: true });
      expect(JSON.parse(store.getSetting("history_full_sync"))[gid2]).toBeUndefined();
      b.historySync.delete(gid2);
      store.dropGroupCache(gid2);
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
      const markers = JSON.parse(store.getSetting("history_full_sync"));
      delete markers[gid];
      store.setSetting("history_full_sync", JSON.stringify(markers));
    }
  });

  it("resumes a stalled interior campaign at its cursor with a fresh election", () => {
    const tag = `c${Date.now()}`;
    const me = `req-rs-${tag}`;
    const old = `old-rs-${tag}`;
    const gid = `g-rs-${tag}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    store.upsertGroupCache(gid, "RS", [
      { user_id: old, role: "member", joined_at: 1000 },
      { user_id: me, role: "member", joined_at: 3000 },
    ]);
    store.insertIncomingMessage(old, `rs-first-${tag}`, "first", 2000, gid);
    const b = backdoor();
    // Stalled mid-walk with a dead target: the tick re-elects instead of
    // retrying the ghost, keeping the cursor (not restarting from now).
    b.historySync.set(gid, {
      total: 20,
      done: false,
      inFlight: true,
      lastActivityAt: Date.now() - 61_000,
      cursor: 5000,
      full: true,
      target: `ghost-rs-${tag}`,
      tried: [`ghost-rs-${tag}`],
    });
    try {
      withOnlineStubbedSender((sent) => {
        b.redriveHistorySync();
        const reqs = sent.filter((f) => (f as { type?: string }).type === "request_history");
        expect(reqs).toHaveLength(1);
        expect(reqs[0]).toMatchObject({ groupId: gid, before: 5000 });
        expect((reqs[0] as { to?: string }).to).toBeUndefined();
      });
      expect(b.historySync.get(gid)).toMatchObject({ full: true, cursor: 5000, done: false });
    } finally {
      b.historySync.delete(gid);
      store.dropGroupCache(gid);
    }
  });
});
