import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import { getTheme } from "./themes.js";

/** Confirmation phrase for account reset. Exact match, capitalization included. */
export const RESET_CONFIRM_PHRASE = "I Understand";

/** True only for the exact phrase — anything else, however close, is a no. */
export function isResetConfirmed(input: string): boolean {
  return input === RESET_CONFIRM_PHRASE;
}

/**
 * Destructive confirm step for account reset. Enter submits through the
 * focused field (gated on an exact match); Esc cancels. The parent owns
 * all other keys while this is mounted.
 */
export default memo(function AccountResetModal({
  onConfirm,
  onClose,
}: {
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const theme = getTheme();

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
    }
  });

  const submit = (value: string) => {
    if (!isResetConfirmed(value)) {
      setError(`Type exactly: ${RESET_CONFIRM_PHRASE}`);
      return;
    }
    setError(undefined);
    onConfirm();
  };

  return (
    <Box width={"65%"} borderColor={theme.roles.danger} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Reset account?</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>Your client registers a brand-new numeric ID on next connect.</Text>
        <Text dimColor>Kept: message history, contacts, identity key, settings.</Text>
        <Text dimColor>You must re-share your ID and be re-added to groups.</Text>
      </Box>
      <Box marginY={1} paddingX={1} borderStyle={"round"} borderColor={theme.roles.borderDim}>
        <Text>Type “{RESET_CONFIRM_PHRASE}”: </Text>
        <TextInput value={text} onChange={(v) => { setText(v); setError(undefined); }} placeholder={RESET_CONFIRM_PHRASE} focus={true} onSubmit={submit} />
      </Box>
      <Text dimColor>Enter confirms only on an exact match · Esc cancels</Text>
      {error ? <Text color={theme.roles.error}>{error}</Text> : null}
    </Box>
  );
});
