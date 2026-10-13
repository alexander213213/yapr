import { Box, Text, useInput } from "ink";
import { memo, useEffect, useMemo, useState } from "react";
import { deleteContact, getAllContacts, openChat } from "./store.js";
import { getTheme } from "./themes.js";
import { socketBus } from "./eventStore.js";
import type { ContactsRow } from "./types.js";

export type PickResult = { picked: string[] };

export type BrowserKeyAction = "delete" | "edit" | "add" | "filter" | "ignore";

/**
 * Decide what a keypress means in the browser. Manage mode reserves plain
 * d/e/a for actions, so free typing only filters inside `/` filter mode
 * (otherwise typing "dan" would arm a delete confirm on `d`). Picker mode
 * has no action keys, so printable keys always filter there.
 */
export function resolveBrowserKey(args: {
  input: string;
  ctrl: boolean;
  meta: boolean;
  pickMode: boolean;
  filtering: boolean;
  hasCurrent: boolean;
}): BrowserKeyAction {
  const { input, ctrl, meta, pickMode, filtering, hasCurrent } = args;
  if (!pickMode && !filtering) {
    if (input === "d" && hasCurrent) return "delete";
    if (input === "e" && hasCurrent) return "edit";
    if (input === "a") return "add";
    return "ignore";
  }
  if (input && input.length === 1 && !ctrl && !meta) return "filter";
  return "ignore";
}

/**
 * Contacts browser. Manage mode is the full list with chat/delete/rename/add.
 * Picker mode (GC member selection) filters out excluded ids, Enter adds the
 * highlighted contact and stays for rapid adds, Esc closes with the selection.
 */
export default memo(function ContactsBrowser({
  pickMode,
  excludePeerIds,
  onPick,
  onChat,
  onEdit,
  onAdd,
  onClose,
}: {
  pickMode?: boolean;
  excludePeerIds?: string[];
  onPick?: (picked: string[]) => void;
  onChat?: (contact: ContactsRow) => void;
  onEdit?: (contact: ContactsRow) => void;
  onAdd?: () => void;
  onClose: () => void;
}) {
  const [contacts, setContacts] = useState(getAllContacts());
  const [highlight, setHighlight] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<ContactsRow | undefined>();
  const theme = getTheme();

  const refresh = () => {
    setContacts(getAllContacts());
  };

  // Stay live: contacts change under us (adds, renames, auto-added unknown
  // senders). Picker mode inherits this — membership snapshots refresh the
  // same way via groups_changed. Highlight is clamped, never reset, so
  // browsing survives background refreshes.
  useEffect(() => {
    socketBus.on("chats_changed", refresh);
    socketBus.on("new_contact", refresh);
    socketBus.on("groups_changed", refresh);
    return () => {
      socketBus.off("chats_changed", refresh);
      socketBus.off("new_contact", refresh);
      socketBus.off("groups_changed", refresh);
    };
  }, []);

  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    return contacts.filter((c) => {
      if (pickMode && excludePeerIds?.includes(c.peer_id)) return false;
      if (!q) return true;
      return (
        c.peer_id.toLowerCase().includes(q) || (c.alias ?? "").toLowerCase().includes(q)
      );
    });
  }, [contacts, filter, pickMode, excludePeerIds, picked]);

  const current = visible[Math.min(highlight, Math.max(0, visible.length - 1))];

  // Filtering or list changes can strand the highlight past the end: clamp
  // it so Enter/d/e always land on the visibly highlighted row.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, visible.length - 1)));
  }, [visible]);

  const confirmPick = (peerId: string) => {
    const next = [...picked, peerId];
    setPicked(next);
    onPick?.(next);
  };

  useInput((input, key) => {
    if (confirmDelete) {
      if (input === "y") {
        deleteContact(confirmDelete.peer_id);
        socketBus.emit("chats_changed");
        refresh();
      }
      setConfirmDelete(undefined);
      return;
    }
    if (key.escape) {
      if (filter || filtering) {
        setFilter("");
        setFiltering(false);
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(Math.max(0, visible.length - 1), h + 1));
      return;
    }
    if (key.return) {
      if (!current) return;
      if (pickMode) {
        if (!picked.includes(current.peer_id)) {
          confirmPick(current.peer_id);
        }
        return;
      }
      openChat(current.peer_id);
      socketBus.emit("chats_changed");
      onChat?.(current);
      onClose();
      return;
    }
    if (key.backspace || key.delete) {
      // Nothing to erase outside filtering: leave the highlight alone.
      if (!filter && !filtering) return;
      setFilter((f) => f.slice(0, -1));
      setHighlight(0);
      return;
    }
    if (input === "/" && !pickMode) {
      setFiltering(true);
      return;
    }
    const action = resolveBrowserKey({
      input,
      ctrl: key.ctrl,
      meta: key.meta,
      pickMode: !!pickMode,
      filtering,
      hasCurrent: !!current,
    });
    if (action === "delete" && current) {
      setConfirmDelete(current);
      return;
    }
    if (action === "edit" && current) {
      onEdit?.(current);
      return;
    }
    if (action === "add") {
      onAdd?.();
      return;
    }
    if (action === "filter") {
      setFilter((f) => (f + input).slice(0, 32));
      setHighlight(0);
    }
  });

  if (confirmDelete) {
    return (
      <Box width={"60%"} borderColor={theme.roles.danger} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Delete {confirmDelete.alias ?? confirmDelete.peer_id}?</Text>
        <Text dimColor>History is kept. (y/n)</Text>
      </Box>
    );
  }

  return (
    <Box width={"80%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>
        {pickMode ? `Add members${picked.length > 0 ? ` (${picked.length} added)` : ""}` : "Contacts"}
      </Text>
      <Text dimColor>
        {pickMode
          ? "type to filter · Enter add · Esc done"
          : "Enter chat · e rename · d delete · a add · / filter · Esc back"}
      </Text>
      {filter || filtering ? <Text dimColor>Filter: {filter}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text dimColor>No matches.</Text>
        ) : (
          visible.slice(0, 20).map((c, i) => {
            const label = `${c.alias ?? c.peer_id}${c.alias ? ` (${c.peer_id})` : ""}${picked.includes(c.peer_id) ? " ✓" : ""}`;
            return i === highlight ? (
              <Text key={c.peer_id} color={theme.roles.accent}>{`> ${label}`}</Text>
            ) : (
              <Text key={c.peer_id} dimColor>{`  ${label}`}</Text>
            );
          })
        )}
        {visible.length > 20 ? <Text dimColor>…{visible.length - 20} more</Text> : null}
      </Box>
    </Box>
  );
});
