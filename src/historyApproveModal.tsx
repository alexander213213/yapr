import { Box, Text, useInput } from "ink";
import { memo } from "react";
import { getTheme } from "./themes.js";
import { displayNameFor, getGroupCache } from "./store.js";
import { client } from "./client.js";

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

  useInput((input) => {
    if (!armed) return;
    if (input === "y") {
      void client.shareHistory(groupId, requester, 20).finally(() => onClose());
      return;
    }
    onClose();
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
