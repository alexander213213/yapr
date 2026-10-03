import { Box, Text, useInput, useApp, useStdout } from "ink";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import MessagesBox from "./messages.js";
import { Focus, ContactInfo, UserRow } from "./types.js";
import Sidebar from "./sidebar.js";
import ContactsModal from "./contactsModal.js";
import ChatInput from "./inputBox.js";
import { socketBus } from "./eventStore.js";
import { findUserStmt } from "./store.js";



export default memo(function App() {
    const { stdout } = useStdout()
    const { exit } = useApp();
    const [focused, setFocus] = useState<Focus>("sidebar")
    const [user, setUser] = useState<UserRow | undefined>()
    const [contactInfo, setContactInfo] = useState<ContactInfo | undefined>()
    // Stable mirror so the memoized submit callback always sees the open thread
    // without re-creating (which would re-render the input on every selection).
    const contactRef = useRef(contactInfo)
    contactRef.current = contactInfo
    const [size, setSize] = useState({
        cols: stdout.columns,
        rows: stdout.rows
    })
    const [showContactModal, setShowContactModal] = useState(false)
    const [mode, setMode] = useState<"add" | "edit">("add")
    const [online, setOnline] = useState(false)
    const [lastError, setLastError] = useState<string | undefined>()
    const availableHeight = size.rows - 1 - 3


    const handleTextSubmit = useCallback((text: string) => {
        if (!contactRef.current) return
        socketBus.emit("send_message", text)
    }, [])
    useEffect(() => {
        const onIdentified = () => {
            setUser(findUserStmt.get() as UserRow | undefined)
        }
        const onConnection = (isOnline: boolean) => {
            setOnline(isOnline)
        }
        const onServerError = (msg: { code: string, message: string }) => {
            setLastError(`${msg.code}: ${msg.message}`)
        }
        socketBus.on("identified", onIdentified)
        socketBus.on("connection", onConnection)
        socketBus.on("server_error", onServerError)
        return () => {
            socketBus.off("identified", onIdentified)
            socketBus.off("connection", onConnection)
            socketBus.off("server_error", onServerError)
        }
    }, [])

    useEffect(() => {
        if (!lastError) return
        const timer = setTimeout(() => setLastError(undefined), 5000)
        return () => clearTimeout(timer)
    }, [lastError])

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
                showContactModal && (mode === "add" || contactInfo) ? (<Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                    {mode === "add" ? (
                        <ContactsModal mode={mode} setShowModal={setShowContactModal}></ContactsModal>
                    ) : contactInfo ? (
                        <ContactsModal mode={mode} setShowModal={setShowContactModal} contactInfo={contactInfo}></ContactsModal>
                    ) : null}
                </Box>
                ) : (
                    <Box width={size.cols} height={size.rows} alignItems="center" flexDirection="column">
                        <Text bold color={"#9a9e3f"}>Yapr | {user ? user.user_id : ""} {online ? "●" : "○"}</Text>
                        {lastError ? <Text color="red">{lastError}</Text> : null}
                        <Box width={"100%"} flexGrow={1} alignItems="stretch" justifyContent="center" overflow="hidden">
                            <Sidebar focused={focused === "sidebar"} setContactInfo={setContactInfo} setShowModal={setShowContactModal} setMode={setMode}></Sidebar>
                            <MessagesBox focused={focused === "main"} contactInfo={contactInfo} availableHeight={availableHeight}/>
                        </Box>
                        <ChatInput focused={focused === "textbox"} onSubmit={handleTextSubmit} />
                    </Box>
                )
            }

        </>
    );
})
