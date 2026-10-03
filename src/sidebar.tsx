import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { deleteContact, getAllContacts, getUnreadCounts } from "./store.js";
import { socketBus } from "./eventStore.js";
import type { ContactsRow } from "./types.js";

type ListItem = {label: string, value: string}

function toItems(contacts: ContactsRow[], unread: Record<string, number>): ListItem[] {
    const items = contacts.map((value) => {
        const name = value.alias ?? value.peer_id;
        const count = unread[value.peer_id] ?? 0;
        return {
            label: count > 0 ? `${name} (${count})` : name,
            value: value.peer_id
        }
    })
    items.push({label: "+ Add New Contact", value: "+"})
    return items
}

export default memo(function Sidebar({focused, openPeerId, setContactInfo, setShowModal, setMode}: {focused: boolean, openPeerId?: string | undefined, setContactInfo: (value: {alias: string, peerId: string} | undefined)=>unknown, setShowModal: (value: boolean)=>unknown, setMode: (value: "add" | "edit")=>unknown}) {
    const [itemFocused, setItemFocused] = useState<ListItem | undefined>()
    const [contacts, setContacts] = useState(getAllContacts())
    const [unread, setUnread] = useState<Record<string, number>>(getUnreadCounts())
    // Auto-select once on first load only. Re-running this on every contacts
    // change used to yank the open thread away whenever a message arrived.
    const didInitialSelect = useRef(false)
    // Two-step delete confirm: peer_id awaiting a `y`, cleared on anything else.
    const [confirmDelete, setConfirmDelete] = useState<ListItem | undefined>()

    const refresh = () => {
        setContacts(getAllContacts())
        setUnread(getUnreadCounts())
    }

    const onSelect = (item: ListItem) => {
        if (item.value === "+") {
            setMode("add")
            setShowModal(true)
            return
        }
        const contact = contacts.find((c) => c.peer_id === item.value)
        setContactInfo({alias: contact?.alias ?? item.label, peerId: item.value})
    }

    useEffect(() => {
        socketBus.on("new_contact", refresh)
        socketBus.on("incoming_message", refresh)
        socketBus.on("identified", refresh)
        return () => {
            socketBus.off("new_contact", refresh)
            socketBus.off("incoming_message", refresh)
            socketBus.off("identified", refresh)
        }
    }, [])

    const items = useMemo(() => toItems(contacts, unread), [contacts, unread])

    useEffect(() => {
        if (didInitialSelect.current) return
        const first = items.find((item) => item.value !== "+")
        if (first) {
            didInitialSelect.current = true
            onSelect(first)
            setItemFocused(first)
        }
    }, [contacts])

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
                    refresh()
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
            if (itemFocused.value !== "+") {
                const contact = contacts.find((c) => c.peer_id === itemFocused.value)
                setContactInfo({alias: contact?.alias ?? itemFocused.label, peerId: itemFocused.value})
            }
            return
        }

        if (key.leftArrow && itemFocused?.value !== "+") {
            if (!itemFocused) return
            setMode("edit")
            const contact = contacts.find((c) => c.peer_id === itemFocused.value)
            setContactInfo({alias: contact?.alias ?? itemFocused.label, peerId: itemFocused.value})
            setShowModal(true)
            return
        }

        if ((input === "d" || key.delete) && itemFocused?.value !== "+") {
            if (!itemFocused) return
            setConfirmDelete(itemFocused)
            return
        }
    })

    if (confirmDelete) {
        return (
            <Box width={"20%"} borderColor={"#7a1f1f"} borderStyle={"round"} flexDirection="column" paddingX={1}>
                <Text>Delete</Text>
                <Text bold>{confirmDelete.label}?</Text>
                <Text dimColor>History is kept. (y/n)</Text>
            </Box>
        )
    }

    return (
        <Box width={"20%"} borderColor={focused ? "#496b22" : "#0e450b"} borderStyle={"round"}>
            <SelectInput isFocused={focused} items={items} onSelect={onSelect} onHighlight={(item) => setItemFocused(item)}></SelectInput>
        </Box>
    )
})
