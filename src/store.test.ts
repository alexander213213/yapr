import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Isolated DB per run. Static imports evaluate BEFORE this body runs, so the
// store (which opens the DB at import time) must be loaded dynamically AFTER
// the env assignment — otherwise tests silently hit the real user database.
const TEST_DIR = path.join(os.tmpdir(), `yapr-store-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const UID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const {
  addNewContact,
  closeChat,
  deleteContact,
  findContact,
  getAllContacts,
  getOpenChats,
  getSetting,
  getUnreadCounts,
  insertIncomingMessage,
  insertPendingMessage,
  markThreadRead,
  openChat,
  setSetting,
} = await import("./store.js");

describe("store threads", () => {
  it("tracks unread counts and flips threads read with ids", () => {
    const peer = `peer-${UID}`;
    const first = insertIncomingMessage(peer, `m1-${UID}`, "one", 1000);
    const second = insertIncomingMessage(peer, `m2-${UID}`, "two", 2000);
    expect(first.inserted && second.inserted).toBe(true);

    expect(getUnreadCounts()[peer]).toBe(2);

    const ids = markThreadRead(peer);
    expect([...ids].sort()).toEqual([`m1-${UID}`, `m2-${UID}`]);
    expect(getUnreadCounts()[peer] ?? 0).toBe(0);

    // Duplicate redelivery reports duplicate.
    expect(insertIncomingMessage(peer, `m1-${UID}`, "one", 1000)).toEqual({
      inserted: false,
      duplicate: true,
    });
  });

  it("queues outbox rows as pending", () => {
    const { clientMessageId } = insertPendingMessage("peer-x", "queued");
    expect(clientMessageId.length).toBeGreaterThan(0);
  });

  it("reports friendly contact constraint errors", () => {
    const id = `dup-${UID}`;
    expect(addNewContact(id, `Alias One ${UID}`)).toEqual({ ok: true });
    expect(addNewContact(id, `Alias Two ${UID}`)).toEqual({
      ok: false,
      message: "ID already exists in contacts.",
    });
    expect(addNewContact(`other-${UID}`, `Alias One ${UID}`)).toEqual({
      ok: false,
      message: "Alias already taken.",
    });
  });

  it("deletes contacts but keeps their history", () => {
    const id = `gone-${UID}`;
    expect(addNewContact(id, `Goner ${UID}`)).toEqual({ ok: true });
    insertIncomingMessage(id, `gm-${UID}`, "bye history", 3000);
    expect(deleteContact(id)).toBe(true);
    expect(deleteContact(id)).toBe(false);
    expect(findContact(id)).toBeUndefined();
    expect(getAllContacts().some((c) => c.peer_id === id)).toBe(false);
    // History survives the deletion.
    expect(getUnreadCounts()[id]).toBe(1);
  });

  it("tracks open chats separately from contacts", () => {
    const id = `chat-${UID}`;
    addNewContact(id, `Chatter ${UID}`);
    expect(getOpenChats().some((c) => c.peer_id === id)).toBe(false);
    openChat(id);
    expect(getOpenChats().some((c) => c.peer_id === id)).toBe(true);
    expect(closeChat(id)).toBe(true);
    expect(closeChat(id)).toBe(false);
    expect(getOpenChats().some((c) => c.peer_id === id)).toBe(false);
    // Contact itself is untouched.
    expect(findContact(id)?.alias).toBe(`Chatter ${UID}`);
  });

  it("reads and writes settings with shipped defaults", () => {
    expect(getSetting("nickname")).toBe("");
    expect(getSetting("share_nickname_gcs")).toBe("1");
    expect(getSetting("share_nickname_dms")).toBe("0");
    expect(getSetting("theme")).toBe("moss");
    setSetting("nickname", "tester");
    expect(getSetting("nickname")).toBe("tester");
  });
});
