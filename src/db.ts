import Database from "better-sqlite3";
import path from "node:path";
import fs from "fs"

const dataDir = path.join(import.meta.dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "yapr.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
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
`)

export default db