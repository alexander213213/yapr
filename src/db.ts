import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { dbPathFor, ensureDataDir } from "./storage.js";

const SCHEMA_VERSION = 2;

// Tests must isolate storage explicitly: static imports evaluate before any
// test-body env assignment, so an unset dir under Vitest would silently open
// the REAL user database (this exact leak happened once — never again).
if (process.env.VITEST && !process.env.YAPR_DATA_DIR) {
  throw new Error("refusing to open the user database under Vitest without YAPR_DATA_DIR");
}

const dataDir = ensureDataDir();
const dbPath = dbPathFor(dataDir);
const isNewFile = !fs.existsSync(dbPath);

const db = new DatabaseSync(dbPath);

if (isNewFile) {
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Windows / read-only FS: best effort only.
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS session (
    user_id TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    client_message_id TEXT,
    message_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'received')),
    UNIQUE (client_message_id),
    UNIQUE (message_id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    peer_id TEXT PRIMARY KEY,
    alias TEXT COLLATE BINARY UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS peers (
    user_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_peer_time
  ON messages (peer_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_messages_status
  ON messages (status);

  CREATE INDEX IF NOT EXISTS idx_contacts_peer
  ON contacts (peer_id);
`);

const row = db
  .prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`)
  .get() as { version: number } | undefined;
let version: number;
if (!row) {
  db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
  version = SCHEMA_VERSION;
} else {
  version = row.version;
}

if (version === 1) {
  // v1 -> v2: extended statuses + peers key cache. CHECK constraints can't be
  // altered, so the messages table is rebuilt (same columns, wider CHECK).
  db.exec(`ALTER TABLE messages RENAME TO messages_v1`);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      client_message_id TEXT,
      message_id TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'received')),
      UNIQUE (client_message_id),
      UNIQUE (message_id)
    )
  `);
  db.exec(`
    INSERT INTO messages (id, peer_id, direction, client_message_id, message_id, text, created_at, status)
    SELECT id, peer_id, direction, client_message_id, message_id, text, created_at, status
    FROM messages_v1
  `);
  db.exec(`DROP TABLE messages_v1`);
  // Indexes were dropped with the old table; recreate them.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_peer_time ON messages (peer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status);
    CREATE INDEX IF NOT EXISTS idx_contacts_peer ON contacts (peer_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      user_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `);
  db.prepare(`UPDATE schema_version SET version = ?`).run(2);
  version = 2;
}

if (version !== SCHEMA_VERSION) {
  throw new Error(
    `Unsupported schema version ${version} (expected ${SCHEMA_VERSION}). Refusing to open ${dbPath}.`
  );
}

console.log(`using data dir ${dataDir}`);

export default db;
