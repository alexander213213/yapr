import { z } from "zod";

/** Protocol v2 (mirrors yapr-server). Every frame carries `v: 2`. */

const v = z.literal(2);
const userIdField = z.string().min(1).max(64);

// --- client -> server builders (plain constructors; server validates) ---

export type RegisterRequest = { v: 2; type: "register"; pubKey: string };
export function registerRequest(pubKey: string): RegisterRequest {
  return { v: 2, type: "register", pubKey };
}

export type IdentifyRequest = { v: 2; type: "identify"; userId: string; secret: string };
export function identifyRequest(userId: string, secret: string): IdentifyRequest {
  return { v: 2, type: "identify", userId, secret };
}

export type FetchKeysRequest = { v: 2; type: "fetch_keys"; userIds: string[] };
export function fetchKeysRequest(userIds: string[]): FetchKeysRequest {
  return { v: 2, type: "fetch_keys", userIds };
}

export type SendRequest = {
  v: 2;
  type: "send";
  clientMessageId: string;
  to: string;
  ciphertext: string;
  nonce: string;
  timestamp: number;
  groupId?: string;
};
export function sendRequest(
  to: string,
  clientMessageId: string,
  envelope: { ciphertext: string; nonce: string },
  groupId?: string
): SendRequest {
  const req: SendRequest = {
    v: 2,
    type: "send",
    clientMessageId,
    to,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    timestamp: Date.now(),
  };
  if (groupId) req.groupId = groupId;
  return req;
}

export type AckRequest = { v: 2; type: "ack"; messageId: string };
export function ackRequest(messageId: string): AckRequest {
  return { v: 2, type: "ack", messageId };
}

export type ReadRequest = { v: 2; type: "read"; messageId: string };
export function readRequest(messageId: string): ReadRequest {
  return { v: 2, type: "read", messageId };
}

export type FetchPendingRequest = {
  v: 2;
  type: "fetch_pending";
  cursor?: { createdAt: number; messageId: string };
  limit?: number;
};
export function fetchPendingRequest(
  cursor?: { createdAt: number; messageId: string },
  limit?: number
): FetchPendingRequest {
  const req: FetchPendingRequest = { v: 2, type: "fetch_pending" };
  if (cursor) req.cursor = cursor;
  if (limit !== undefined) req.limit = limit;
  return req;
}

export type PongFrame = { v: 2; type: "pong" };
export function pongFrame(): PongFrame {
  return { v: 2, type: "pong" };
}

export type CreateGroupRequest = { v: 2; type: "create_group"; name: string; memberIds: string[] };
export function createGroupRequest(name: string, memberIds: string[]): CreateGroupRequest {
  return { v: 2, type: "create_group", name, memberIds };
}

export type AddMembersRequest = { v: 2; type: "add_members"; groupId: string; userIds: string[] };
export function addMembersRequest(groupId: string, userIds: string[]): AddMembersRequest {
  return { v: 2, type: "add_members", groupId, userIds };
}

export type RemoveMemberRequest = { v: 2; type: "remove_member"; groupId: string; userId: string };
export function removeMemberRequest(groupId: string, userId: string): RemoveMemberRequest {
  return { v: 2, type: "remove_member", groupId, userId };
}

export type LeaveGroupRequest = { v: 2; type: "leave_group"; groupId: string };
export function leaveGroupRequest(groupId: string): LeaveGroupRequest {
  return { v: 2, type: "leave_group", groupId };
}

export type RenameGroupRequest = { v: 2; type: "rename_group"; groupId: string; name: string };
export function renameGroupRequest(groupId: string, name: string): RenameGroupRequest {
  return { v: 2, type: "rename_group", groupId, name };
}

export type FetchGroupsRequest = { v: 2; type: "fetch_groups" };
export function fetchGroupsRequest(): FetchGroupsRequest {
  return { v: 2, type: "fetch_groups" };
}

export type GroupEnvelopeInput = { to: string; ciphertext: string; nonce: string };
export type SendGroupRequest = {
  v: 2;
  type: "send_group";
  clientMessageId: string;
  groupId: string;
  envelopes: GroupEnvelopeInput[];
  timestamp: number;
};
export function sendGroupRequest(
  groupId: string,
  clientMessageId: string,
  envelopes: GroupEnvelopeInput[]
): SendGroupRequest {
  return { v: 2, type: "send_group", clientMessageId, groupId, envelopes, timestamp: Date.now() };
}

