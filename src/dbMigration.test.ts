import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// A pre-versioning (v0) database: no schema_version table, narrow status
// CHECK, no group columns. db.ts used to stamp it current and crash on
// `no such column: group_id`. Built BEFORE db.ts is imported.
const TEST_DIR = path.join(os.tmpdir(), `yapr-dbmig-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const seed = new DatabaseSync(path.join(TEST_DIR, "yapr.db"));
seed.exec(`
  CREATE TABLE session (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    client_message_id TEXT,
    message_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'received')),
    UNIQUE (client_message_id),
    UNIQUE (message_id)
  );
  CREATE TABLE contacts (peer_id TEXT PRIMARY KEY, alias TEXT COLLATE BINARY UNIQUE, created_at INTEGER NOT NULL DEFAULT 0);
  INSERT INTO contacts (peer_id, alias) VALUES ('alice', 'Alice');
  INSERT INTO messages (peer_id, direction, message_id, text, created_at, status)
    VALUES ('alice', 'in', 'v0-msg', 'from the old days', 1000, 'received');
`);
seed.close();

const { default: db } = await import("./db.js");

describe("v0 database migration", () => {
  it("walks the full chain to the current version", () => {
    const row = db.prepare(`SELECT version FROM schema_version`).get() as { version: number };
    expect(row.version).toBe(5);
    const cols = (db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["group_id", "sender_nick"]));
  });

  it("keeps the old rows and accepts the wider statuses", () => {
    const msg = db.prepare(`SELECT text FROM messages WHERE message_id = 'v0-msg'`).get() as { text: string };
    expect(msg.text).toBe("from the old days");
    db.prepare(`UPDATE messages SET status = 'read' WHERE message_id = 'v0-msg'`).run();
    const contact = db.prepare(`SELECT alias FROM contacts WHERE peer_id = 'alice'`).get() as { alias: string };
    expect(contact.alias).toBe("Alice");
  });
});
