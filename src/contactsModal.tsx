import { Box, Spacer, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import { addNewContact, updateContact } from "./store.js";
import { getTheme } from "./themes.js";

type ContactsModalParams = {setShowModal: (value: boolean) => unknown} 
& ({ mode: "add"} 
| {mode: "edit", contactInfo: {alias: string, peerId: string}})



export default function ContactsModal(props: ContactsModalParams) {
    const { mode, setShowModal } = props
    const [peerId, setPeerId] = useState("")
    const [alias, setAlias] = useState("")

    // Contact IDs anchor message history and can never change: in edit mode the
    // ID field is display-only and focus cycles alias -> submit.
    const idEditable = mode === "add"
    const [focus, setFocus] = useState<"alias" | "id" | "submit">("alias")
    const [error, setError] = useState<string | undefined>()
    const theme = getTheme();

    useEffect(() => {
        if (mode === "edit") {
            setAlias(props.contactInfo.alias)
            setPeerId(props.contactInfo.peerId)
        } 
    }, [])

    const changeFocus = () => {
        if (focus === "alias") {
            setFocus(idEditable ? "id" : "submit")
        } else if (focus === "id"){
            setFocus("submit")
        } else {
            setFocus("alias")
        }
    }
    
    const onSubmit = () => {
        if (focus !== "submit") {
            changeFocus()
            return
        }
        if (!alias) {
            setFocus("alias")
            return
        }
        if (!peerId) {
            setFocus("id")
            return
        }
        if (mode === "add") {
            const res = addNewContact(peerId, alias)
            if (!res.ok && res.message) {
                const error = res.message ? res.message : "Submission Failed"
                setError(error)
            } else {
                setError(undefined)
                setShowModal(false)
            }
            return
        }

        if (mode === "edit") {
            const res = updateContact(props.contactInfo.peerId, alias, peerId)
            if (!res.ok && res.message) {
                const error = res.message ? res.message : "Submission Failed"
                setError(error)
                return
            } else {
                setError(undefined)
                setShowModal(false)
            }
        }
    }

    useInput((input, key) => {
        if (key.escape) {
            setShowModal(false)
            return
        }
        if (key.tab) {
            changeFocus()
            return
        }
        if (focus === "submit" && key.return) {
            onSubmit()
        }
    })

    return (
        <>
        <Box width={"50%"} height={16} paddingX={3} paddingY={1} justifyContent="flex-start" alignItems="flex-start" flexDirection="column" borderColor={theme.roles.pending} borderStyle={"round"}>
            <Box width={"100%"} justifyContent="space-between">
                <Text>{mode === "add" ? "Add New Contact" : "Edit Contact"}</Text>
                {error ? <Text>{error}</Text> : <Spacer></Spacer>}
            </Box>
            <Box marginY={1} width={"100%"} paddingX={1} borderStyle={"round"} borderColor={focus === "alias" ? theme.roles.borderFocused : theme.roles.borderDim}>
                <Text>Name: </Text>
                <TextInput value={alias} onChange={setAlias} placeholder="Enter Contact Name" focus={focus === "alias"}></TextInput>
            </Box>
            {idEditable ? (
            <Box width={"100%"} paddingX={1} borderStyle={"round"} borderColor={focus === "id" ? theme.roles.borderFocused : theme.roles.borderDim}>
                <Text>ID: </Text>
                <TextInput value={peerId} onChange={setPeerId} placeholder="Enter Contact ID" focus={focus === "id"}></TextInput>
            </Box>
            ) : (
            <Box width={"100%"} paddingX={1} borderStyle={"round"} borderColor={theme.roles.borderDim}>
                <Text>ID: </Text>
                <Text dimColor>{peerId} (cannot be changed)</Text>
            </Box>
            )}

            <Box width={"10%"} marginX={1} justifyContent="center" alignItems="center" alignSelf="flex-end" borderColor={focus === "submit" ? theme.roles.borderFocused : theme.roles.borderDim} borderStyle={"round"}>
                <Text>Submit</Text>
            </Box>
        </Box>
        </>
    )
}