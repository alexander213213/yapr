import { Box, Spacer, Text, useInput, useStdout } from "ink";
import { JSX, useEffect, useMemo, useRef, useState } from "react";
import { wrapText } from "./wrap.js";
import { MessageRow, ServerAckFrame, MessageStatus } from "./types.js";
import cliBoxes from "cli-boxes";
import { getAllMessagesByPeerId, insertPendingMessage, markThreadRead } from "./store.js";
import { sendChatText, sendReadReceipt } from "./client.js";
import { socketBus } from "./eventStore.js";

export type Line = {
    text: string;
    messageId: string;
    direction: 'in' | 'out'
    isFirstLine: boolean;
    isLastLine: boolean;
    longest: number;
    status: MessageStatus
    lineIndex: number
};

type BubbleLine = {
    text: JSX.Element;
    messageId: string;
    direction: 'in' | 'out'
    isFirstLine: boolean;
    isLastLine: boolean;
    lineIndex: number;
    type: "content";
}

type LineBreak = {
    text: JSX.Element;
    direction: 'in' | 'out';
    messageId: string;
    lineIndex: "x"
    type: "top" | "bottom";
}

type StatusLine = {
    text: JSX.Element;
    direction: 'in' | 'out';
    messageId: string;
    lineIndex: "s"
    type: "status";
}

export default function MessagesBox({ focused, contactInfo, availableHeight }: { focused: boolean, contactInfo?: { alias: string, peerId: string } | undefined, availableHeight: number }) {
    const { stdout } = useStdout()
    const height = Math.floor((availableHeight - 4))
    const [offset, setOffset] = useState(0)
    const prevMaxOffsetRef = useRef(0);

    

    const [messages, setMessages] = useState<MessageRow[]>([])

    useEffect(() => {
        if (!contactInfo) return
        setMessages(getAllMessagesByPeerId(contactInfo.peerId))
    }, [contactInfo?.peerId]);


    const lines = useMemo(() => {
        return messages.flatMap((msg) =>
            messagesToLines(msg, Math.floor(stdout.columns * 0.8 * 0.4))
        );
    }, [messages, stdout.columns]);

    const bubbleLines = useMemo(() => {
        return linesToBubbles(lines);
    }, [lines]);

    const maxOffset = Math.max(0, bubbleLines.length - height)

    useEffect(() => {
        setOffset(Math.max(0, bubbleLines.length - height));
    }, [contactInfo?.peerId, height]);


    useEffect(() => {
        const wasAtBottom = offset === prevMaxOffsetRef.current;

        if (wasAtBottom) {
            setOffset(Math.max(0, bubbleLines.length - height));
        }

        prevMaxOffsetRef.current = maxOffset;
    }, [bubbleLines.length]);

    useEffect(() => {
        if (!contactInfo) return
        const sendHandler = async (msg: string) => {
            const text = msg.trim()
            if (!text) return
            const { rowId, clientMessageId } = insertPendingMessage(contactInfo.peerId, text)

            const optimistic: MessageRow = {
                id: rowId,
                client_message_id: clientMessageId,
                direction: "out",
                peer_id: contactInfo.peerId,
                text,
                status: "pending",
                created_at: Date.now()
            }

            setMessages(prev => [...prev, optimistic])

            try {
                await sendChatText(contactInfo.peerId, clientMessageId, text)
            } catch {
                // Row stays pending; the outbox flushes it on reconnect.
            }
        }

        const ackHandler = (message: ServerAckFrame) => {
            setMessages(prev => {
                const newList = prev.map(msg => {
                    if (msg.client_message_id === message.clientMessageId) {
                        return {
                            ...msg,
                            status: "sent" as const
                        }
                    }
                    return msg
                })
                return newList
            })
        }

        const readReceiptHandler = (message: { messageId: string }) => {
            setMessages(prev => {
                return prev.map(msg => {
                    if (msg.message_id === message.messageId && msg.direction === "out") {
                        return { ...msg, status: "read" as const }
                    }
                    return msg
                })
            })
        }

        const markOpenThreadRead = () => {
            if (!contactInfo) return
            const ids = markThreadRead(contactInfo.peerId)
            if (ids.length === 0) return
            for (const id of ids) {
                sendReadReceipt(id)
            }
            setMessages(prev => {
                return prev.map(msg => {
                    if (msg.direction === "in" && msg.status === "received") {
                        return { ...msg, status: "read" as const }
                    }
                    return msg
                })
            })
        }

        const inMessageHandler = (message: MessageRow) => {
            if (message.peer_id === contactInfo.peerId) {
                setMessages(prev => [...prev, message])
                // The open thread is being viewed: report reads immediately.
                markOpenThreadRead()
            }
        }

        socketBus.on("send_message", sendHandler)
        socketBus.on("send_ack", ackHandler)
        socketBus.on("incoming_message", inMessageHandler)
        socketBus.on("read_receipt", readReceiptHandler)
        // Viewing a thread marks its backlog read (receipts go out here).
        markOpenThreadRead()
        return () => {
            socketBus.off("send_message", sendHandler)
            socketBus.off("send_ack", ackHandler)
            socketBus.off("incoming_message", inMessageHandler)
            socketBus.off("read_receipt", readReceiptHandler)
        }
    }, [contactInfo?.peerId])

    useInput((input, key) => {
        if (!focused) return
        if (key.downArrow) {
            setOffset(prev => Math.min(maxOffset, prev + 1))
        } else if (key.upArrow) {
            setOffset(prev => Math.max(0, prev - 1))
        }
    })

    
    const visible = bubbleLines.slice(offset, offset + height)

    if (!contactInfo) {
        return (<Box width={"80%"} borderColor={focused ? "#496b22" : "#0e450b"} borderStyle={"round"} flexDirection="column" justifyContent="flex-start">
            <Box width={"100%"}  paddingX={1} borderBottomColor={focused ? "#496b22" : "#0e450b"} borderBottom={true} borderStyle={"single"} borderTop={false} borderLeft={false} borderRight={false}>
                <Text>No Contacts Selected</Text>
            </Box>
        </Box>)
    }


    return (
        <Box width={"80%"} borderColor={focused ? "#496b22" : "#0e450b"} borderStyle={"round"} flexDirection="column" justifyContent="flex-start">
            <Box width={"100%"}  paddingX={1} borderBottomColor={focused ? "#496b22" : "#0e450b"} borderBottom={true} borderStyle={"single"} borderTop={false} borderLeft={false} borderRight={false}>
                <Text>{contactInfo.alias}: {contactInfo.peerId}</Text>
                <Spacer></Spacer>
                <Text>{offset} / {maxOffset}</Text>
            </Box>

            {
                visible.map((value) => {
                    const key = `${value.messageId}-${value.type}-${value.lineIndex}`;
                    return (<Box key={key} width={"100%"} justifyContent={value.direction === "in" ? "flex-start" : "flex-end"}>
                        {value.text}
                    </Box>)
                })

            }
        </Box>
    )
}

