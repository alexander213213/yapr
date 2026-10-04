import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  closeChat,
  deleteContact,
  dropGroupCache,
  getOpenThreads,
  groupIdFromThreadKey,
  type OpenThread,
} from "./store.js";
import { getTheme } from "./themes.js";
import { socketBus } from "./eventStore.js";
import { client } from "./client.js";

type ListItem = {label: string, value: string}

function toItems(threads: OpenThread[]): ListItem[] {
    const items = threads.map((t) => {
        const name = t.kind === "group" ? `◈ ${t.label}` : t.label;
        return {
            label: t.unread > 0 ? `${name} (${t.unread})` : name,
            value: t.key
        }
    })
    items.unshift({label: "≡ Contacts…", value: "::contacts"})
    return items
}

export default memo(function Sidebar({focused, openPeerId, setContactInfo, onOpenBrowser}: {focused: boolean, openPeerId?: string | undefined, setContactInfo: (value: {alias: string, peerId: string} | undefined)=>unknown, onOpenBrowser: ()=>unknown}) {
    const [itemFocused, setItemFocused] = useState<ListItem | undefined>()
    const [threads, setThreads] = useState(getOpenThreads())
    // Auto-select once on first load only. Re-running this on every contacts
    // change used to yank the open thread away whenever a message arrived.
    const didInitialSelect = useRef(false)
    // Two-step delete confirm: thread key awaiting a `y`, cleared on anything else.
    const [confirmDelete, setConfirmDelete] = useState<ListItem | undefined>()
    const theme = getTheme();

    const refresh = () => {
        setThreads(getOpenThreads())
    }

    const onSelect = (item: ListItem) => {
        if (item.value === "::contacts") {
            onOpenBrowser()
            return
        }
        const thread = threads.find((t) => t.key === item.value)
        setContactInfo({alias: thread?.label ?? stripBadge(item.label), peerId: item.value})
    }

    useEffect(() => {
        socketBus.on("new_contact", refresh)
        socketBus.on("chats_changed", refresh)
        socketBus.on("incoming_message", refresh)
        socketBus.on("groups_changed", refresh)
        socketBus.on("identified", refresh)
        return () => {
            socketBus.off("new_contact", refresh)
            socketBus.off("chats_changed", refresh)
            socketBus.off("incoming_message", refresh)
            socketBus.off("groups_changed", refresh)
            socketBus.off("identified", refresh)
        }
    }, [])

    const items = useMemo(() => toItems(threads), [threads])

    useEffect(() => {
        if (didInitialSelect.current) return
        const first = items.find((item) => item.value !== "::contacts")
        if (first) {
            didInitialSelect.current = true
            onSelect(first)
            setItemFocused(first)
        }
    }, [threads])

    useInput((input, key) => {
        if(!focused) return
        if (confirmDelete) {
            if (input === "y") {
                const removed = confirmDelete.value
                const groupId = groupIdFromThreadKey(removed)
                if (groupId) {
                    client.leaveGroup(groupId)
                    dropGroupCache(groupId)
                } else {
                    deleteContact(removed)
                }
                closeChat(removed)
                if (openPeerId === removed) {
                    setContactInfo(undefined)
                }
                setItemFocused(undefined)
                socketBus.emit("chats_changed")
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
                const thread = threads.find((t) => t.key === itemFocused.value)
                setContactInfo({alias: thread?.label ?? stripBadge(itemFocused.label), peerId: itemFocused.value})
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
        const isGroup = groupIdFromThreadKey(confirmDelete.value) !== null;
        return (
            <Box width={"20%"} borderColor={theme.roles.danger} borderStyle={"round"} flexDirection="column" paddingX={1}>
                <Text>{isGroup ? "Leave" : "Delete"}</Text>
                <Text bold>{confirmDelete.label}?</Text>
                <Text dimColor>{isGroup ? "History stays on your device. (y/n)" : "History is kept. (y/n)"}</Text>
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
