import { Box, Text, useInput } from "ink";
import { memo, useEffect, useState } from "react";
import ContactsBrowser from "./contactsBrowser.js";
import GroupAddIdModal from "./groupAddIdModal.js";
import { getTheme } from "./themes.js";
import { socketBus } from "./eventStore.js";
import {
  displayNameFor,
  getGroupCache,
  getGroupMembers,
  getSessionUser,
  isGroupAdmin,
} from "./store.js";
import { client } from "./client.js";

/**
 * Union of confirmed members and session-added ids (both add paths). Keeps
 * the typed-ID validator and the picker's fresh-filter honest before the
 * membership snapshot refreshes AND after: once the server confirms an add,
 * the id lives in both lists and must not double-count. Members first, then
 * genuinely fresh ids. Pure: unit-tested.
 */
export function mergeKnownIds(memberIds: string[], sessionAdded: string[]): string[] {
  const known = [...memberIds];
  for (const id of sessionAdded) {
    if (!known.includes(id)) known.push(id);
  }
  return known;
}

/**
 * Member list for a group. `a` opens the picker to add (admins), `d` removes
 * with confirm (admins), Esc closes. Refreshes on group snapshots.
 * The picker accepts typed IDs via Ctrl+A (same modal as group creation);
 * validated ids merge into the same fresh-member filter before adding.
 */
export default memo(function GroupMembersModal({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addingById, setAddingById] = useState(false);
  // Ids added this session (both paths): keeps the typed-ID validator and
  // the picker's fresh-filter honest before the membership snapshot refreshes.
  const [sessionAdded, setSessionAdded] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>();
  const [highlight, setHighlight] = useState(0);
  const theme = getTheme();
  const ownId = getSessionUser()?.user_id;
  const group = getGroupCache(groupId);
  const members = getGroupMembers(groupId);
  const admin = ownId ? isGroupAdmin(groupId, ownId) : false;

  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    socketBus.on("groups_changed", refresh);
    return () => {
      socketBus.off("groups_changed", refresh);
    };
  }, []);
  void version;

  // Removals shrink the list under a stale highlight: clamp it so Enter/d
  // always land on a visible row.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, members.length - 1)));
  }, [members.length]);

  useInput((input, key) => {
    if (addingById) return;
    if (adding) {
      if (key.ctrl && (input === "a" || input === "\x01")) {
        setAddingById(true);
      }
      return;
    }
    if (confirmRemove) {
      // Explicit answers only: stray keys must neither remove nor dismiss,
      // or the (y/n) hint overpromises.
      if (input === "y") {
        client.removeMember(groupId, confirmRemove);
        setConfirmRemove(undefined);
      } else if (input === "n" || key.escape) {
        setConfirmRemove(undefined);
      }
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(Math.max(0, members.length - 1), h + 1));
      return;
    }
    if (input === "a" && admin) {
      setAdding(true);
      return;
    }
    if ((input === "d" || key.delete) && admin) {
      const target = members[Math.min(highlight, Math.max(0, members.length - 1))];
      if (target && target.user_id !== ownId) {
        setConfirmRemove(target.user_id);
      }
    }
  });

  if (!group) {
    return (
      <Box width={"60%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} paddingX={2} paddingY={1}>
        <Text dimColor>Group no longer available.</Text>
      </Box>
    );
  }

  if (adding) {
    const knownIds = mergeKnownIds(
      members.map((m) => m.user_id),
      sessionAdded
    );
    const trackAdded = (ids: string[]) => {
      setSessionAdded((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
    };
    if (addingById) {
      return (
        <Box width={"80%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} paddingX={2} paddingY={1} flexDirection="column">
          <Text bold>Add to {group.name}</Text>
          <Box marginTop={1}>
            <GroupAddIdModal
              picked={knownIds}
              onAdd={(id) => {
                trackAdded([id]);
                client.addMembers(groupId, [id]);
              }}
              onClose={() => setAddingById(false)}
            />
          </Box>
        </Box>
      );
    }
    return (
      <Box width={"80%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} paddingX={2} paddingY={1} flexDirection="column">
        <Text bold>Add to {group.name}</Text>
        <Text dimColor>Ctrl+A adds a raw ID</Text>
        <Box marginTop={1} height={10}>
          <ContactsBrowser
            pickMode
            excludePeerIds={members.map((m) => m.user_id)}
            onPick={(ids) => {
              const fresh = ids.filter(
                (id) => !members.some((m) => m.user_id === id)
              );
              if (fresh.length > 0) {
                trackAdded(fresh);
                client.addMembers(groupId, fresh);
              }
            }}
            onClose={() => setAdding(false)}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box width={"60%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>
        {group.name} ({members.length})
      </Text>
        <Text dimColor>{admin ? "a add · d/Del remove · Esc back" : "Esc back"}</Text>
      {confirmRemove ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Remove {displayNameFor(groupId, confirmRemove, null)}?</Text>
          <Text dimColor>(y/n)</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {members.map((m, i) => {
            const label = `${displayNameFor(groupId, m.user_id, null)}${
              m.role === "admin" ? " [admin]" : ""
            }${m.user_id === ownId ? " (you)" : ""}`;
            return i === highlight ? (
              <Text key={m.user_id} color={theme.roles.accent}>{`> ${label}`}</Text>
            ) : (
              <Text key={m.user_id} dimColor>{`  ${label}`}</Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
});
