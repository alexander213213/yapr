#!/usr/bin/env node
import net from "net"
import { ContactsRow, DeliveryAckMessage, IdentifyAck, IncomingMessage, MessageRow, RegisterAck, SendMessage, ServerAckMessage, ServerMessage, UserRow } from "./types.js"
import { render } from "ink"
import React from "react"
import App from "./app.js"
import db from "./db.js"
import { randomUUID } from "crypto"
import { socketBus } from "./eventStore.js"

let socket: net.Socket | null = null
export let identified = false

const host = process.env.HOST || "nozomi.proxy.rlwy.net"
const port = Number(process.env.PORT) || 15038



async function main() {
    let buffer = ""
    socket = net.createConnection({ host, port }, () => {
        console.log("connected")
    })


    socket.on("data", (chunk: string) => {
        buffer += chunk.toString()

        let newlineIndex = buffer.indexOf("\n")

        while (newlineIndex !== -1) {
            const raw = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)

            if (raw.length > 0) {
                try {
                    const parsed = JSON.parse(raw) as ServerMessage
                    handleServerMessage(socket!, parsed)
                } catch (err) {
                    send(socket!, {
                        type: "error",
                        message: "Invalid JSON"
                    })
                }
            }
            newlineIndex = buffer.indexOf("\n");
        }
    })

    process.stdout.write("\x1b[?1049h");
    const instance = render(React.createElement(App));
    
    socket.on("error", (err) => {
        instance.unmount()
        socket!.end()
        process.stdout.write("\x1b[?1049l");
        process.stderr.write(String(err) + "\n");
        process.exit(1);
    })
    
    register(socket)

    try {
        await instance.waitUntilExit();
    } finally {
        instance.unmount()
        socket.end()
        process.stdout.write("\x1b[?1049l");
    }
}

const insertIncomingMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, direction, message_id, text, status, created_at)
    VALUES (?, 'in', ?, ?, 'received', ?)
`)

const insertUserStmt = db.prepare(`
    INSERT INTO session (user_id, secret)
    VALUES (?, ?)   
`)

const findUserByUserIdStmt = db.prepare(`
    SELECT * FROM session WHERE user_id = ?
`)

const findContactsStmt = db.prepare(`
    SELECT * FROM contacts
    ORDER BY created_at ASC, peer_id ASC
`)

export const findUserStmt = db.prepare(`
    SELECT * FROM session
`)

const insertContactStmt = db.prepare(`
    INSERT INTO contacts (peer_id, alias)
    VALUES (?, ?)
`)

const inserUnknownContactStmt = db.prepare(`
    INSERT INTO contacts (peer_id)
    VALUES (?)
`)

const findContactByPeerId = db.prepare(`
    SELECT * FROM contacts
    WHERE peer_id = ?
`)

const updateContactStmt = db.prepare(`
    UPDATE contacts SET peer_id = ?, alias = ?
    WHERE peer_id = ?
`)

const insertMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, direction, client_message_id, text, status, created_at)
    VALUES (?, 'out', ?, ?, 'pending', ?)
`)

const updateMessageStatusToSent = db.prepare(`
    UPDATE messages SET status = 'sent', message_id = ?, created_at = ?
    WHERE client_message_id = ?
`)

const findMessagesByPeerId = db.prepare(`
    SELECT * FROM messages
    WHERE status IN ('sent', 'received') AND  peer_id = ?
    ORDER BY created_at ASC, id ASC   
`)

function send(socket: net.Socket, payload: object) {
    socket.write(JSON.stringify(payload) + "\n")
}

function register(socket: net.Socket) {
    const user = findUserStmt.get() as UserRow | undefined
    if (user) {
        identify(socket, { userId: user.user_id, secret: user.secret })
        return
    }
    send(socket, { type: "register" })
}

function identify(socket: net.Socket, user: {userId: string, secret: string}) {
    send(socket, { type: "identify", userId: user.userId, secret: user.secret})
}

