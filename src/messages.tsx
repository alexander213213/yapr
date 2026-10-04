import { Box, Spacer, Text, useInput, useStdout } from "ink";
import { JSX, memo, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import { wrapText } from "./wrap.js";
import { MessageRow, ReadReceiptFrame, ServerAckFrame, MessageStatus } from "./types.js";
import cliBoxes from "cli-boxes";
import {
  displayNameFor,
  getAllMessagesByPeerId,
  getGroupMessages,
  groupIdFromThreadKey,
  insertPendingMessage,
  markGroupThreadRead,
  markThreadRead,
  readersForMessage,
  recordRead,
} from "./store.js";
import { sendChatText, sendGroupText, sendReadReceipt } from "./client.js";
import { formatMessageTime } from "./format.js";
import { parseMarkup, sliceSegments, stripMarkup, type Segment, type SegmentStyle } from "./markup.js";
import { getTheme, type Theme } from "./themes.js";
import { socketBus } from "./eventStore.js";

export type Line = {
    segments: Segment[];
    messageId: string;
    direction: 'in' | 'out'
    isFirstLine: boolean;
    isLastLine: boolean;
    longest: number;
    status: MessageStatus
    createdAt: number
    sender: string | null;
    readers: string[];
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
    lineIndex: "s" | "h"
    type: "status";
}

export default memo(function MessagesBox({ focused, contactInfo, availableHeight }: { focused: boolean, contactInfo?: { alias: string, peerId: string } | undefined, availableHeight: number }) {
    const { stdout } = useStdout()
    const height = Math.floor((availableHeight - 4))
    const [offset, setOffset] = useState(0)
    const prevMaxOffsetRef = useRef(0);

    

    const [messages, setMessages] = useState<MessageRow[]>([])

    // Thread key: `g:<id>` for groups, peer id for DMs.
    const threadKey = contactInfo?.peerId
    const threadGroupId = threadKey ? groupIdFromThreadKey(threadKey) : null

    useEffect(() => {
        if (!threadKey) return
        setMessages(threadGroupId ? getGroupMessages(threadGroupId) : getAllMessagesByPeerId(threadKey))
    }, [threadKey]);


    const theme = getTheme();

    const lines = useMemo(() => {
        return messages.flatMap((msg) =>
            messagesToLines(msg, Math.floor(stdout.columns * 0.8 * 0.4), threadGroupId)
        );
    }, [messages, stdout.columns, threadGroupId]);

    const bubbleLines = useMemo(() => {
        return linesToBubbles(lines, theme);
    }, [lines, theme]);

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
        if (!threadKey) return
        const sendHandler = async (msg: string) => {
            const text = msg.trim()
            if (!text) return
            if (threadGroupId) {
                const clientMessageId = randomUUID();
                const { rowId } = insertPendingMessage(threadKey, text, clientMessageId, threadGroupId);
                const optimistic: MessageRow = {
                    id: rowId,
                    client_message_id: clientMessageId,
                    direction: "out",
                    peer_id: threadKey,
                    group_id: threadGroupId,
                    text,
                    status: "pending",
                    created_at: Date.now()
                }
                setMessages(prev => [...prev, optimistic])
                try {
                    await sendGroupText(threadGroupId, clientMessageId, text)
                } catch {
                    // Row stays pending; the outbox flushes it on reconnect.
                }
                return
            }
            const { rowId, clientMessageId } = insertPendingMessage(threadKey, text)

            const optimistic: MessageRow = {
                id: rowId,
                client_message_id: clientMessageId,
                direction: "out",
                peer_id: threadKey,
                text,
                status: "pending",
                created_at: Date.now()
            }

            setMessages(prev => [...prev, optimistic])

            try {
                await sendChatText(threadKey, clientMessageId, text)
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

        const readReceiptHandler = (message: ReadReceiptFrame) => {
            if (message.messageId) {
                recordRead(message.messageId, message.reader)
            }
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
            if (!threadKey) return
            const ids = threadGroupId ? markGroupThreadRead(threadGroupId) : markThreadRead(threadKey)
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
            const belongs = threadGroupId
                ? message.group_id === threadGroupId
                : message.peer_id === threadKey && !message.group_id;
            if (belongs) {
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
    }, [threadKey])

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
        return (<Box width={"80%"} borderColor={focused ? theme.roles.borderFocused : theme.roles.borderDim} borderStyle={"round"} flexDirection="column" justifyContent="flex-start">
            <Box width={"100%"}  paddingX={1} borderBottomColor={focused ? theme.roles.borderFocused : theme.roles.borderDim} borderBottom={true} borderStyle={"single"} borderTop={false} borderLeft={false} borderRight={false}>
                <Text>No Contacts Selected</Text>
            </Box>
        </Box>)
    }


    return (
        <Box width={"80%"} borderColor={focused ? theme.roles.borderFocused : theme.roles.borderDim} borderStyle={"round"} flexDirection="column" justifyContent="flex-start">
            <Box width={"100%"}  paddingX={1} borderBottomColor={focused ? theme.roles.borderFocused : theme.roles.borderDim} borderBottom={true} borderStyle={"single"} borderTop={false} borderLeft={false} borderRight={false}>
                <Text>{contactInfo.alias}{threadGroupId ? "" : `: ${contactInfo.peerId}`}</Text>
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
})

function statusGlyph(status: Line["status"]): string {
    switch (status) {
        case "pending": return "…";
        case "sent": return "✓";
        case "delivered": return "✓";
        case "read": return "✓✓";
        default: return "";
    }
}

function segmentProps(style: SegmentStyle, theme: Theme): object {
    switch (style) {
        case "bold": return { bold: true };
        case "code": return {};
        case "e1": return { color: theme.roles.e1 };
        case "e2": return { color: theme.roles.e2 };
        case "e3": return { color: theme.roles.e3 };
        default: return {};
    }
}

function linesToBubbles(lines: Line[], theme: Theme) {
    const Boxes = lines.flatMap((line) => {
        const result: (BubbleLine | LineBreak | StatusLine)[] = []
        if (line.isFirstLine && line.sender) {
            result.push({
                text: (<Text dimColor>{line.sender}</Text>),
                direction: line.direction,
                messageId: line.messageId,
                lineIndex: "h",
                type: "status",
            })
        }
        const edge = line.status !== "pending" ? theme.roles.accent : theme.roles.pending
        const text = (
            <Text>
                <Text color={edge}>{cliBoxes.round.left}</Text>
                {line.segments.map((seg, i) =>
                    seg.style === "code" ? (
                        <Text key={i} dimColor>{seg.text}</Text>
                    ) : (
                        <Text key={i} {...segmentProps(seg.style, theme)}>{seg.text}</Text>
                    )
                )}
                <Text color={edge}>{cliBoxes.round.right}</Text>
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
                <Text color={line.status !== "pending" ? theme.roles.accent : theme.roles.pending}>
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
                <Text color={line.status !== "pending" ? theme.roles.accent : theme.roles.pending}>
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
            // Timestamp (+ delivery tick for outbound, seen-by for groups) lives on
            // its own dim line under the bubble so content width never shifts.
            const glyph = line.direction === "out" ? statusGlyph(line.status) : ""
            const seen =
                line.direction === "out" && line.readers.length > 0
                    ? ` · ${line.readers.slice(0, 2).join(", ")}${
                          line.readers.length > 2 ? ` +${line.readers.length - 2}` : ""
                      }`
                    : ""
            const meta = `${formatMessageTime(line.createdAt)}${glyph ? ` ${glyph}` : ""}${seen}`
            result.push({
                text: (<Text dimColor>{meta}</Text>),
                direction: line.direction,
                messageId: line.messageId,
                lineIndex: "s",
                type: "status",
            })
        }
        return result
    })
    return Boxes

}

function messagesToLines(message: MessageRow, maxWidth: number, threadGroupId: string | null) {
    const segments = parseMarkup(message.text);
    const visible = stripMarkup(message.text);
    const { raw, longest } = wrapText(visible, maxWidth);

    return raw.map<Line>((value, index, arr) => {
        let offset = 0;
        for (let k = 0; k < index; k++) {
            offset += (arr[k]?.length ?? 0);
        }
        return {
            segments: sliceSegments(segments, offset, value.length),
            messageId: `${message.client_message_id ?? message.message_id ?? message.id}`,
            direction: message.direction,
            isFirstLine: index === 0,
            isLastLine: arr.length - 1 === index,
            status: message.status,
            createdAt: message.created_at,
            sender:
                message.direction === "in" && threadGroupId
                    ? displayNameFor(threadGroupId, message.peer_id, message.sender_nick ?? null)
                    : null,
            readers:
                message.direction === "out" && threadGroupId && message.message_id
                    ? readersForMessage(message.message_id)
                    : [],
            longest: longest,
            lineIndex: index
        } as Line;
    });
}