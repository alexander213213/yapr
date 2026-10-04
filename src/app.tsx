import { Box, Text, useInput, useApp, useStdout } from "ink";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import MessagesBox from "./messages.js";
import { Focus, ContactInfo, UserRow } from "./types.js";
import Sidebar from "./sidebar.js";
import ContactsModal from "./contactsModal.js";
import ContactsBrowser from "./contactsBrowser.js";
import SettingsForm from "./settingsForm.js";
import GroupCreateModal from "./groupCreateModal.js";
import GroupMembersModal from "./groupMembersModal.js";
import GroupNicksModal from "./groupNicksModal.js";
import HistoryApproveModal from "./historyApproveModal.js";
import DetailsPane from "./detailsPane.js";
import ChatInput from "./inputBox.js";
import { getTheme } from "./themes.js";
import { socketBus } from "./eventStore.js";
import { findUserStmt, groupIdFromThreadKey, groupThreadKey, openChat } from "./store.js";
import type { HistoryRequestFrame } from "./protocol.js";



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
    const [view, setView] = useState<"chat" | "contacts" | "settings" | "createGroup" | "members" | "nicks">("chat")
    const [modalReturnView, setModalReturnView] = useState<"chat" | "contacts">("chat")
    const [detailsOpen, setDetailsOpen] = useState(false)
    const [historyAsk, setHistoryAsk] = useState<{ groupId: string; requester: string } | undefined>()
    const theme = getTheme();
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
        const onHistoryRequest = (msg: HistoryRequestFrame) => {
            setHistoryAsk({ groupId: msg.groupId, requester: msg.requester })
        }
        socketBus.on("history_request", onHistoryRequest)
        return () => {
            socketBus.off("identified", onIdentified)
            socketBus.off("connection", onConnection)
            socketBus.off("server_error", onServerError)
            socketBus.off("history_request", onHistoryRequest)
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
        if (view !== "chat" || showContactModal || historyAsk) return
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
        if (input === "g" && focused !== "textbox") {
            setView("createGroup")
            return
        }
        if (input === "i" && focused !== "textbox") {
            if (contactInfo) {
                setDetailsOpen((open) => !open)
            }
            return
        }
        if (key.tab) {
            setFocus(prev => {
                if (prev === "sidebar") return "main"
                if (prev === "main") return detailsOpen ? "details" : "textbox"
                if (prev === "details") return "textbox"
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
                ) : view === "createGroup" ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <GroupCreateModal onDone={(groupId) => {
                            setView("chat")
                            if (groupId) {
                                openChat(groupThreadKey(groupId))
                                socketBus.emit("chats_changed")
                            }
                        }} />
                    </Box>
                ) : view === "members" && contactInfo ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <GroupMembersModal groupId={groupIdFromThreadKey(contactInfo.peerId) ?? ""} onClose={() => setView("chat")} />
                    </Box>
                ) : view === "nicks" && contactInfo ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <GroupNicksModal groupId={groupIdFromThreadKey(contactInfo.peerId) ?? ""} onClose={() => setView("chat")} />
                    </Box>
                ) : (
                    <Box width={size.cols} height={size.rows} alignItems="center" flexDirection="column">
                        <Text bold color={theme.roles.accent}>Yapr | {user ? user.user_id : ""} {online ? "●" : "○"}</Text>
                        {lastError ? <Text color={theme.roles.error}>{lastError}</Text> : null}
                        <Box width={"100%"} flexGrow={1} alignItems="stretch" justifyContent="center" overflow="hidden">
                            <Sidebar focused={focused === "sidebar"} openPeerId={contactInfo?.peerId} setContactInfo={setContactInfo} onOpenBrowser={() => setView("contacts")}></Sidebar>
                            <MessagesBox focused={focused === "main"} contactInfo={contactInfo} availableHeight={availableHeight}/>
                            {detailsOpen && contactInfo ? (
                                <DetailsPane
                                    threadKey={contactInfo.peerId}
                                    focused={focused === "details"}
                                    onClose={() => {
                                        setDetailsOpen(false)
                                        setFocus("main")
                                    }}
                                    onOpenMembers={() => setView("members")}
                                    onOpenNicks={() => setView("nicks")}
                                    setContactInfo={setContactInfo}
                                />
                            ) : null}
                        </Box>
                        <ChatInput focused={focused === "textbox"} onSubmit={handleTextSubmit} />
                        {historyAsk && !showContactModal ? (
                            <HistoryApproveModal
                                groupId={historyAsk.groupId}
                                requester={historyAsk.requester}
                                armed={focused !== "textbox"}
                                onClose={() => setHistoryAsk(undefined)}
                            />
                        ) : null}
                    </Box>
                )
            }

        </>
    );
})
