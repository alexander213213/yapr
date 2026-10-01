import { describe, expect, it } from "vitest";
import {
  ackRequest,
  fetchKeysRequest,
  fetchPendingRequest,
  identifyRequest,
  parseServerFrame,
  pongFrame,
  readRequest,
  registerRequest,
  sendRequest,
} from "./protocol.js";

describe("request builders", () => {
  it("builds versioned register/identify frames", () => {
    expect(registerRequest("cHVia2V5")).toEqual({ v: 2, type: "register", pubKey: "cHVia2V5" });
    expect(identifyRequest("u", "s")).toEqual({ v: 2, type: "identify", userId: "u", secret: "s" });
  });

  it("builds an opaque send frame", () => {
    const req = sendRequest("peer", "cid", { ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" });
    expect(req).toMatchObject({
      v: 2,
      type: "send",
      to: "peer",
      clientMessageId: "cid",
      ciphertext: "Y2lwaGVy",
    });
    expect(typeof req.timestamp).toBe("number");
  });

  it("builds ack/read/keys/pending/pong frames", () => {
    expect(ackRequest("m")).toEqual({ v: 2, type: "ack", messageId: "m" });
    expect(readRequest("m")).toEqual({ v: 2, type: "read", messageId: "m" });
    expect(fetchKeysRequest(["a"])).toEqual({ v: 2, type: "fetch_keys", userIds: ["a"] });
    expect(fetchPendingRequest({ createdAt: 1, messageId: "m" }, 10)).toMatchObject({
      v: 2,
      type: "fetch_pending",
      limit: 10,
    });
    expect(pongFrame()).toEqual({ v: 2, type: "pong" });
  });
});

describe("parseServerFrame", () => {
  it("parses registered/identified", () => {
    expect(parseServerFrame(`{"v":2,"type":"registered","userId":"u","secret":"s"}`)).toEqual({
      v: 2,
      type: "registered",
      userId: "u",
      secret: "s",
    });
    expect(parseServerFrame(`{"v":2,"type":"identified","userId":"u"}`)).toMatchObject({
      type: "identified",
    });
  });

  it("parses incoming/server_ack/pending_done/read_receipt/ping/error", () => {
    expect(
      parseServerFrame(
        `{"v":2,"type":"incoming","from":"a","messageId":"m","ciphertext":"Yy","nonce":"n","timestamp":1}`
      )
    ).toMatchObject({ type: "incoming", from: "a" });
    expect(
      parseServerFrame(
        `{"v":2,"type":"server_ack","clientMessageId":"c","messageId":"m","status":"accepted","timestamp":1}`
      )
    ).toMatchObject({ type: "server_ack" });
    expect(parseServerFrame(`{"v":2,"type":"pending_done","hasMore":true}`)).toMatchObject({
      type: "pending_done",
      hasMore: true,
    });
    expect(
      parseServerFrame(`{"v":2,"type":"read_receipt","messageId":"m","reader":"r"}`)
    ).toMatchObject({ type: "read_receipt" });
    expect(parseServerFrame(`{"v":2,"type":"ping"}`)).toEqual({ v: 2, type: "ping" });
    expect(
      parseServerFrame(`{"v":2,"type":"error","code":"UNAUTH","message":"nope"}`)
    ).toMatchObject({ type: "error", code: "UNAUTH" });
  });

  it("rejects malformed, unversioned and unknown frames with null", () => {
    expect(parseServerFrame(`{broken`)).toBeNull();
    expect(parseServerFrame(`{"type":"registered","userId":"u","secret":"s"}`)).toBeNull();
    expect(parseServerFrame(`{"v":2,"type":"nuke"}`)).toBeNull();
    expect(parseServerFrame(`{"v":2,"type":"ack"}`)).toBeNull();
  });
});
