import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Build a genuine v4 database (with stored sender_nick rows but blank
// aliases), then open it through the real db module to run the v5 backfill.
const TEST_DIR = path.join(os.tmpdir(), `yapr-nickmig-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

const seed = new DatabaseSync(path.join(TEST_DIR, "yapr.db"));
seed.exec(`
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
  INSERT INTO schema_version (version) VALUES (4);
  CREATE TABLE session (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT NOT NULL,
    direction TEXT NOT NULL, client_message_id TEXT, message_id TEXT,
    group_id TEXT, sender_nick TEXT,
    text TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 1000,
    status TEXT NOT NULL, UNIQUE (client_message_id), UNIQUE (message_id));
  CREATE TABLE contacts (peer_id TEXT PRIMARY KEY, alias TEXT UNIQUE,
    created_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE peers (user_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE open_chats (peer_id TEXT PRIMARY KEY,
    opened_at INTEGER NOT NULL DEFAULT 1000);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO contacts (peer_id, alias) VALUES ('blank-peer', NULL);
  INSERT INTO contacts (peer_id, alias) VALUES ('named-peer', 'Old Name');
  INSERT INTO contacts (peer_id, alias) VALUES ('holder-peer', 'Common');
  INSERT INTO contacts (peer_id, alias) VALUES ('clash-peer', NULL);
  INSERT INTO messages (peer_id, direction, message_id, sender_nick, text, created_at, status)
    VALUES ('blank-peer', 'in', 'n1', 'Newcomer', 'hi', 2000, 'received');
  INSERT INTO messages (peer_id, direction, message_id, sender_nick, text, created_at, status)
    VALUES ('blank-peer', 'in', 'n2', 'Newcomer', 'again', 3000, 'received');
  INSERT INTO messages (peer_id, direction, message_id, sender_nick, text, created_at, status)
    VALUES ('named-peer', 'in', 'n3', 'Intruder', 'hi', 2000, 'received');
  INSERT INTO messages (peer_id, direction, message_id, sender_nick, text, created_at, status)
    VALUES ('clash-peer', 'in', 'n4', 'Common', 'hi', 2000, 'received');
`);
seed.close();

process.env.YAPR_DATA_DIR = TEST_DIR;
await import("./db.js");

describe("v4 to v5 nick backfill", () => {
  it("adopts latest stored nicks into blank aliases only", () => {
    const db = new DatabaseSync(path.join(TEST_DIR, "yapr.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT version FROM schema_version").get()).toMatchObject({
        version: 5,
      });
      const alias = (peer: string) =>
        (db.prepare("SELECT alias FROM contacts WHERE peer_id = ?").get(peer) as { alias: string | null })
          .alias;
      expect(alias("blank-peer")).toBe("Newcomer");
      expect(alias("named-peer")).toBe("Old Name");
      expect(alias("clash-peer")).toBe(null);
    } finally {
      db.close();
    }
  });
});