export function getAllMessagesByPeerId(peerId: string): MessageRow[] {
    const messages = findMessagesByPeerId.all(peerId) as MessageRow[]
    return messages
}


export function getAllContacts(): ContactsRow[] {
    const contacts = findContactsStmt.all() as ContactsRow[]
    return contacts
}

export function sendMessage(message: Omit<SendMessage, "clientMessageId"> & Partial<Pick<SendMessage, "clientMessageId">>,) {
    if (!socket || !identified) return
    if (!message.clientMessageId) {
        message.clientMessageId = randomUUID()
    }
    const info = insertMessageStmt.run(message.to, message.clientMessageId, message.text, Date.now())
    send(socket, message)
    return info.lastInsertRowid
}

export function addNewContact(peerId: string, alias: string): {ok: true} | {ok: false, message?: string} {
    try {
        insertContactStmt.run(peerId, alias)
        return { ok: true }
    } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.message.includes('contacts.peer_id')) {
            return { ok: false, message: 'ID already exist in contacts.' };
        }

        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('contacts.alias')) {
            return { ok: false, message: 'Alias already taken.' };
        }
        return {ok: false}

    }
}

export function updateContact(oldPeerId: string, newAlias: string, newPeerId: string): {ok: true} | {ok: false, message?: string} {
    try {
        updateContactStmt.run(newPeerId, newAlias, oldPeerId)
        return {ok: true}
    } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.message.includes('contacts.peer_id')) {
            return { ok: false, message: 'ID already exist in contacts.' };
        }

        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('contacts.alias')) {
            return { ok: false, message: 'Alias already taken.' };
        }
        return {ok: false}
    }
}

function handleIncomingMessage(socket: net.Socket, message: IncomingMessage) {
    const payload: DeliveryAckMessage = {
        type: "delivery_ack",
        messageId: message.messageId
    }
    try {
        const info = insertIncomingMessageStmt.run(message.from, message.messageId, message.text, message.timestamp)
        const id = info.lastInsertRowid
        const msg: MessageRow = {
            id: id as number,
            direction: "in",
            peer_id: message.from,
            message_id: message.messageId,
            created_at: message.timestamp,
            status: "received",
            text: message.text
        }
        const contact = findContactByPeerId.get(message.from) as ContactsRow | undefined
        if (!contact) {
            inserUnknownContactStmt.run(message.from)
            socketBus.emit("new_contact")
        }
        socketBus.emit("incoming_message", msg)
        send(socket, payload)
    } catch (err: any) {
        if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
            send(socket, payload)
            return
        }
        throw err
    }
}

function handleRegisterAck(socket: net.Socket, message: RegisterAck) {
    try {
        insertUserStmt.run(message.userId, message.secret)
        identify(socket, {userId: message.userId, secret: message.secret})
    } catch (err) {
        throw err
    }
}

function handleServerAck(socket: net.Socket, message: ServerAckMessage) {
    updateMessageStatusToSent.run(message.messageId, message.timestamp, message.clientMessageId)
    socketBus.emit("send_ack", message)
}

function handleIdentifyAck(socket: net.Socket, message: IdentifyAck) {
    const user = findUserByUserIdStmt.get(message.userId) as { user_id: string, secret: string, created_at: number } | undefined
    if (user && user.user_id === message.userId) {
        identified = true
        socketBus.emit("identified")
        return
    }
}

function handleServerMessage(socket: net.Socket, message: ServerMessage) {
    switch (message.type) {
        case "incoming_message":
            handleIncomingMessage(socket, message)
            break
        case "server_ack":
            handleServerAck(socket, message)
            break
        case "identified":
            handleIdentifyAck(socket, message)
            break
        case "registered":
            handleRegisterAck(socket, message)
            break
        default:
    }
}
main().catch((err) => {
    process.stdout.write("\x1b[?1049l");
    process.stderr.write(String(err) + "\n");
    process.exit(1);
});
