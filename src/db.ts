import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { dbPathFor, ensureDataDir } from "./storage.js";

const SCHEMA_VERSION = 1;

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
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'received')),
    UNIQUE (client_message_id),
    UNIQUE (message_id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    peer_id TEXT PRIMARY KEY,
    alias TEXT COLLATE BINARY UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
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
if (!row) {
  db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
} else if (row.version !== SCHEMA_VERSION) {
  throw new Error(
    `Unsupported schema version ${row.version} (expected ${SCHEMA_VERSION}). Refusing to open ${dbPath}.`
  );
}

console.log(`using data dir ${dataDir}`);

export default db;
