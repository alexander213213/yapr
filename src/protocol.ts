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
};
export function sendRequest(
  to: string,
  clientMessageId: string,
  envelope: { ciphertext: string; nonce: string }
): SendRequest {
  return {
    v: 2,
    type: "send",
    clientMessageId,
    to,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    timestamp: Date.now(),
  };
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
