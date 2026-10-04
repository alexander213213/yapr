export type Focus = "sidebar" | "textbox" | "main" | "details";

export type ContactsRow = {
  peer_id: string;
  alias: string | null;
  created_at?: number;
};

export type UserRow = {
  user_id: string;
  secret: string;
  created_at: number;
};

export type MessageDirection = "in" | "out";

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "received";

export type MessageRow = {
  id: number;
  peer_id: string;
  direction: MessageDirection;
  client_message_id?: string | null;
  message_id?: string | null;
  group_id?: string | null;
  sender_nick?: string | null;
  text: string;
  created_at: number;
  status: MessageStatus;
};

export type ContactInfo = { alias: string; peerId: string };

// Server frame types live in protocol.ts; UI-facing aliases stay here so views
// import from one place.
export type {
  ErrorFrame,
  IncomingFrame,
  KeysFrame,
  PendingDoneFrame,
  PingFrame,
  ReadReceiptFrame,
  ServerAckFrame,
} from "./protocol.js";
