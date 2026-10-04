import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import { getTheme } from "./themes.js";
import { socketBus } from "./eventStore.js";
import {
  closeChat,
  deleteContact,
  dropGroupCache,
  findContact,
  getAllMessagesByPeerId,
  getGroupCache,
  getGroupMembers,
  getGroupMessages,
  getSessionUser,
  groupIdFromThreadKey,
  isGroupAdmin,
  updateContact,
} from "./store.js";
import { client } from "./client.js";
import type { ContactInfo } from "./types.js";

type Entry =
  | { kind: "info"; label: string; value: string }
  | { kind: "action"; id: string; label: string };

/**
 * Toggleable right column: chat details for DMs, group details for groups.
 * DM: info + rename/delete/close. Group: info + members/nicknames entry points,
 * rename (admin), leave. Destructive actions confirm inline.
 */
export default memo(function DetailsPane({
  threadKey,
  focused,
  onClose,
  onOpenMembers,
  onOpenNicks,
  setContactInfo,
}: {
  threadKey: string;
  focused: boolean;
  onClose: () => void;
  onOpenMembers: (groupId: string) => void;
  onOpenNicks: (groupId: string) => void;
  setContactInfo: (value: ContactInfo | undefined) => unknown;
}) {
  const [highlight, setHighlight] = useState(0);
  const [confirm, setConfirm] = useState<string | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const theme = getTheme();
  const groupId = groupIdFromThreadKey(threadKey);

  const entries: Entry[] = (() => {
    if (groupId) {
      const group = getGroupCache(groupId);
      if (!group) {
        return [{ kind: "info", label: "Group", value: "no longer available" }];
      }
      const ownId = getSessionUser()?.user_id;
      const admin = ownId ? isGroupAdmin(groupId, ownId) : false;
      const count = getGroupMessages(groupId).length;
      const list: Entry[] = [
        { kind: "info", label: "Name", value: group.name },
        { kind: "info", label: "ID", value: `${groupId.slice(0, 12)}…` },
        {
          kind: "info",
          label: "Members",
          value: `${getGroupMembers(groupId).length}${admin ? " (admin)" : ""}`,
        },
        { kind: "info", label: "Messages", value: `${count}` },
        { kind: "action", id: "members", label: "Members…" },
        { kind: "action", id: "nicks", label: "Nicknames…" },
        { kind: "action", id: "history", label: "Ask for history" },
      ];
      if (admin) list.push({ kind: "action", id: "rename", label: "Rename group" });
      list.push({ kind: "action", id: "leave", label: "Leave group" });
      return list;
    }
    const contact = findContact(threadKey);
    const count = getAllMessagesByPeerId(threadKey).length;
    return [
      { kind: "info", label: "Name", value: contact?.alias ?? threadKey },
      { kind: "info", label: "ID", value: threadKey },
      { kind: "info", label: "Encryption", value: "X25519 + AES-256-GCM" },
      { kind: "info", label: "Messages", value: `${count}` },
      { kind: "action", id: "rename", label: "Rename" },
      { kind: "action", id: "delete", label: "Delete contact" },
      { kind: "action", id: "close", label: "Close chat" },
    ];
  })();

  const selectables = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === "action");
  const maxAction = Math.max(0, selectables.length - 1);

  useInput((input, key) => {
    if (!focused) return;
    if (editing) {
      if (key.escape) {
        setEditing(undefined);
      }
      return;
    }
    if (confirm) {
      if (input === "y") {
        if (confirm === "leave" && groupId) {
          client.leaveGroup(groupId);
          dropGroupCache(groupId);
          closeChat(threadKey);
          socketBus.emit("chats_changed");
          setContactInfo(undefined);
          onClose();
        } else if (confirm === "delete") {
          deleteContact(threadKey);
          closeChat(threadKey);
          socketBus.emit("chats_changed");
          setContactInfo(undefined);
          onClose();
        }
      }
      setConfirm(undefined);
      return;
    }
    if (key.escape || input === "i") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(maxAction, h + 1));
      return;
    }
    if (key.return) {
      const target = selectables[Math.min(highlight, maxAction)]?.e;
      if (!target || target.kind !== "action") return;
      if (target.id === "members" && groupId) {
        onOpenMembers(groupId);
      } else if (target.id === "nicks" && groupId) {
        onOpenNicks(groupId);
      } else if (target.id === "history" && groupId) {
        const own = getSessionUser()?.user_id;
        for (const m of getGroupMembers(groupId)) {
          if (m.user_id !== own) {
            client.requestGroupHistory(groupId, m.user_id);
          }
        }
      } else if (target.id === "rename") {
        setDraft("");
        setEditing("rename");
      } else if (target.id === "leave" || target.id === "delete" || target.id === "close") {
        if (target.id === "close") {
          closeChat(threadKey);
          socketBus.emit("chats_changed");
          setContactInfo(undefined);
          onClose();
        } else {
          setConfirm(target.id);
        }
      }
    }
  });

  const submitRename = (value: string) => {
    const clean = value.trim();
    setEditing(undefined);
    if (!clean) return;
    if (groupId) {
      client.renameGroup(groupId, clean);
      void client.refreshGroups().catch(() => {
        setError("rename failed");
      });
    } else {
      const res = updateContact(threadKey, clean, threadKey);
      if (!res.ok) {
        setError(res.message ?? "rename failed");
      } else {
        socketBus.emit("chats_changed");
        setContactInfo({ alias: clean, peerId: threadKey });
      }
    }
  };

  let actionCursor = -1;

  return (
    <Box
      width={"28%"}
      borderColor={focused ? theme.roles.borderFocused : theme.roles.borderDim}
      borderStyle={"round"}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold>{groupId ? "Group details" : "Chat details"}</Text>
      {error ? <Text color={theme.roles.error}>{error}</Text> : null}
      {confirm ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Confirm {confirm}?</Text>
          <Text dimColor>History is kept. (y/n)</Text>
        </Box>
      ) : editing ? (
        <Box marginTop={1}>
          <Text>Name: </Text>
          <TextInput value={draft} onChange={setDraft} focus={true} onSubmit={submitRename} />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {entries.map((e, i) => {
            if (e.kind === "info") {
              return (
                <Text key={`${e.label}-${i}`} dimColor>
                  {e.label}: <Text>{e.value}</Text>
                </Text>
              );
            }
            actionCursor += 1;
            const active = actionCursor === highlight;
            return active ? (
              <Text key={e.id} color={theme.roles.accent}>{`> ${e.label}`}</Text>
            ) : (
              <Text key={e.id} dimColor>{`  ${e.label}`}</Text>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>i close</Text>
      </Box>
    </Box>
  );
});