export type RequestHistoryRequest = { v: 2; type: "request_history"; groupId: string; to: string };
export function requestHistoryRequest(groupId: string, to: string): RequestHistoryRequest {
  return { v: 2, type: "request_history", groupId, to };
}

// --- server -> client parsers (validated; unknown frames rejected) ---

const RegisteredFrame = z.object({
  v,
  type: z.literal("registered"),
  userId: userIdField,
  secret: z.string().min(1).max(256),
});
export type RegisteredFrame = z.infer<typeof RegisteredFrame>;

const IdentifiedFrame = z.object({ v, type: z.literal("identified"), userId: userIdField });
export type IdentifiedFrame = z.infer<typeof IdentifiedFrame>;

const KeysFrame = z.object({
  v,
  type: z.literal("keys"),
  keys: z.record(z.string()),
});
export type KeysFrame = z.infer<typeof KeysFrame>;

const ServerAckFrame = z.object({
  v,
  type: z.literal("server_ack"),
  clientMessageId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  messageIds: z.array(z.string().min(1).max(128)).optional(),
  status: z.literal("accepted"),
  timestamp: z.number().int().nonnegative(),
});
export type ServerAckFrame = z.infer<typeof ServerAckFrame>;

const IncomingFrame = z.object({
  v,
  type: z.literal("incoming"),
  from: userIdField,
  messageId: z.string().min(1).max(128),
  ciphertext: z.string().max(32 * 1024),
  nonce: z.string().max(128),
  timestamp: z.number().int().nonnegative(),
  groupId: z.string().min(1).max(128).optional(),
});
export type IncomingFrame = z.infer<typeof IncomingFrame>;

const PendingDoneFrame = z.object({ v, type: z.literal("pending_done"), hasMore: z.boolean() });
export type PendingDoneFrame = z.infer<typeof PendingDoneFrame>;

const ReadReceiptFrame = z.object({
  v,
  type: z.literal("read_receipt"),
  messageId: z.string().min(1).max(128),
  reader: userIdField,
});
export type ReadReceiptFrame = z.infer<typeof ReadReceiptFrame>;

const PingFrame = z.object({ v, type: z.literal("ping") });
export type PingFrame = z.infer<typeof PingFrame>;

export const ErrorCode = z.enum([
  "INVALID",
  "UNAUTH",
  "NOT_FOUND",
  "OFFLINE",
  "RATE_LIMITED",
  "TOO_LARGE",
  "UPGRADE_REQUIRED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const ErrorFrame = z.object({
  v,
  type: z.literal("error"),
  code: ErrorCode,
  message: z.string(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

const GroupMemberFrame = z.object({
  userId: userIdField,
  role: z.enum(["admin", "member"]),
  joinedAt: z.number().int().nonnegative(),
});

const GroupInfoFrame = z.object({
  groupId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  members: z.array(GroupMemberFrame),
});
export type GroupInfoFrame = z.infer<typeof GroupInfoFrame>;

const GroupsFrame = z.object({
  v,
  type: z.literal("groups"),
  groups: z.array(GroupInfoFrame),
});
export type GroupsFrame = z.infer<typeof GroupsFrame>;

const GroupCreatedFrame = z.object({
  v,
  type: z.literal("group_created"),
  groupId: z.string().min(1).max(128),
});
export type GroupCreatedFrame = z.infer<typeof GroupCreatedFrame>;

const GroupUpdatedFrame = z.object({
  v,
  type: z.literal("group_updated"),
  groupId: z.string().min(1).max(128),
});
export type GroupUpdatedFrame = z.infer<typeof GroupUpdatedFrame>;

const HistoryRequestFrame = z.object({
  v,
  type: z.literal("history_request"),
  groupId: z.string().min(1).max(128),
  requester: userIdField,
});
export type HistoryRequestFrame = z.infer<typeof HistoryRequestFrame>;

export const ServerFrame = z.discriminatedUnion("type", [
  RegisteredFrame,
  IdentifiedFrame,
  KeysFrame,
  ServerAckFrame,
  IncomingFrame,
  PendingDoneFrame,
  ReadReceiptFrame,
  PingFrame,
  ErrorFrame,
  GroupsFrame,
  GroupCreatedFrame,
  GroupUpdatedFrame,
  HistoryRequestFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Parse one server frame. Returns the frame, or null for rejected input
 *  (caller counts/logs and continues; never throws on peer input). */
export function parseServerFrame(raw: string): ServerFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ServerFrame.safeParse(json);
  return parsed.success ? parsed.data : null;
}
