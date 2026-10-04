import { randomUUID } from "node:crypto";
import db from "./db.js";
import type { ContactsRow, MessageRow, UserRow } from "./types.js";

const insertIncomingMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, direction, message_id, group_id, sender_nick, text, status, created_at)
    VALUES (?, 'in', ?, ?, ?, ?, 'received', ?)
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

const deleteContactStmt = db.prepare(`
    DELETE FROM contacts WHERE peer_id = ?
`);

const openChatStmt = db.prepare(`
    INSERT OR IGNORE INTO open_chats (peer_id, opened_at) VALUES (?, ?)
`);

const closeChatStmt = db.prepare(`
    DELETE FROM open_chats WHERE peer_id = ?
`);

const findOpenChatsStmt = db.prepare(`
    SELECT o.peer_id, c.alias, o.opened_at
    FROM open_chats o LEFT JOIN contacts c ON c.peer_id = o.peer_id
    ORDER BY o.opened_at ASC, o.peer_id ASC
`);

export type OpenChatRow = ContactsRow & { opened_at: number };

const insertPendingMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, direction, client_message_id, group_id, text, status, created_at)
    VALUES (?, 'out', ?, ?, ?, 'pending', ?)
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
    RETURNING message_id
`);

const markGroupInboundReadStmt = db.prepare(`
    UPDATE messages SET status = 'read'
    WHERE group_id = ? AND direction = 'in' AND status = 'received'
    RETURNING message_id
`);

const recordReadStmt = db.prepare(`
    INSERT OR IGNORE INTO message_reads (message_id, reader_id, read_at)
    VALUES (?, ?, ?)
`);

const readersForStmt = db.prepare(`
    SELECT reader_id FROM message_reads WHERE message_id = ?
    ORDER BY read_at ASC, reader_id ASC
`);

const unreadCountsStmt = db.prepare(`
    SELECT peer_id, COUNT(*) AS n FROM messages
    WHERE direction = 'in' AND status = 'received'
    GROUP BY peer_id
`);

const findMessagesByPeerIdStmt = db.prepare(`
    SELECT * FROM messages
    WHERE peer_id = ? AND group_id IS NULL
    ORDER BY created_at ASC, id ASC
    LIMIT 200
`);

const findGroupMessagesStmt = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 200
`);

const upsertGroupStmt = db.prepare(`
    INSERT INTO groups (group_id, name, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (group_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
`);

const deleteGroupStmt = db.prepare(`
    DELETE FROM groups WHERE group_id = ?
`);

const replaceGroupMembersStmt = db.prepare(`
    INSERT INTO group_members (group_id, user_id, role, joined_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (group_id, user_id) DO UPDATE SET role = excluded.role, joined_at = excluded.joined_at
`);

const deleteGroupMembersStmt = db.prepare(`
    DELETE FROM group_members WHERE group_id = ?
`);

const findGroupStmt = db.prepare(`
    SELECT group_id, name, updated_at FROM groups WHERE group_id = ?
`);

const listGroupsStmt = db.prepare(`
    SELECT group_id, name, updated_at FROM groups ORDER BY updated_at ASC
`);

const listGroupMembersStmt = db.prepare(`
    SELECT user_id, role, joined_at FROM group_members
    WHERE group_id = ? ORDER BY joined_at ASC, user_id ASC
`);

const getMemberNickStmt = db.prepare(`
    SELECT nick FROM member_nicks WHERE group_id = ? AND user_id = ?
`);

const setMemberNickStmt = db.prepare(`
    INSERT INTO member_nicks (group_id, user_id, nick)
    VALUES (?, ?, ?)
    ON CONFLICT (group_id, user_id) DO UPDATE SET nick = excluded.nick
`);

const clearMemberNickStmt = db.prepare(`
    DELETE FROM member_nicks WHERE group_id = ? AND user_id = ?
`);

const deleteGroupNicksStmt = db.prepare(`
    DELETE FROM member_nicks WHERE group_id = ?
`);

export type GroupRow = { group_id: string; name: string; updated_at: number };
export type GroupMemberRow = { user_id: string; role: string; joined_at: number };
export type GroupThread = { groupId: string; name: string; members: GroupMemberRow[] };

/** Sidebar thread key for a group (DM threads use the peer id directly). */
export function groupThreadKey(groupId: string): string {
  return `g:${groupId}`;
}

export function isGroupThreadKey(key: string): boolean {
  return key.startsWith("g:");
}

export function groupIdFromThreadKey(key: string): string | null {
  return isGroupThreadKey(key) ? key.slice(2) : null;
}

