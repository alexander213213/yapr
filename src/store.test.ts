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
  adoptAdvertisedNick,
  clearSession,
  closeChat,
  deleteContact,
  displayNameFor,
  findContact,
  getAllContacts,
  getGroupEarliestCreatedAt,
  getGroupMessagesBefore,
  getOpenChats,
  getSessionUser,
  getSetting,
  getSharedNick,
  getUnreadCounts,
  insertIncomingMessage,
  insertPendingMessage,
  markInboundMessageRead,
  markThreadRead,
  mergeSharedNick,
  openChat,
  saveSessionUser,
  setSetting,
  setSharedNick,
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

  it("adopts advertised DM nicks only into blank aliases", () => {
    const fresh = `newcomer-${UID}`;
    expect(adoptAdvertisedNick(fresh, "  Captain  ")).toBe(true);
    expect(findContact(fresh)?.alias).toBe("Captain");

    // Renames win: adoption never overwrites.
    expect(adoptAdvertisedNick(fresh, "Intruder")).toBe(false);
    expect(findContact(fresh)?.alias).toBe("Captain");

    // Empty/blank nicks adopt nothing (and create no row).
    expect(adoptAdvertisedNick(`ghost-${UID}`, "")).toBe(false);
    expect(adoptAdvertisedNick(`ghost-${UID}`, "   ")).toBe(false);
    expect(findContact(`ghost-${UID}`)).toBeUndefined();

    // A nick taken by another alias stays blank (UNIQUE guard).
    expect(addNewContact(`holder-${UID}`, "Taken")).toEqual({ ok: true });
    const clash = `clash-${UID}`;
    expect(adoptAdvertisedNick(clash, "Taken")).toBe(false);
    expect(findContact(clash)?.alias ?? null).toBe(null);
  });

  it("reads and writes settings with shipped defaults", () => {
    expect(getSetting("nickname")).toBe("");
    expect(getSetting("share_nickname_gcs")).toBe("1");
    expect(getSetting("share_nickname_dms")).toBe("0");
    expect(getSetting("theme")).toBe("moss");
    expect(getSetting("time_format")).toBe("12");
    expect(getSetting("history_sync_pending")).toBe("[]");
    setSetting("nickname", "tester");
    expect(getSetting("nickname")).toBe("tester");
  });

  it("clears the session for account reset without touching history", () => {
    const peer = `reset-${UID}`;
    insertIncomingMessage(peer, `rm-${UID}`, "old words", 1000);
    saveSessionUser(`u-${UID}`, "s3cret");
    expect(getSessionUser()?.user_id).toBe(`u-${UID}`);
    // Re-saving the same id updates in place (reclaim with a fresh secret).
    saveSessionUser(`u-${UID}`, "s3cret-v2");
    expect(getSessionUser()?.secret).toBe("s3cret-v2");
    clearSession();
    expect(getSessionUser()).toBeUndefined();
    // History survives the reset.
    expect(getUnreadCounts()[peer]).toBe(1);
  });
});

describe("history backfill queries", () => {
  it("returns the gap window newest-first, excluding the boundary and other threads", () => {
    const g = `gap-${UID}`;
    insertIncomingMessage(`a-${UID}`, `gap-1-${UID}`, "oldest", 1000, g, "A");
    insertIncomingMessage(`b-${UID}`, `gap-2-${UID}`, "middle", 2000, g, "B");
    insertIncomingMessage(`a-${UID}`, `gap-3-${UID}`, "newest", 3000, g, "A");
    insertIncomingMessage(`dm-${UID}`, `gap-dm-${UID}`, "dm", 1500);

    const window = getGroupMessagesBefore(g, 3000, 10);
    expect(window.map((r) => r.message_id)).toEqual([`gap-2-${UID}`, `gap-1-${UID}`]);
    // Boundary is exclusive; limit binds.
    expect(getGroupMessagesBefore(g, 2001, 10).map((r) => r.message_id)).toEqual([
      `gap-2-${UID}`,
      `gap-1-${UID}`,
    ]);
    expect(getGroupMessagesBefore(g, 9999, 1).map((r) => r.message_id)).toEqual([`gap-3-${UID}`]);
    expect(getGroupMessagesBefore(`nope-${UID}`, 9999, 10)).toEqual([]);
  });

  it("reports the earliest local row, or null for empty threads", () => {
    const g = `floor-${UID}`;
    expect(getGroupEarliestCreatedAt(g)).toBeNull();
    insertIncomingMessage(`a-${UID}`, `floor-1-${UID}`, "one", 5000, g);
    insertIncomingMessage(`a-${UID}`, `floor-2-${UID}`, "two", 2000, g);
    expect(getGroupEarliestCreatedAt(g)).toBe(2000);
  });

  it("marks single inbound rows read without touching siblings", () => {
    const peer = `bk-${UID}`;
    insertIncomingMessage(peer, `bk-1-${UID}`, "one", 1000);
    insertIncomingMessage(peer, `bk-2-${UID}`, "two", 2000);
    expect(getUnreadCounts()[peer]).toBe(2);
    markInboundMessageRead(`bk-1-${UID}`);
    expect(getUnreadCounts()[peer]).toBe(1);
  });
});

describe("shared nicknames", () => {
  it("merges last-write-wins with first-seen ties", () => {
    expect(mergeSharedNick(null, { nick: "A", updatedAt: 100 })).toEqual({
      nick: "A",
      updatedAt: 100,
    });
    expect(
      mergeSharedNick({ nick: "A", updatedAt: 100 }, { nick: "B", updatedAt: 200 })
    ).toEqual({ nick: "B", updatedAt: 200 });
    // Stale loses, ties keep first-seen.
    expect(
      mergeSharedNick({ nick: "B", updatedAt: 200 }, { nick: "A", updatedAt: 100 })
    ).toEqual({ nick: "B", updatedAt: 200 });
    expect(
      mergeSharedNick({ nick: "B", updatedAt: 200 }, { nick: "C", updatedAt: 200 })
    ).toEqual({ nick: "B", updatedAt: 200 });
  });

  it("round-trips rows including tombstones", () => {
    const g = `sn-${UID}`;
    expect(getSharedNick(g, "u1")).toBeNull();
    setSharedNick(g, "u1", "Al", 1000);
    expect(getSharedNick(g, "u1")).toEqual({ nick: "Al", updatedAt: 1000 });
    setSharedNick(g, "u1", null, 2000);
    expect(getSharedNick(g, "u1")).toEqual({ nick: null, updatedAt: 2000 });
  });

  it("prefers shared master over advertised nicks, pets over everything", () => {
    const g = `dn-${UID}`;
    // Advertised fallback when nothing stored.
    expect(displayNameFor(g, "u1", "Adv")).toBe("Adv");
    // Shared master beats advertised.
    setSharedNick(g, "u1", "Shared", 1000);
    expect(displayNameFor(g, "u1", "Adv")).toBe("Shared");
    // Tombstone falls back through.
    setSharedNick(g, "u1", null, 2000);
    expect(displayNameFor(g, "u1", "Adv")).toBe("Adv");
  });
});
