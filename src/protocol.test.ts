import { describe, expect, it } from "vitest";
import {
  ackRequest,
  addMembersRequest,
  createGroupRequest,
  fetchGroupsRequest,
  fetchKeysRequest,
  fetchPendingRequest,
  identifyRequest,
  leaveGroupRequest,
  parseServerFrame,
  pongFrame,
  readRequest,
  registerRequest,
  removeMemberRequest,
  renameGroupRequest,
  requestHistoryRequest,
  sendGroupRequest,
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

  it("builds group membership and fan-out frames", () => {
    expect(createGroupRequest("fam", ["1"])).toEqual({
      v: 2,
      type: "create_group",
      name: "fam",
      memberIds: ["1"],
    });
    expect(addMembersRequest("g", ["2"])).toMatchObject({ type: "add_members", groupId: "g" });
    expect(removeMemberRequest("g", "2")).toMatchObject({ type: "remove_member" });
    expect(leaveGroupRequest("g")).toEqual({ v: 2, type: "leave_group", groupId: "g" });
    expect(renameGroupRequest("g", "n")).toMatchObject({ type: "rename_group", name: "n" });
    expect(fetchGroupsRequest()).toEqual({ v: 2, type: "fetch_groups" });
    expect(requestHistoryRequest("g", "1")).toMatchObject({ type: "request_history" });
    expect(
      sendGroupRequest("g", "c", [{ to: "1", ciphertext: "Yw==", nonce: "bg==" }])
    ).toMatchObject({ v: 2, type: "send_group", groupId: "g" });
    expect(sendRequest("p", "c", { ciphertext: "Yw==", nonce: "bg==" }, "g")).toMatchObject({
      type: "send",
      groupId: "g",
    });
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

  it("parses group snapshot, creation, update and history frames", () => {
    expect(
      parseServerFrame(
        `{"v":2,"type":"groups","groups":[{"groupId":"g","name":"fam","members":[{"userId":"u","role":"admin","joinedAt":1}]}]}`
      )
    ).toMatchObject({ type: "groups" });
    expect(parseServerFrame(`{"v":2,"type":"group_created","groupId":"g"}`)).toMatchObject({
      type: "group_created",
    });
    expect(parseServerFrame(`{"v":2,"type":"group_updated","groupId":"g"}`)).toMatchObject({
      type: "group_updated",
    });
    expect(
      parseServerFrame(`{"v":2,"type":"history_request","groupId":"g","requester":"u"}`)
    ).toMatchObject({ type: "history_request" });
    expect(
      parseServerFrame(
        `{"v":2,"type":"incoming","from":"a","messageId":"m","ciphertext":"Yy","nonce":"n","timestamp":1,"groupId":"g"}`
      )
    ).toMatchObject({ type: "incoming", groupId: "g" });
    expect(
      parseServerFrame(
        `{"v":2,"type":"server_ack","clientMessageId":"c","messageId":"m","messageIds":["m","n"],"status":"accepted","timestamp":1}`
      )
    ).toMatchObject({ type: "server_ack" });
    expect(
      parseServerFrame(`{"v":2,"type":"error","code":"OFFLINE","message":"nope"}`)
    ).toMatchObject({ type: "error", code: "OFFLINE" });
  });
});
