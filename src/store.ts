import { randomUUID } from "node:crypto";
import db from "./db.js";
import type { ContactsRow, MessageRow, UserRow } from "./types.js";

const insertIncomingMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, direction, message_id, text, status, created_at)
    VALUES (?, 'in', ?, ?, 'received', ?)
`);

const insertUserStmt = db.prepare(`
    INSERT INTO session (user_id, secret)
    VALUES (?, ?)
`);

const findUserByUserIdStmt = db.prepare(`
    SELECT * FROM session WHERE user_id = ?
`);

const findContactsStmt = db.prepare(`
    SELECT * FROM contacts
    ORDER BY created_at ASC, peer_id ASC
`);

export const findUserStmt = db.prepare(`
    SELECT * FROM session
`);

const insertContactStmt = db.prepare(`
    INSERT INTO contacts (peer_id, alias)
    VALUES (?, ?)
`);

const insertUnknownContactStmt = db.prepare(`
    INSERT OR IGNORE INTO contacts (peer_id)
    VALUES (?)
`);

const findContactByPeerIdStmt = db.prepare(`
    SELECT * FROM contacts
    WHERE peer_id = ?
`);

const updateContactAliasStmt = db.prepare(`
    UPDATE contacts SET alias = ?
    WHERE peer_id = ?
`);

const insertPendingMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, direction, client_message_id, text, status, created_at)
    VALUES (?, 'out', ?, ?, 'pending', ?)
`);

const updateMessageStatusToSentStmt = db.prepare(`
    UPDATE messages SET status = 'sent', message_id = ?, created_at = ?
    WHERE client_message_id = ?
`);

const updateMessageStatusToReadStmt = db.prepare(`
    UPDATE messages SET status = 'read'
    WHERE message_id = ? AND direction = 'out'
`);

const markInboundReadStmt = db.prepare(`
    UPDATE messages SET status = 'read'
    WHERE peer_id = ? AND direction = 'in' AND status = 'received'
`);

const findMessagesByPeerIdStmt = db.prepare(`
    SELECT * FROM messages
    WHERE peer_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 200
`);

const findPendingOutboxStmt = db.prepare(`
    SELECT * FROM messages
    WHERE direction = 'out' AND status = 'pending'
    ORDER BY created_at ASC, id ASC
    LIMIT ?
`);

const findPeerKeyStmt = db.prepare(`
    SELECT pubkey FROM peers WHERE user_id = ?
`);

const upsertPeerKeyStmt = db.prepare(`
    INSERT INTO peers (user_id, pubkey, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET pubkey = excluded.pubkey, updated_at = excluded.updated_at
`);

export const OUTBOX_BATCH_LIMIT = 100;

export function getSessionUser(): UserRow | undefined {
  return findUserStmt.get() as UserRow | undefined;
}

export function saveSessionUser(userId: string, secret: string): void {
  insertUserStmt.run(userId, secret);
}

export function findSessionUser(userId: string): UserRow | undefined {
  return findUserByUserIdStmt.get(userId) as UserRow | undefined;
}

export function getAllMessagesByPeerId(peerId: string): MessageRow[] {
  return findMessagesByPeerIdStmt.all(peerId) as MessageRow[];
}

export function getAllContacts(): ContactsRow[] {
  return findContactsStmt.all() as ContactsRow[];
}

export function findContact(peerId: string): ContactsRow | undefined {
  return findContactByPeerIdStmt.get(peerId) as ContactsRow | undefined;
}

/** Insert the optimistic pending row. Generates the id when absent (single source). */
export function insertPendingMessage(
  peerId: string,
  text: string,
  clientMessageId: string = randomUUID()
): { rowId: number; clientMessageId: string } {
  const info = insertPendingMessageStmt.run(peerId, clientMessageId, text, Date.now());
  return { rowId: Number(info.lastInsertRowid), clientMessageId };
}

export function getPendingOutbox(limit: number = OUTBOX_BATCH_LIMIT): MessageRow[] {
  return findPendingOutboxStmt.all(limit) as MessageRow[];
}

export function markMessageSent(clientMessageId: string, messageId: string, timestamp: number): void {
  updateMessageStatusToSentStmt.run(messageId, timestamp, clientMessageId);
}

export function markMessageRead(messageId: string): void {
  updateMessageStatusToReadStmt.run(messageId);
}

/** Mark a whole inbound thread read. Returns the number of rows flipped. */
export function markThreadRead(peerId: string): number {
  const info = markInboundReadStmt.run(peerId);
  return Number(info.changes);
}

export type InsertIncomingResult =
  | { inserted: true; rowId: number }
  | { inserted: false; duplicate: true };

/** Store a decoded inbound message. Duplicates (redeliveries) report duplicate. */
export function insertIncomingMessage(
  from: string,
  messageId: string,
  text: string,
  timestamp: number
): InsertIncomingResult {
  try {
    const info = insertIncomingMessageStmt.run(from, messageId, text, timestamp);
    return { inserted: true, rowId: Number(info.lastInsertRowid) };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

/** Returns true when the sender was previously unknown (caller refreshes UI). */
export function ensureContact(from: string): boolean {
  if (findContact(from)) return false;
  insertUnknownContactStmt.run(from);
  return true;
}

export function getPeerKey(userId: string): string | null {
  const row = findPeerKeyStmt.get(userId) as { pubkey: string } | undefined;
  return row?.pubkey ?? null;
}

export function setPeerKey(userId: string, pubkey: string): void {
  upsertPeerKeyStmt.run(userId, pubkey, Date.now());
}

export function addNewContact(
  peerId: string,
  alias: string
): { ok: true } | { ok: false; message?: string } {
  const cleanId = peerId.trim();
  const cleanAlias = alias.trim();
  if (!cleanId) return { ok: false, message: "ID is required." };
  if (!cleanAlias) return { ok: false, message: "Alias is required." };
  try {
    insertContactStmt.run(cleanId, cleanAlias);
    return { ok: true };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    const msg = String((err as { message?: string }).message ?? err);
    if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || msg.includes("contacts.peer_id")) {
      return { ok: false, message: "ID already exists in contacts." };
    }
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || msg.includes("contacts.alias")) {
      return { ok: false, message: "Alias already taken." };
    }
    return { ok: false };
  }
}

export function updateContact(
  oldPeerId: string,
  newAlias: string,
  newPeerId: string
): { ok: true } | { ok: false; message?: string } {
  // Peer IDs are the stable join key for history: they cannot change after creation.
  if (newPeerId.trim() !== oldPeerId.trim()) {
    return { ok: false, message: "Contact ID cannot be changed (it anchors history)." };
  }
  const cleanAlias = newAlias.trim();
  if (!cleanAlias) return { ok: false, message: "Alias is required." };
  try {
    updateContactAliasStmt.run(cleanAlias, oldPeerId);
    return { ok: true };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    const msg = String((err as { message?: string }).message ?? err);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || msg.includes("contacts.alias")) {
      return { ok: false, message: "Alias already taken." };
    }
    return { ok: false };
  }
}
