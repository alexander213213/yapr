import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import { getTheme } from "./themes.js";
import {
  displayNameFor,
  getGroupCache,
  getGroupMembers,
  getMemberNick,
  getSessionUser,
  setMemberNick,
} from "./store.js";

/**
 * Per-member nicknames in one modal: your own row sets the nick you advertise
 * to the group (inside encrypted envelopes); any other row sets a local pet
 * name (display-only, never sent). Blank clears back to fallbacks.
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
  const theme = getTheme();
  const ownId = getSessionUser()?.user_id;
  const group = getGroupCache(groupId);
  const members = getGroupMembers(groupId);
  void membersVersion;

  const currentNick = (userId: string): string => getMemberNick(groupId, userId) ?? "";

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
      <Text dimColor>Enter edits · Esc back · blank clears</Text>
      <Box marginTop={1} flexDirection="column">
        {members.map((m, i) => {
          const nick = currentNick(m.user_id);
          const shown = nick || displayNameFor(groupId, m.user_id, null);
          const tag = m.user_id === ownId ? " (you — advertised)" : " (local label)";
          const label = `${shown}${tag}`;
          if (editing === m.user_id) {
            return (
              <Box key={m.user_id}>
                <Text color={theme.roles.accent}>{"> "}</Text>
                <TextInput
                  value={draft}
                  onChange={setDraft}
                  focus={true}
                  placeholder="nickname"
                  onSubmit={(v) => {
                    setMemberNick(groupId, m.user_id, v);
                    setMembersVersion((x) => x + 1);
                    setEditing(undefined);
                  }}
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