/** Replace the cached snapshot for one group (members diffed wholesale). */
export function upsertGroupCache(groupId: string, name: string, members: GroupMemberRow[]): void {
  const now = Date.now();
  upsertGroupStmt.run(groupId, name, now);
  deleteGroupMembersStmt.run(groupId);
  for (const m of members) {
    replaceGroupMembersStmt.run(groupId, m.user_id, m.role, m.joined_at || now);
  }
}

export function dropGroupCache(groupId: string): void {
  deleteGroupMembersStmt.run(groupId);
  deleteGroupStmt.run(groupId);
  deleteGroupNicksStmt.run(groupId);
}

export function getGroupCache(groupId: string): GroupThread | undefined {
  const group = findGroupStmt.get(groupId) as GroupRow | undefined;
  if (!group) return undefined;
  const members = listGroupMembersStmt.all(groupId) as GroupMemberRow[];
  return { groupId: group.group_id, name: group.name, members };
}

export function listGroupCache(): GroupThread[] {
  const groups = listGroupsStmt.all() as GroupRow[];
  return groups.map((g) => ({
    groupId: g.group_id,
    name: g.name,
    members: listGroupMembersStmt.all(g.group_id) as GroupMemberRow[],
  }));
}

export function getGroupMembers(groupId: string): GroupMemberRow[] {
  return listGroupMembersStmt.all(groupId) as GroupMemberRow[];
}

export function isGroupAdmin(groupId: string, userId: string): boolean {
  const members = listGroupMembersStmt.all(groupId) as GroupMemberRow[];
  return members.some((m) => m.user_id === userId && m.role === "admin");
}

/** Per-member display override. Blank clears back to fallbacks. */
export function setMemberNick(groupId: string, userId: string, nick: string): void {
  const clean = nick.trim();
  if (!clean) {
    clearMemberNickStmt.run(groupId, userId);
    return;
  }
  setMemberNickStmt.run(groupId, userId, clean);
}

export function getMemberNick(groupId: string, userId: string): string | null {
  const row = getMemberNickStmt.get(groupId, userId) as { nick: string } | undefined;
  return row?.nick ?? null;
}

/**
 * Nickname to advertise in envelopes for a context: per-group override wins,
 * then the default nickname when its reveal toggle for that context is on.
 */
export function nickForContext(groupId: string | null, ownId: string): string {
  if (groupId) {
    const override = getMemberNick(groupId, ownId);
    if (override) return override;
    if (getSetting("share_nickname_gcs") === "1") return getSetting("nickname").trim();
    return "";
  }
  if (getSetting("share_nickname_dms") === "1") return getSetting("nickname").trim();
  return "";
}

/** Resolve what to display for a sender: pet override, advertised nick, alias, id. */
export function displayNameFor(
  groupId: string | null,
  senderId: string,
  advertisedNick: string | null
): string {
  if (groupId) {
    const pet = getMemberNick(groupId, senderId);
    if (pet) return pet;
  }
  if (advertisedNick) return advertisedNick;
  return findContact(senderId)?.alias ?? senderId;
}

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

const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

export const DEFAULT_SETTINGS = {
  nickname: "",
  share_nickname_gcs: "1",
  share_nickname_dms: "0",
  theme: "moss",
} as const;
export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export function getSetting(key: SettingKey): string {
  const row = getSettingStmt.get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key];
}

export function setSetting(key: SettingKey, value: string): void {
  setSettingStmt.run(key, value);
}

/**
 * node:sqlite reports constraint violations via numeric `errcode`
 * (better-sqlite3 used string `code`). Extended codes: UNIQUE 2067, PRIMARYKEY 1555.
 */
function sqliteErrcode(err: unknown): number | undefined {
  return (err as { errcode?: number }).errcode;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" || sqliteErrcode(err) === 2067
  );
}

function violationTargets(err: unknown, tableAndColumn: string): boolean {
  if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  if (sqliteErrcode(err) === 1555) return true;
  return String((err as { message?: string }).message ?? err).includes(tableAndColumn);
}

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
  clientMessageId: string = randomUUID(),
  groupId?: string
): { rowId: number; clientMessageId: string } {
  const info = insertPendingMessageStmt.run(peerId, clientMessageId, groupId ?? null, text, Date.now());
  return { rowId: Number(info.lastInsertRowid), clientMessageId };
}