function statusGlyph(status: Line["status"]): string {
    switch (status) {
        case "pending": return "…";
        case "sent": return "✓";
        case "delivered": return "✓";
        case "read": return "✓✓";
        default: return "";
    }
}

function linesToBubbles(lines: Line[]) {
    const Boxes = lines.flatMap((line) => {
        const result: (BubbleLine | LineBreak | StatusLine)[] = []
        const text = (
            <Text>
                <Text color={line.status !== "pending" ? "#9a9e3f" : "#1b2a09"}>{cliBoxes.round.left}</Text>
                {line.text}
                <Text color={line.status !== "pending" ? "#9a9e3f" : "#1b2a09"}>{cliBoxes.round.right}</Text>
            </Text>
        )
        const box: BubbleLine = {
            ...line,
            text,
            lineIndex: line.lineIndex,
            type: "content"
        }

        if (line.isFirstLine) {
            const breaker = (
                <Text color={line.status !== "pending" ? "#9a9e3f" : "#1b2a09"}>
                    {cliBoxes.round.topLeft + cliBoxes.round.top.repeat(line.longest) + cliBoxes.round.topRight}
                </Text>
            )
            result.push({
                text: breaker,
                direction: line.direction,
                messageId: line.messageId,
                lineIndex: "x",
                type: "top",
            })
        }

        result.push(box)

        if (line.isLastLine) {
            const breaker = (
                <Text color={line.status !== "pending" ? "#9a9e3f" : "#1b2a09"}>
                    {cliBoxes.round.bottomLeft + cliBoxes.round.bottom.repeat(line.longest) + cliBoxes.round.bottomRight}
                </Text>
            )
            result.push({
                text: breaker,
                direction: line.direction,
                messageId: line.messageId,
                lineIndex: "x",
                type: "bottom"
            })
            // Delivery status lives on its own dim line under the bubble so the
            // content width (and borders) never shift.
            if (line.direction === "out") {
                const glyph = statusGlyph(line.status)
                if (glyph) {
                    result.push({
                        text: (<Text dimColor>{glyph}</Text>),
                        direction: line.direction,
                        messageId: line.messageId,
                        lineIndex: "s",
                        type: "status",
                    })
                }
            }
        }
        return result
    })
    return Boxes

}

function messagesToLines(message: MessageRow, maxWidth: number) {
    const { lines, longest } = wrapText(message.text, maxWidth)

    return lines.map<Line>((value, index, arr) => {
        return {
            text: value,
            messageId: `${message.client_message_id ?? message.message_id ?? message.id}`,
            direction: message.direction,
            isFirstLine: index === 0,
            isLastLine: arr.length - 1 === index,
            status: message.status,
            longest: longest,
            lineIndex: index
        } as Line
    })
}