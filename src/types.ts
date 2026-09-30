export type Focus = "sidebar" | "textbox" | "main"

export type ContactsRow = {
    peer_id: string,
    alias: string,
}

export type UserRow = {
    user_id: string,
    secret: string,
    created_at: number
}

export type MessageRow = {
    id: number,
    peer_id: string,
    direction: "in" | "out"
    client_message_id?: string,
    message_id?: string,
    text: string
    created_at: number
    status: "pending" | "sent" | "received"
}

export type RegisterMessage = {
    type: "register";
};

export type IdentifyMessage = {
    type: "identify";
    userId: string;
    secret: string;
};

export type SendMessage = {
    type: "send_message";
    clientMessageId: string
    to: string
    text: string
}

export type IncomingMessage = {
    type: "incoming_message"
    messageId: string
    from: string
    text: string
    timestamp: number
}

export type DeliveryAckMessage = {
    type: "delivery_ack"
    messageId: string
}

export type RegisterAck = {
    type: "registered"
    userId: string
    secret: string
}

export type IdentifyAck = {
    type: "identified",
    userId: string
}

export type ServerAckMessage = {
    type: "server_ack"
    clientMessageId: string
    messageId: string
    status: "accepted"
    timestamp: number
}

export type ServerMessage = IncomingMessage | ServerAckMessage | IdentifyAck | RegisterAck

export type ContactInfo = {alias: string, peerId: string}