export function getGroupMessages(groupId: string): MessageRow[] {
  return findGroupMessagesStmt.all(groupId) as MessageRow[];
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

/** Mark a whole inbound thread read. Returns the flipped message ids for receipts. */
export function markThreadRead(peerId: string): string[] {
  const rows = markInboundReadStmt.all(peerId) as { message_id: string }[];
  return rows.map((r) => r.message_id);
}

/** Mark a whole inbound group thread read. */
export function markGroupThreadRead(groupId: string): string[] {
  const rows = markGroupInboundReadStmt.all(groupId) as { message_id: string }[];
  return rows.map((r) => r.message_id);
}

/** Record a read receipt; returns all known readers of the message. */
export function recordRead(messageId: string, readerId: string): string[] {
  try {
    recordReadStmt.run(messageId, readerId, Date.now());
  } catch (err: unknown) {
    if (!isUniqueViolation(err)) throw err;
  }
  return readersForMessage(messageId);
}

export function readersForMessage(messageId: string): string[] {
  const rows = readersForStmt.all(messageId) as { reader_id: string }[];
  return rows.map((r) => r.reader_id);
}

/** Unread inbound counts per peer for sidebar badges. */
export function getUnreadCounts(): Record<string, number> {
  const rows = unreadCountsStmt.all() as { peer_id: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.peer_id] = row.n;
  }
  return counts;
}

export type InsertIncomingResult =
  | { inserted: true; rowId: number }
  | { inserted: false; duplicate: true };

/** Store a decoded inbound message. Duplicates (redeliveries) report duplicate. */
export function insertIncomingMessage(
  from: string,
  messageId: string,
  text: string,
  timestamp: number,
  groupId?: string,
  senderNick?: string
): InsertIncomingResult {
  try {
    const info = insertIncomingMessageStmt.run(
      from,
      messageId,
      groupId ?? null,
      senderNick ?? null,
      text,
      timestamp
    );
    return { inserted: true, rowId: Number(info.lastInsertRowid) };
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

/** Returns true when the sender was previously unknown (caller refreshes UI). */
export function ensureContact(from: string): boolean {
  const isNew = !findContact(from);
  if (isNew) {
    insertUnknownContactStmt.run(from);
  }
  // Unknown senders land straight in the sidebar, as before.
  openChatStmt.run(from, Date.now());
  return isNew;
}

/** Sidebar membership, separate from contacts. */
export function openChat(peerId: string): void {
  openChatStmt.run(peerId, Date.now());
}

export function closeChat(peerId: string): boolean {
  return Number(closeChatStmt.run(peerId).changes) > 0;
}

export function getOpenChats(): OpenChatRow[] {
  return findOpenChatsStmt.all() as OpenChatRow[];
}

export type OpenThread =
  | { kind: "dm"; key: string; peerId: string; label: string; unread: number }
  | { kind: "group"; key: string; groupId: string; label: string; unread: number };

/** Unified sidebar listing: DM chats plus open group threads. */
export function getOpenThreads(): OpenThread[] {
  const unreadRows = db
    .prepare(
      `SELECT COALESCE(group_id, peer_id) AS t, COUNT(*) AS n FROM messages
       WHERE direction = 'in' AND status = 'received' GROUP BY t`
    )
    .all() as { t: string; n: number }[];
  const unread = new Map(unreadRows.map((r) => [r.t, r.n]));
  const out: OpenThread[] = [];
  for (const chat of getOpenChats()) {
    if (isGroupThreadKey(chat.peer_id)) {
      const groupId = groupIdFromThreadKey(chat.peer_id);
      if (!groupId) continue;
      const cached = getGroupCache(groupId);
      out.push({
        kind: "group",
        key: chat.peer_id,
        groupId,
        label: cached?.name ?? `Group ${groupId.slice(4, 10)}`,
        unread: unread.get(groupId) ?? 0,
      });
    } else {
      out.push({
        kind: "dm",
        key: chat.peer_id,
        peerId: chat.peer_id,
        label: chat.alias ?? chat.peer_id,
        unread: unread.get(chat.peer_id) ?? 0,
      });
    }
  }
  return out;
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
    if (violationTargets(err, "contacts.peer_id")) {
      return { ok: false, message: "ID already exists in contacts." };
    }
    if (isUniqueViolation(err) || violationTargets(err, "contacts.alias")) {
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
    if (isUniqueViolation(err) || violationTargets(err, "contacts.alias")) {
      return { ok: false, message: "Alias already taken." };
    }
    return { ok: false };
  }
}

/**
 * Remove a contact from the list. Message history is intentionally kept: if the
 * peer messages again, the contact (and its history) reappears automatically.
 * Returns true when a row was actually removed.
 */
export function deleteContact(peerId: string): boolean {
  const info = deleteContactStmt.run(peerId);
  closeChatStmt.run(peerId);
  return Number(info.changes) > 0;
}
