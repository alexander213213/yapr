import { Box, Text, useInput, useApp, useStdout } from "ink";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import MessagesBox from "./messages.js";
import { Focus, ContactInfo, UserRow } from "./types.js";
import Sidebar from "./sidebar.js";
import ContactsModal from "./contactsModal.js";
import ContactsBrowser from "./contactsBrowser.js";
import SettingsForm from "./settingsForm.js";
import ThemePickerModal from "./themePickerModal.js";
import GroupCreateModal from "./groupCreateModal.js";
import GroupMembersModal from "./groupMembersModal.js";
import GroupNicksModal from "./groupNicksModal.js";
import DetailsPane from "./detailsPane.js";
import ChatInput from "./inputBox.js";
import { getTheme } from "./themes.js";
import { isBlocked, isEditingText } from "./editMode.js";
import { socketBus } from "./eventStore.js";
import { findUserStmt, getGroupCache, groupIdFromThreadKey, groupThreadKey, openChat } from "./store.js";



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
    // Persistent account-recovery notice: held until the next successful
    // identify clears it (unlike the auto-clearing error toast above).
    const [reclaimNotice, setReclaimNotice] = useState<string | undefined>()
    // Reconnect visibility: latest retry reason, held while offline so a dead
    // server never looks like a hang. Cleared on any successful connection.
    const [connectNotice, setConnectNotice] = useState<string | undefined>()
    const [view, setView] = useState<"chat" | "contacts" | "settings" | "themePicker" | "createGroup" | "members" | "nicks">("chat")
    const [modalReturnView, setModalReturnView] = useState<"chat" | "contacts">("chat")
    const [detailsOpen, setDetailsOpen] = useState(false)
    // Quiet backfill notice: one transient line per completed round that
    // actually landed rows (auto-clears like the error toast below).
    const [syncNotice, setSyncNotice] = useState<string | undefined>()
    const theme = getTheme();
    const availableHeight = size.rows - 1 - 3


    const handleTextSubmit = useCallback((text: string) => {
        if (!contactRef.current) return
        socketBus.emit("send_message", text)
    }, [])
    useEffect(() => {
        const onIdentified = () => {
            setUser(findUserStmt.get() as UserRow | undefined)
            setReclaimNotice(undefined)
        }
        const onConnection = (isOnline: boolean) => {
            setOnline(isOnline)
            if (isOnline) setConnectNotice(undefined)
        }
        const onServerError = (msg: { code: string, message: string }) => {
            setLastError(`${msg.code}: ${msg.message}`)
        }
        const onReclaimStatus = (msg: { ok: boolean, message: string }) => {
            if (msg.ok) {
                setReclaimNotice(undefined)
            } else {
                setReclaimNotice(msg.message)
            }
        }
        const onConnectionNotice = (msg: { attempt: number, reason: string, delayMs: number }) => {
            setConnectNotice(`retrying connection (#${msg.attempt}): ${msg.reason}`)
        }
        socketBus.on("identified", onIdentified)
        socketBus.on("connection", onConnection)
        socketBus.on("server_error", onServerError)
        socketBus.on("reclaim_status", onReclaimStatus)
        socketBus.on("connection_notice", onConnectionNotice)
        const onHistorySync = (msg: { groupId: string, count: number }) => {
            const name = getGroupCache(msg.groupId)?.name ?? "group";
            setSyncNotice(`Loaded ${msg.count} older messages in ${name}`)
        }
        socketBus.on("history_sync", onHistorySync)
        return () => {
            socketBus.off("identified", onIdentified)
            socketBus.off("connection", onConnection)
            socketBus.off("server_error", onServerError)
            socketBus.off("reclaim_status", onReclaimStatus)
            socketBus.off("connection_notice", onConnectionNotice)
            socketBus.off("history_sync", onHistorySync)
        }
    }, [])

    useEffect(() => {
        if (!lastError) return
        const timer = setTimeout(() => setLastError(undefined), 5000)
        return () => clearTimeout(timer)
    }, [lastError])

    useEffect(() => {
        if (!syncNotice) return
        const timer = setTimeout(() => setSyncNotice(undefined), 5000)
        return () => clearTimeout(timer)
    }, [syncNotice])

    useEffect(() => {
        // The open thread vanished under us (sidebar delete/close, session
        // reset): never leave the details pane mounted or focus pointing at
        // an unmounted view.
        if (contactInfo === undefined) {
            setDetailsOpen(false)
            if (focused === "details") setFocus("main")
        }
    }, [contactInfo])

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
        // Letter shortcuts stand down while a text field is edited anywhere
        // or a modal owns the screen (Ink broadcasts to every handler).
        // Tab intentionally keeps working so composer focus-cycling is unaffected.
        const shortcutsLive = focused !== "textbox" && !isEditingText() && !isBlocked()
        if (input === "q" && shortcutsLive) {
            exit();
        }
        if (input === "c" && shortcutsLive) {
            setView("contacts")
            return
        }
        if (input === "s" && shortcutsLive) {
            setView("settings")
            return
        }
        if (input === "g" && shortcutsLive) {
            setView("createGroup")
            return
        }
        if (input === "i" && shortcutsLive) {
            if (contactInfo) {
                if (detailsOpen) {
                    setDetailsOpen(false)
                    // Back to messages only when focus is actually there;
                    // a focus the user moved elsewhere is left alone.
                    if (focused === "details") setFocus("main")
                } else {
                    setDetailsOpen(true)
                    setFocus("details")
                }
            }
            return
        }
        if (input === "t" && shortcutsLive) {
            setFocus("textbox")
            return
        }
        if (key.tab) {
            // A text field being edited anywhere wins over focus-cycling:
            // otherwise Tab strands an editing session live in the background
            // (double-handled keystrokes on return). The composer is custom
            // input (never edit-mode), so its cycling is unaffected, and
            // modals block outright via useBlockingModal.
            if (isEditingText() || isBlocked()) return
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

    // Focus saved across fullscreen members/nicks views (which unmount the
    // whole chat column): restored on return so focus never points nowhere.
    const focusBeforeModal = useRef<Focus>("main")
    const openMembersView = () => {
        focusBeforeModal.current = focused
        setView("members")
    }
    const openNicksView = () => {
        focusBeforeModal.current = focused
        setView("nicks")
    }
    const closeMembersView = () => {
        setView("chat")
        setFocus(focusBeforeModal.current)
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
                        <SettingsForm onClose={() => setView("chat")} onOpenThemePicker={() => setView("themePicker")} />
                    </Box>
                ) : view === "themePicker" ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <ThemePickerModal onDone={() => setView("settings")} />
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
                        <GroupMembersModal groupId={groupIdFromThreadKey(contactInfo.peerId) ?? ""} onClose={closeMembersView} />
                    </Box>
                ) : view === "nicks" && contactInfo ? (
                    <Box width={size.cols} height={size.rows} justifyContent="center" alignItems="center" flexDirection="column">
                        <GroupNicksModal groupId={groupIdFromThreadKey(contactInfo.peerId) ?? ""} onClose={closeMembersView} />
                    </Box>
                ) : (
                    <Box width={size.cols} height={size.rows} alignItems="center" flexDirection="column">
                        <Text bold color={theme.roles.accent}>Yapr | {user ? user.user_id : ""} {online ? "●" : "○"}</Text>
                        {lastError ? <Text color={theme.roles.error}>{lastError}</Text> : null}
                        {reclaimNotice ? <Text color={theme.roles.error}>{reclaimNotice}</Text> : null}
                        {connectNotice && !online ? <Text dimColor>{connectNotice}</Text> : null}
                        <Box width={"100%"} flexGrow={1} alignItems="stretch" justifyContent="center" overflow="hidden">
                            <Sidebar focused={focused === "sidebar"} openPeerId={contactInfo?.peerId} setContactInfo={setContactInfo} onOpenBrowser={() => setView("contacts")}></Sidebar>
                            <MessagesBox focused={focused === "main"} contactInfo={contactInfo} availableHeight={availableHeight}/>
                            {detailsOpen && contactInfo ? (
                                <DetailsPane
                                    key={contactInfo.peerId}
                                    threadKey={contactInfo.peerId}
                                    focused={focused === "details"}
                                    onClose={() => {
                                        setDetailsOpen(false)
                                        if (focused === "details") setFocus("main")
                                    }}
                                    onOpenMembers={openMembersView}
                                    onOpenNicks={openNicksView}
                                    setContactInfo={setContactInfo}
                                />
                            ) : null}
                        </Box>
                        <ChatInput focused={focused === "textbox"} onSubmit={handleTextSubmit} />
                        {syncNotice ? <Text dimColor>{syncNotice}</Text> : null}
                    </Box>
                )
            }

        </>
    );
})
