import { Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import MessagesBox from "./messages.js";
import { Focus, ContactInfo, UserRow } from "./types.js";
import Sidebar from "./sidebar.js";
import ContactsModal from "./contactsModal.js";
import { socketBus } from "./eventStore.js";
import { findUserStmt } from "./store.js";



export default function App() {
    const { stdout } = useStdout()
    const { exit } = useApp();
    const [textBox, setTextBox] = useState("")
    const [focused, setFocus] = useState<Focus>("sidebar")
    const [user, setUser] = useState<UserRow | undefined>()
    const [contactInfo, setContactInfo] = useState<ContactInfo | undefined>()
    const [size, setSize] = useState({
        cols: stdout.columns,
        rows: stdout.rows
    })
    const [showContactModal, setShowContactModal] = useState(false)
    const [mode, setMode] = useState<"add" | "edit">("add")
    const availableHeight = size.rows - 1 - 3


    const handleTextSubmit = (value: string) => {
        if (!contactInfo) return
        if (!textBox) return
        socketBus.emit("send_message", textBox)
        setTextBox("")
    }
    useEffect(() => {
        const handler = () => {
            setUser(findUserStmt.get() as UserRow | undefined)
        }
        socketBus.on("identified", handler)
        return () => {
            socketBus.off("identified", handler)
        }
    }, [])

    useEffect(() => {
        const onResize = () => {
            setSize({
                cols: stdout.columns,
                rows: stdout.rows
            })
        }

        stdout.on("resize", onResize)
        return () => { stdout.off("resize", onResize) }
    }, [stdout])
    

    useInput((input, key) => {
        if (input === "q" && focused !== "textbox" && !showContactModal) {
            exit();
        }
        if (key.tab && !showContactModal) {
            setFocus(prev => {
                if (prev === "sidebar") return "main"
                if (prev === "main") return "textbox"
                if (prev === "textbox") return "sidebar"
                else return "sidebar"
            })
        }
    });

    return (
        <>
            {
                showContactModal ? (<Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                    <ContactsModal mode={mode} setShowModal={setShowContactModal} contactInfo={contactInfo!}></ContactsModal>
                </Box>
                ) : (
                    <Box width={size.cols} height={size.rows} alignItems="center" flexDirection="column">
                        <Text bold color={"#9a9e3f"}>Yapr | {user ? user.user_id : ""}</Text>
                        <Box width={"100%"} flexGrow={1} alignItems="stretch" justifyContent="center" overflow="hidden">
                            <Sidebar focused={focused === "sidebar"} setContactInfo={setContactInfo} setShowModal={setShowContactModal} setMode={setMode}></Sidebar>
                            <MessagesBox focused={focused === "main"} contactInfo={contactInfo} availableHeight={availableHeight}/>
                        </Box>
                        <Box width={"100%"} paddingX={1} borderStyle={"round"} borderColor={focused === "textbox" ? "#496b22" : "#0e450b"}>
                            <TextInput
                                value={textBox}
                                onChange={setTextBox}
                                focus={focused === "textbox"}
                                placeholder="Enter You Message Here"
                                onSubmit={handleTextSubmit}
                            />
                        </Box>
                    </Box>
                )
            }

        </>
    );
}
