import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Build a genuine v3 database, then open it through the real db module
// (dynamic import AFTER the env pin — static imports would hit the real DB).
const TEST_DIR = path.join(os.tmpdir(), `yapr-mig-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

const seed = new DatabaseSync(path.join(TEST_DIR, "yapr.db"));
seed.exec(`
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
  INSERT INTO schema_version (version) VALUES (3);
  CREATE TABLE session (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT NOT NULL,
    direction TEXT NOT NULL, client_message_id TEXT, message_id TEXT,
    text TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 1000,
    status TEXT NOT NULL, UNIQUE (client_message_id), UNIQUE (message_id));
  CREATE TABLE contacts (peer_id TEXT PRIMARY KEY, alias TEXT UNIQUE,
    created_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE peers (user_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE open_chats (peer_id TEXT PRIMARY KEY,
    opened_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO messages (peer_id, direction, message_id, text, created_at, status)
    VALUES ('p1', 'in', 'm1', 'hello', 2000, 'received');
`);
seed.close();

process.env.YAPR_DATA_DIR = TEST_DIR;
await import("./db.js");
const store = await import("./store.js");

describe("v3 to v4 migration", () => {
  it("adds group filing without losing rows", () => {
    const db = new DatabaseSync(path.join(TEST_DIR, "yapr.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT version FROM schema_version").get()).toMatchObject({
        version: 4,
      });
      const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
      expect(cols.some((c) => c.name === "group_id")).toBe(true);
      expect(
        db.prepare("SELECT text FROM messages WHERE message_id = 'm1'").get()
      ).toMatchObject({ text: "hello" });
    } finally {
      db.close();
    }
  });

  it("files group threads separately from DMs", () => {
    store.insertIncomingMessage("alice", "gm1", "group hi", 3000, "grp_1");
    store.insertIncomingMessage("alice", "dm1", "dm hi", 3000);
    expect(store.getGroupMessages("grp_1").map((m) => m.message_id)).toEqual(["gm1"]);
    expect(store.getAllMessagesByPeerId("alice").map((m) => m.message_id)).toEqual(["dm1"]);
  });

  it("caches groups, members and nicks with display fallbacks", () => {    store.upsertGroupCache("grp_1", "fam", [
      { user_id: "alice", role: "admin", joined_at: 1000 },
      { user_id: "bob", role: "member", joined_at: 2000 },
    ]);
    const thread = store.getGroupCache("grp_1");
    expect(thread?.name).toBe("fam");
    expect(thread?.members).toHaveLength(2);
    expect(store.isGroupAdmin("grp_1", "alice")).toBe(true);
    expect(store.isGroupAdmin("grp_1", "bob")).toBe(false);

    // Nick resolution: override beats default; toggles gate the default.
    store.setSetting("nickname", "Al");
    store.setSetting("share_nickname_gcs", "1");
    store.setSetting("share_nickname_dms", "0");
    expect(store.nickForContext("grp_1", "alice")).toBe("Al");
    expect(store.nickForContext(null, "alice")).toBe("");
    store.setMemberNick("grp_1", "alice", "Captain");
    expect(store.nickForContext("grp_1", "alice")).toBe("Captain");
    store.setMemberNick("grp_1", "alice", "  ");
    expect(store.nickForContext("grp_1", "alice")).toBe("Al");

    // Display: pet override, then advertised nick, then alias, then id.
    store.addNewContact("bob", "Bobby");
    expect(store.displayNameFor("grp_1", "bob", "Robert")).toBe("Robert");
    store.setMemberNick("grp_1", "bob", "Bobo");
    expect(store.displayNameFor("grp_1", "bob", "Robert")).toBe("Bobo");
    expect(store.displayNameFor(null, "carol", null)).toBe("carol");

    store.dropGroupCache("grp_1");
    expect(store.getGroupCache("grp_1")).toBeUndefined();
  });

  it("lists unified threads with per-thread unread", () => {
    store.addNewContact("dm-a", "Dee");
    store.openChat("dm-a");
    store.upsertGroupCache("grp_t", "Team", [
      { user_id: "dm-a", role: "admin", joined_at: 1000 },
      { user_id: "ee", role: "member", joined_at: 2000 },
    ]);
    store.openChat(store.groupThreadKey("grp_t"));
    store.insertIncomingMessage("dm-a", "t-dm-1", "hi", 1000);
    store.insertIncomingMessage("ee", "t-g-1", "yo", 1000, "grp_t");
    const threads = store.getOpenThreads();
    const dm = threads.find((t) => t.kind === "dm" && t.key === "dm-a");
    const group = threads.find((t) => t.kind === "group" && t.key === "g:grp_t");
    expect(dm).toMatchObject({ label: "Dee", unread: 1 });
    expect(group).toMatchObject({ label: "Team", unread: 1 });
    expect(store.getGroupMessages("grp_t").map((m) => m.message_id)).toEqual(["t-g-1"]);
  });

  it("records per-message readers", () => {
    expect(store.recordRead("rm-1", "bob")).toEqual(["bob"]);
    expect(store.recordRead("rm-1", "alice").sort()).toEqual(["alice", "bob"]);
    expect(store.recordRead("rm-1", "bob")).toContain("bob");
    expect(store.readersForMessage("rm-1")).toHaveLength(2);
    expect(store.readersForMessage("nope")).toEqual([]);
  });
});
