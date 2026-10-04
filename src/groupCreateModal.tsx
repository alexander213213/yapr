import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import ContactsBrowser from "./contactsBrowser.js";
import { getTheme } from "./themes.js";
import { client } from "./client.js";

/**
 * Two-phase group creation: name first, then member picking.
 * Esc in the picker returns to the name step; Enter on the name confirms.
 */
export default memo(function GroupCreateModal({ onDone }: { onDone: (groupId: string | null) => void }) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"name" | "pick">("name");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const theme = getTheme();

  useInput((input, key) => {
    if (phase !== "name") {
      // Pick phase: Tab confirms (App ignores Tab outside the chat view).
      if (key.tab) {
        void confirm();
      }
      return;
    }
    if (key.escape) {
      onDone(null);
    }
  });

  const confirm = async () => {
    const clean = name.trim();
    if (!clean) return;
    try {
      const groupId = await client.createGroup(clean, picked);
      onDone(groupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Box width={"70%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>New group</Text>
      {phase === "name" ? (
        <>
          <Box marginY={1} paddingX={1} borderStyle={"round"} borderColor={theme.roles.borderDim}>
            <Text>Name: </Text>
            <TextInput value={name} onChange={setName} placeholder="Family chat" focus={true} onSubmit={() => setPhase("pick")} />
          </Box>
          <Text dimColor>Enter continues to members · Esc cancels</Text>
          {error ? <Text color={theme.roles.error}>{error}</Text> : null}
        </>
      ) : (
        <>
          <Text>
            Adding to <Text bold>{name || "(unnamed)"}</Text>
            {picked.length > 0 ? <Text dimColor> · {picked.length} picked</Text> : null}
          </Text>
          <Box marginTop={1} height={12}>
            <ContactsBrowser
              pickMode
              excludePeerIds={[]}
              onPick={(ids) => setPicked(ids)}
              onClose={() => setPhase("name")}
            />
          </Box>
          <Text dimColor>Enter adds · Esc back · Tab creates with picked members</Text>
          {error ? <Text color={theme.roles.error}>{error}</Text> : null}
        </>
      )}
    </Box>
  );
});
