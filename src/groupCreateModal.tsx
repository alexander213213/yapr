import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useRef, useState } from "react";
import ContactsBrowser from "./contactsBrowser.js";
import GroupAddIdModal from "./groupAddIdModal.js";
import { getTheme } from "./themes.js";
import { useEditMode } from "./editMode.js";
import { client } from "./client.js";

/**
 * Group creation: name first, then member picking, with an add-by-ID step.
 * Esc in the picker returns to the name step; Enter on the name confirms.
 * Printable keys feed the picker's live filter, so typed-ID entry lives in
 * its own modal on Ctrl+A (reached without disturbing the filter text).
 */
export default memo(function GroupCreateModal({ onDone }: { onDone: (groupId: string | null) => void }) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"name" | "pick" | "addId">("name");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  // In-flight guard: repeat Tabs/Enters while the server round-trips must not
  // stack duplicate creates (each would burn group-limiter budget). The ref is
  // the guard (state lags across rapid keypresses); the state drives the hint.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  useEditMode(phase === "name" || phase === "addId");
  const theme = getTheme();

  useInput((input, key) => {
    if (phase === "addId") {
      // The ID modal owns its keys (Enter submits, Esc closes).
      return;
    }
    if (phase !== "name") {
      // Ctrl+A opens typed-ID entry: ctrl-modified input never reaches the
      // picker's live filter, so the filter text is undisturbed.
      if (key.ctrl && (input === "a" || input === "\x01") && !creatingRef.current) {
        setPhase("addId");
        return;
      }
      // Pick phase: Tab confirms (App ignores Tab outside the chat view).
      // Single-flight: ignored while a create is already in flight.
      if (key.tab && !creatingRef.current) {
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
    if (!clean || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(undefined);
    try {
      const groupId = await client.createGroup(clean, picked);
      onDone(groupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      creatingRef.current = false;
      setCreating(false);
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
      ) : phase === "addId" ? (
        <GroupAddIdModal
          picked={picked}
          onAdd={(id) => setPicked((prev) => (prev.includes(id) ? prev : [...prev, id]))}
          onClose={() => setPhase("pick")}
        />
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
          <Text dimColor>{creating ? "Creating…" : "Enter adds · Ctrl+A add by ID · Esc back · Tab creates"}</Text>
          {error ? <Text color={theme.roles.error}>{error}</Text> : null}
        </>
      )}
    </Box>
  );
});
