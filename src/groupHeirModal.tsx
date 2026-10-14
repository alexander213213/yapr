import { Box, Text, useInput } from "ink";
import { memo, useState } from "react";
import { getTheme } from "./themes.js";
import { displayNameFor, getGroupCache, getGroupMembers } from "./store.js";

/**
 * Heir picker for admin departure: the leaving admin must choose a successor
 * (the nickname master snapshot goes to them before the leave lands).
 * Enter picks, Esc cancels. Candidates exclude our own id.
 */
export default memo(function GroupHeirModal({
  groupId,
  ownId,
  onPick,
  onClose,
}: {
  groupId: string;
  ownId: string;
  onPick: (heirId: string) => void;
  onClose: () => void;
}) {
  const [highlight, setHighlight] = useState(0);
  const theme = getTheme();
  const group = getGroupCache(groupId);
  const candidates = getGroupMembers(groupId).filter((m) => m.user_id !== ownId);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(Math.max(0, candidates.length - 1), h + 1));
      return;
    }
    if (key.return) {
      const target = candidates[Math.min(highlight, Math.max(0, candidates.length - 1))];
      if (target) onPick(target.user_id);
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
      <Text bold>Choose your heir</Text>
      <Text dimColor>They inherit the admin role and nickname record · Enter picks · Esc back</Text>
      <Box marginTop={1} flexDirection="column">
        {candidates.length === 0 ? (
          <Text dimColor>No other members.</Text>
        ) : (
          candidates.map((m, i) => {
            const label = displayNameFor(groupId, m.user_id, null);
            return i === highlight ? (
              <Text key={m.user_id} color={theme.roles.accent}>{`> ${label}`}</Text>
            ) : (
              <Text key={m.user_id} dimColor>{`  ${label}`}</Text>
            );
          })
        )}
      </Box>
    </Box>
  );
});
