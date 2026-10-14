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
