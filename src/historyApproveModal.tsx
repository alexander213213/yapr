import { Box, Text, useInput } from "ink";
import { memo } from "react";
import { getTheme } from "./themes.js";
import { useBlockingModal } from "./editMode.js";
import { displayNameFor, getGroupCache } from "./store.js";
import { client } from "./client.js";

export type HistoryDecision = "approve" | "dismiss" | "ignore";

/** Explicit y/n only: stray keys must neither approve nor fall through. */
export function resolveHistoryKey(input: string): HistoryDecision {
  if (input === "y") return "approve";
  if (input === "n") return "dismiss";
  return "ignore";
}

/** Approve sharing recent thread history with a member who asked for it. */
export default memo(function HistoryApproveModal({
  groupId,
  requester,
  armed,
  onClose,
}: {
  groupId: string;
  requester: string;
  armed: boolean;
  onClose: () => void;
}) {
  const theme = getTheme();
  const group = getGroupCache(groupId);

  useBlockingModal(true);
  useInput((input, key) => {
    if (!armed) return;
    if (key.escape) {
      onClose();
      return;
    }
    const decision = resolveHistoryKey(input);
    if (decision === "approve") {
      void client.shareHistory(groupId, requester, 20).finally(() => onClose());
      return;
    }
    if (decision === "dismiss") {
      onClose();
      return;
    }
    // Ignore everything else: no approve, no dismiss, no fall-through.
  });

  return (
    <Box width={"60%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>
        Share history with {displayNameFor(groupId, requester, null)}?
      </Text>
      <Text dimColor>
        Sends your last 20 messages of {group?.name ?? "the group"}, re-encrypted for them. (y/n)
      </Text>
    </Box>
  );
});
