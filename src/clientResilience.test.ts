import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// client opens the DB at import time: pin an isolated dir first.
const TEST_DIR = path.join(os.tmpdir(), `yapr-resilience-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { client } = await import("./client.js");
const { socketBus } = await import("./eventStore.js");
const store = await import("./store.js");
const { loadOrCreateIdentity, sealText } = await import("./crypto.js");

type Frame = { v: 2; type: string; [k: string]: unknown };
type Internals = {
  state: string;
  identified: boolean;
  kicked: boolean;
  socket: unknown;
  reconnectTimer: NodeJS.Timeout | null;
  staleKeysReplies: number;
  sendFrame: (o: object) => boolean;
  dispatch: (f: Frame) => void;
  onClose: (s: unknown) => void;
  flushOutbox: () => Promise<void>;
};
const c = client as unknown as Internals;
const realSendFrame = c.sendFrame.bind(client);

/** Online + identified with a capturing sender. `onSend` may answer frames. */
function goOnline(onSend?: (f: Frame) => void): Frame[] {
  const sent: Frame[] = [];
  c.state = "online";
  c.identified = true;
  c.sendFrame = (o: object) => {
    sent.push(o as Frame);
    onSend?.(o as Frame);
    return true;
  };
  return sent;
}

afterEach(() => {
  c.state = "offline";
  c.identified = false;
  c.kicked = false;
  c.socket = null;
  c.staleKeysReplies = 0;
  c.sendFrame = realSendFrame;
  vi.useRealTimers();
});

const settle = () => new Promise((r) => setTimeout(r, 50));
const ofType = (sent: Frame[], type: string) => sent.filter((f) => f.type === type);
const legacy = (text: string) => ({ ciphertext: Buffer.from(text, "utf8").toString("base64"), nonce: "" });

describe("offline inbox paging", () => {
  it("pulls the next page from the last row's cursor when hasMore", async () => {
    const sent = goOnline();
    c.dispatch({ v: 2, type: "incoming", from: "pager", messageId: "p-1", timestamp: 100, ...legacy("a") });
    c.dispatch({ v: 2, type: "incoming", from: "pager", messageId: "p-2", timestamp: 200, ...legacy("b") });
    c.dispatch({ v: 2, type: "pending_done", hasMore: true });
    await settle();
    expect(ofType(sent, "fetch_pending")).toEqual([
      { v: 2, type: "fetch_pending", cursor: { createdAt: 200, messageId: "p-2" } },
    ]);
  });

  it("stops when the server reports no more pages", () => {
    const sent = goOnline();
    c.dispatch({ v: 2, type: "pending_done", hasMore: false });
    expect(ofType(sent, "fetch_pending")).toHaveLength(0);
  });
});

describe("outbox flush", () => {
  it("skips an undeliverable row instead of stranding everything after it", async () => {
    store.clearSession();
    store.saveSessionUser(`me-flush-${Date.now()}`, "s3cret");
    const pub = loadOrCreateIdentity().publicKeyB64;
    const good = `good-${Date.now()}`;
    store.setPeerKey(good, pub);
    // Older row first: a mistyped id the server has no key for.
    store.insertPendingMessage(`typo-${Date.now()}`, "lost cause");
    store.insertPendingMessage(good, "should still go");
    const sent = goOnline((f) => {
      if (f.type === "fetch_keys") queueMicrotask(() => c.dispatch({ v: 2, type: "keys", keys: {} }));
    });
    await c.flushOutbox();
    expect(ofType(sent, "send").map((f) => f.to)).toEqual([good]);
  });
});

describe("signed in elsewhere", () => {
  it("stays offline instead of reconnecting and kicking the other device", () => {
    goOnline();
    let kicked = 0;
    const onKick = () => { kicked += 1; };
    socketBus.on("session_kicked", onKick);
    const sock = {};
    c.socket = sock;
    try {
      c.dispatch({ v: 2, type: "error", code: "UNAUTH", message: "signed in from another device" });
      c.onClose(sock);
    } finally {
      socketBus.off("session_kicked", onKick);
    }
    expect(kicked).toBe(1);
    expect(c.reconnectTimer).toBeNull();
    expect(c.state).toBe("offline");
  });
});

describe("key lookups", () => {
  it("drops a late reply to a timed-out request instead of answering the next one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    goOnline();
    const first = client.requestKeys([`late-a-${Date.now()}`]).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await first).toBe("keys lookup timed out");
    const idB = `late-b-${Date.now()}`;
    const second = client.requestKeys([idB]);
    await vi.advanceTimersByTimeAsync(0);
    c.dispatch({ v: 2, type: "keys", keys: { "late-a": "STALE" } }); // first's late reply
    c.dispatch({ v: 2, type: "keys", keys: { [idB]: "KEY-B" } });
    expect(await second).toEqual({ [idB]: "KEY-B" });
  });

  it("fails fast on a key rate limit instead of hanging to timeout", async () => {
    goOnline((f) => {
      if (f.type === "fetch_keys") {
        queueMicrotask(() =>
          c.dispatch({ v: 2, type: "error", code: "RATE_LIMITED", message: "too many key lookups" })
        );
      }
    });
    await expect(client.requestKeys([`rl-${Date.now()}`])).rejects.toThrow("rate-limited");
    expect(c.staleKeysReplies).toBe(0);
  });
});

describe("incoming without a usable key", () => {
  const OTHER_DIR = path.join(os.tmpdir(), `yapr-resilience-peer-${process.pid}-${Date.now()}`);
  const STRANGER_DIR = path.join(os.tmpdir(), `yapr-resilience-stranger-${process.pid}-${Date.now()}`);

  it("leaves the message unacked on a transient key failure (redelivered later)", async () => {
    const me = `me-tr-${Date.now()}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = goOnline(); // fetch_keys goes unanswered: the lookup times out
    const from = `unk-${Date.now()}`;
    c.dispatch({ v: 2, type: "incoming", from, messageId: `tr-${Date.now()}`, timestamp: 5, ciphertext: "AAAA", nonce: "AAAAAAAAAAAAAAAA" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(ofType(sent, "fetch_keys")).toHaveLength(1);
    expect(ofType(sent, "ack")).toHaveLength(0);
    expect(store.getAllMessagesByPeerId(from)).toHaveLength(0);
  });

  it("re-fetches a stale cached key once and reads the message", async () => {
    const me = `me-stale-${Date.now()}`;
    const sender = `sender-stale-${Date.now()}`;
    store.clearSession();
    store.saveSessionUser(me, "s3cret");
    const mePub = loadOrCreateIdentity().publicKeyB64;
    process.env.YAPR_DATA_DIR = OTHER_DIR;
    const senderPub = loadOrCreateIdentity().publicKeyB64;
    const env = sealText(mePub, sender, me, "hello again", "");
    process.env.YAPR_DATA_DIR = STRANGER_DIR;
    const stalePub = loadOrCreateIdentity().publicKeyB64;
    process.env.YAPR_DATA_DIR = TEST_DIR;
    store.setPeerKey(sender, stalePub); // cached from before the peer's key changed

    const sent = goOnline((f) => {
      if (f.type === "fetch_keys") {
        queueMicrotask(() => c.dispatch({ v: 2, type: "keys", keys: { [sender]: senderPub } }));
      }
    });
    c.dispatch({ v: 2, type: "incoming", from: sender, messageId: "stale-1", timestamp: 7, ...env });
    await settle();
    expect(store.getAllMessagesByPeerId(sender).map((m) => m.text)).toEqual(["hello again"]);
    expect(store.getPeerKey(sender)).toBe(senderPub);
    expect(ofType(sent, "ack").map((f) => f.messageId)).toEqual(["stale-1"]);
  });
});

describe("message size guard", () => {
  it("refuses to transmit an envelope the server would reject", async () => {
    store.clearSession();
    store.saveSessionUser(`me-big-${Date.now()}`, "s3cret");
    const peer = `big-${Date.now()}`;
    store.setPeerKey(peer, loadOrCreateIdentity().publicKeyB64);
    const sent = goOnline();
    await expect(client.sendChatText(peer, "cm-big", "x".repeat(40_000))).rejects.toThrow("too long");
    expect(ofType(sent, "send")).toHaveLength(0);
  });
});
