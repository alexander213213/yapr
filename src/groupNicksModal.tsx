import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useEffect, useState } from "react";
import { getTheme } from "./themes.js";
import { useEditMode } from "./editMode.js";
import { socketBus } from "./eventStore.js";
import { client } from "./client.js";
import {
  displayNameFor,
  getGroupCache,
  getGroupMembers,
  getLatestAdvertisedNick,
  getMemberNick,
  getSessionUser,
  getSharedNick,
  isGroupAdmin,
  nickForContext,
  setMemberNick,
  setSharedNick,
} from "./store.js";

/** Nickname editor cap: 16 visible characters (grapheme-safe for emoji). */
export const NICK_MAX_GRAPHEMES = 16;

export function truncateNick(value: string): string {
  return Array.from(value.trim()).slice(0, NICK_MAX_GRAPHEMES).join("");
}

export type NickRowLabel = { shown: string; tag: string };

/**
 * Effective row label for the nicknames list. Precedence: personal override,
 * shared master, advertised name, contact alias, id. Self rows resolve the
 * advertised slot through nickForContext (own override or default nick when
 * sharing) because own messages file under the thread key, so the
 * message-row lookup (getLatestAdvertisedNick) can never hit for self —
 * without this everyone sees everyone else's name but never their own.
 * Pure over the store: unit-tested.
 */
export function nickRowLabel(
  groupId: string,
  userId: string,
  ownId: string | undefined
): NickRowLabel {
  const nick = getMemberNick(groupId, userId) ?? "";
  const advertised =
    userId === ownId
      ? nickForContext(groupId, userId)
      : getLatestAdvertisedNick(groupId, userId);
  const shown = nick || displayNameFor(groupId, userId, advertised);
  const tag = userId === ownId ? " (you)" : nick ? " (local)" : "";
  return { shown, tag };
}

/**
 * Per-member nicknames in one modal. Editing a row writes the personal
 * override instantly AND proposes it to the admin's shared record (pushed
 * back to everyone on merge); the admin's own edits apply to the master
 * directly. Blank clears the personal label (a blank proposal clears
 * shared state too). Rows render the effective name.
 */
export default memo(function GroupNicksModal({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const [membersVersion, setMembersVersion] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  useEditMode(editing !== undefined);
  const theme = getTheme();
  const ownId = getSessionUser()?.user_id;
  const group = getGroupCache(groupId);
  const members = getGroupMembers(groupId);
  void membersVersion;

  // Peer changes (admin edits, membership turnover) must reflect live,
  // like the members modal — plus shared-nick pushes from the admin.
  useEffect(() => {
    const refresh = () => setMembersVersion((v) => v + 1);
    socketBus.on("groups_changed", refresh);
    socketBus.on("nicks_changed", refresh);
    return () => {
      socketBus.off("groups_changed", refresh);
      socketBus.off("nicks_changed", refresh);
    };
  }, []);

  const [nickError, setNickError] = useState<string | undefined>();

  const currentNick = (userId: string): string => getMemberNick(groupId, userId) ?? "";

  /**
   * Submit a nickname edit: personal override instantly, then shared state.
   * Admins write the master directly and push (own row and others alike);
   * everyone else proposes to the admin. Unchanged values skip the network.
   */
  const submitNick = (targetId: string, raw: string) => {
    const clean = truncateNick(raw);
    setMemberNick(groupId, targetId, clean);
    setMembersVersion((x) => x + 1);
    setEditing(undefined);
    setNickError(undefined);
    const shared = getSharedNick(groupId, targetId)?.nick ?? null;
    if ((clean || null) === shared) return;
    const now = Date.now();
    const adminHere = ownId ? isGroupAdmin(groupId, ownId) : false;
    if (adminHere) {
      void (async () => {
        try {
          setSharedNick(groupId, targetId, clean || null, now);
          setMembersVersion((x) => x + 1);
          await client.pushNickUpdate(groupId, targetId, clean || null, now);
        } catch (err) {
          setNickError(err instanceof Error ? err.message : String(err));
        }
      })();
      return;
    }
    void (async () => {
      try {
        await client.proposeNick(groupId, targetId, clean || null);
      } catch (err) {
        setNickError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(undefined);
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
    if (key.return) {
      const target = members[Math.min(highlight, Math.max(0, members.length - 1))];
      if (target) {
        setDraft(currentNick(target.user_id));
        setEditing(target.user_id);
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

  return (
    <Box width={"60%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Nicknames in {group.name}</Text>
      <Text dimColor>Enter edits (max 16) · Esc stops editing, Esc again backs out · blank clears</Text>
      {nickError ? <Text color={theme.roles.error}>{nickError}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {members.map((m, i) => {
          const row = nickRowLabel(groupId, m.user_id, ownId);
          const label = `${row.shown}${row.tag}`;
          if (editing === m.user_id) {
            return (
              <Box key={m.user_id}>
                <Text color={theme.roles.accent}>{"> "}</Text>
                <TextInput
                  value={draft}
                  onChange={(v) => setDraft(truncateNick(v))}
                  focus={true}
                  placeholder="nickname"
                  onSubmit={(v) => submitNick(m.user_id, v)}
                />
              </Box>
            );
          }
          return i === highlight ? (
            <Text key={m.user_id} color={theme.roles.accent}>{`> ${label}`}</Text>
          ) : (
            <Text key={m.user_id} dimColor>{`  ${label}`}</Text>
          );
        })}
      </Box>
    </Box>
  );
});
