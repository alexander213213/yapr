import { Box, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useEffect, useState } from "react";
import { getAllContacts } from "./index.js";
import { socketBus } from "./eventStore.js";

type ListItem = {label: string, value: string}

export default function Sidebar({focused, setContactInfo, setShowModal, setMode}: {focused: boolean, setContactInfo: (value: {alias: string, peerId: string} | undefined)=>unknown, setShowModal: (value: boolean)=>unknown, setMode: (value: "add" | "edit")=>unknown}) {
    const [itemFocused, setItemFocused] = useState<ListItem | undefined>()
    const [contacts, setContacts] = useState(getAllContacts())
    const onSelect = (item: ListItem) => {
        if (item.value === "+") {
            setMode("add")
            setShowModal(true)
            return
        }
        setContactInfo({alias: item.label, peerId: item.value})
    }

    useEffect(() => {
        const handler = () => {
            setContacts(getAllContacts)
        }

        socketBus.on("new_contact", handler)
        return () => {
            socketBus.off("new_contact", handler)
        }
    }, [])

    useEffect(() => {
        const first = items[0]
        if (first && first.value !== "+") {
            setContactInfo({alias: first.label, peerId: first.value})
            setItemFocused({label: first.label, value: first.value})
        }
    }, [contacts])
    
    useInput((input, key) => {
        if(!focused) return
        if (key.rightArrow || key.tab || key.return) {
            if (!itemFocused) return
            if (!key.tab) {
                onSelect(itemFocused)
            }
            if (itemFocused.value !== "+") {
                setContactInfo({alias: itemFocused.label, peerId: itemFocused.value})
            }
            return
        } 

        if (key.leftArrow && itemFocused?.value !== "+") {
            if (!itemFocused) return
            setMode("edit")
            setContactInfo({alias: itemFocused.label, peerId: itemFocused.value})
            setShowModal(true)
            return
        }
    })
    


    const items = contacts.map((value) => {
        return {
            label: value.alias ?? value.peer_id,
            value: value.peer_id
        }
    })
    items.push({label: "+ Add New Contact", value: "+"})
    return (
        <Box width={"20%"} borderColor={focused ? "#496b22" : "#0e450b"} borderStyle={"round"}>
            <SelectInput isFocused={focused} items={items} onSelect={onSelect} onHighlight={(item) => setItemFocused(item)}></SelectInput>
        </Box>
    )
}