import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { closeChat, deleteContact, getOpenChats, getUnreadCounts } from "./store.js";
import { getTheme } from "./themes.js";
import { socketBus } from "./eventStore.js";
import type { OpenChatRow } from "./store.js";

type ListItem = {label: string, value: string}

function toItems(chats: OpenChatRow[], unread: Record<string, number>): ListItem[] {
    const items = chats.map((chat) => {
        const name = chat.alias ?? chat.peer_id;
        const count = unread[chat.peer_id] ?? 0;
        return {
            label: count > 0 ? `${name} (${count})` : name,
            value: chat.peer_id
        }
    })
    items.unshift({label: "≡ Contacts…", value: "::contacts"})
    return items
}

export default memo(function Sidebar({focused, openPeerId, setContactInfo, onOpenBrowser}: {focused: boolean, openPeerId?: string | undefined, setContactInfo: (value: {alias: string, peerId: string} | undefined)=>unknown, onOpenBrowser: ()=>unknown}) {
    const [itemFocused, setItemFocused] = useState<ListItem | undefined>()
    const [chats, setChats] = useState(getOpenChats())
    const [unread, setUnread] = useState<Record<string, number>>(getUnreadCounts())
    // Auto-select once on first load only. Re-running this on every contacts
    // change used to yank the open thread away whenever a message arrived.
    const didInitialSelect = useRef(false)
    // Two-step delete confirm: peer_id awaiting a `y`, cleared on anything else.
    const [confirmDelete, setConfirmDelete] = useState<ListItem | undefined>()
    const theme = getTheme();

    const refresh = () => {
        setChats(getOpenChats())
        setUnread(getUnreadCounts())
    }

    const onSelect = (item: ListItem) => {
        if (item.value === "::contacts") {
            onOpenBrowser()
            return
        }
        const chat = chats.find((c) => c.peer_id === item.value)
        setContactInfo({alias: chat?.alias ?? stripBadge(item.label), peerId: item.value})
    }

    useEffect(() => {
        const refreshUnread = () => {
            setUnread(getUnreadCounts())
        }
        socketBus.on("new_contact", refresh)
        socketBus.on("chats_changed", refresh)
        socketBus.on("incoming_message", refreshUnread)
        socketBus.on("identified", refresh)
        return () => {
            socketBus.off("new_contact", refresh)
            socketBus.off("chats_changed", refresh)
            socketBus.off("incoming_message", refreshUnread)
            socketBus.off("identified", refresh)
        }
    }, [])

    const items = useMemo(() => toItems(chats, unread), [chats, unread])

    useEffect(() => {
        if (didInitialSelect.current) return
        const first = items.find((item) => item.value !== "::contacts")
        if (first) {
            didInitialSelect.current = true
            onSelect(first)
            setItemFocused(first)
        }
    }, [chats])

    useInput((input, key) => {
        if(!focused) return
        if (confirmDelete) {
            if (input === "y") {
                const removed = confirmDelete.value
                if (deleteContact(removed)) {
                    if (openPeerId === removed) {
                        setContactInfo(undefined)
                    }
                    setItemFocused(undefined)
                    socketBus.emit("chats_changed")
                }
            }
            setConfirmDelete(undefined)
            return
        }
        if (key.rightArrow || key.tab || key.return) {
            if (!itemFocused) return
            if (!key.tab) {
                onSelect(itemFocused)
            }
            if (itemFocused.value !== "::contacts") {
                const chat = chats.find((c) => c.peer_id === itemFocused.value)
                setContactInfo({alias: chat?.alias ?? stripBadge(itemFocused.label), peerId: itemFocused.value})
            }
            return
        }

        if ((input === "d" || key.delete) && itemFocused && itemFocused.value !== "::contacts") {
            setConfirmDelete(itemFocused)
            return
        }

        if (input === "x" && itemFocused && itemFocused.value !== "::contacts") {
            const closed = itemFocused.value
            closeChat(closed)
            if (openPeerId === closed) {
                setContactInfo(undefined)
            }
            setItemFocused(undefined)
            socketBus.emit("chats_changed")
            return
        }
    })

    if (confirmDelete) {
        return (
            <Box width={"20%"} borderColor={theme.roles.danger} borderStyle={"round"} flexDirection="column" paddingX={1}>
                <Text>Delete</Text>
                <Text bold>{confirmDelete.label}?</Text>
                <Text dimColor>History is kept. (y/n)</Text>
            </Box>
        )
    }

    return (
        <Box width={"20%"} borderColor={focused ? theme.roles.borderFocused : theme.roles.borderDim} borderStyle={"round"}>
            <SelectInput isFocused={focused} items={items} onSelect={onSelect} onHighlight={(item) => setItemFocused(item)}></SelectInput>
        </Box>
    )
})

/** Strip an unread badge (`Name (3)` -> `Name`) for alias fallback. */
function stripBadge(label: string): string {
    return label.replace(/ \(\d+\)$/, "")
}
