import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import { getSessionUser } from "./store.js";
import { getTheme } from "./themes.js";

export type MemberIdValidation = { ok: true; id: string } | { ok: false; error: string };

/**
 * Validate a manually typed group-member id. User ids are 12-digit numerics;
 * the range check catches typos at entry (the server re-validates anyway, and
 * unknown ids now fail visibly instead of hanging). Pure: unit-tested.
 */
export function validateMemberIdInput(
  raw: string,
  picked: string[],
  ownId: string
): MemberIdValidation {
  const id = raw.trim();
  if (!/^\d{9,15}$/.test(id)) {
    return { ok: false, error: "Enter a numeric user ID (9–15 digits)" };
  }
  if (ownId !== "" && id === ownId) {
    return { ok: false, error: "That's your own ID — you're already in" };
  }
  if (picked.includes(id)) {
    return { ok: false, error: "Already picked" };
  }
  return { ok: true, id };
}

/**
 * Add-by-ID step for group creation. Separate modal by design: the picker's
 * printable keys all feed its live filter, so typed entry needs its own
 * focused field. Added ids are picker-only (never saved as contacts).
 * Enter adds and stays for rapid entry; Esc returns to picking.
 */
export default memo(function GroupAddIdModal({
  picked,
  onAdd,
  onClose,
}: {
  picked: string[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const theme = getTheme();

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
    }
    // Enter submits through the focused TextInput below; Tab is ignored here.
  });

  const submit = (value: string) => {
    const ownId = getSessionUser()?.user_id ?? "";
    const res = validateMemberIdInput(value, picked, ownId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(undefined);
    setText("");
    onAdd(res.id);
  };

  return (
    <Box width={"60%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>
        Add by ID
        {picked.length > 0 ? <Text dimColor> · {picked.length} picked</Text> : null}
      </Text>
      <Box marginY={1} paddingX={1} borderStyle={"round"} borderColor={theme.roles.borderDim}>
        <Text>ID: </Text>
        <TextInput value={text} onChange={setText} placeholder="123456789012" focus={true} onSubmit={submit} />
      </Box>
      <Text dimColor>Enter adds · Esc done</Text>
      {error ? <Text color={theme.roles.error}>{error}</Text> : null}
    </Box>
  );
});
