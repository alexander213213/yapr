import { Box, Text, useInput, useApp, useStdout } from "ink";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import MessagesBox from "./messages.js";
import { Focus, ContactInfo, UserRow } from "./types.js";
import Sidebar from "./sidebar.js";
import ContactsModal from "./contactsModal.js";
import ContactsBrowser from "./contactsBrowser.js";
import SettingsForm from "./settingsForm.js";
import ChatInput from "./inputBox.js";
import { socketBus } from "./eventStore.js";
import { findUserStmt, openChat } from "./store.js";



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
    const [showContactModal, setShowModal] = useState(false)
    const [mode, setMode] = useState<"add" | "edit">("add")
    const [online, setOnline] = useState(false)
    const [lastError, setLastError] = useState<string | undefined>()
    const [view, setView] = useState<"chat" | "contacts" | "settings">("chat")
    const [modalReturnView, setModalReturnView] = useState<"chat" | "contacts">("chat")
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
        if (view !== "chat" || showContactModal) return
        if (input === "q" && focused !== "textbox") {
            exit();
        }
        if (input === "c" && focused !== "textbox") {
            setView("contacts")
            return
        }
        if (input === "s" && focused !== "textbox") {
            setView("settings")
            return
        }
        if (key.tab) {
            setFocus(prev => {
                if (prev === "sidebar") return "main"
                if (prev === "main") return "textbox"
                if (prev === "textbox") return "sidebar"
                else return "sidebar"
            })
        }
    });

    const closeModal = () => {
        setShowModal(false)
        setView(modalReturnView)
    }

    const openBrowserChat = (peerId: string, alias: string | null) => {
        openChat(peerId)
        socketBus.emit("chats_changed")
        setContactInfo({ alias: alias ?? peerId, peerId })
        setView("chat")
    }

    return (
        <>
            {
                showContactModal && (mode === "add" || contactInfo) ? (<Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                    {mode === "add" ? (
                        <ContactsModal mode={mode} setShowModal={closeModal}></ContactsModal>
                    ) : contactInfo ? (
                        <ContactsModal mode={mode} setShowModal={closeModal} contactInfo={contactInfo}></ContactsModal>
                    ) : null}
                </Box>
                ) : view === "contacts" ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <ContactsBrowser
                            onClose={() => setView("chat")}
                            onChat={(c) => openBrowserChat(c.peer_id, c.alias)}
                            onEdit={(c) => {
                                setContactInfo({ alias: c.alias ?? c.peer_id, peerId: c.peer_id })
                                setMode("edit")
                                setModalReturnView("contacts")
                                setShowModal(true)
                            }}
                            onAdd={() => {
                                setMode("add")
                                setModalReturnView("contacts")
                                setShowModal(true)
                            }}
                        />
                    </Box>
                ) : view === "settings" ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <SettingsForm onClose={() => setView("chat")} />
                    </Box>
                ) : (
                    <Box width={size.cols} height={size.rows} alignItems="center" flexDirection="column">
                        <Text bold color={"#9a9e3f"}>Yapr | {user ? user.user_id : ""} {online ? "●" : "○"}</Text>
                        {lastError ? <Text color="red">{lastError}</Text> : null}
                        <Box width={"100%"} flexGrow={1} alignItems="stretch" justifyContent="center" overflow="hidden">
                            <Sidebar focused={focused === "sidebar"} openPeerId={contactInfo?.peerId} setContactInfo={setContactInfo} onOpenBrowser={() => setView("contacts")}></Sidebar>
                            <MessagesBox focused={focused === "main"} contactInfo={contactInfo} availableHeight={availableHeight}/>
                        </Box>
                        <ChatInput focused={focused === "textbox"} onSubmit={handleTextSubmit} />
                    </Box>
                )
            }

        </>
    );
})
