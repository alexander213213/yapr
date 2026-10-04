import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import { getSetting, setSetting, type SettingKey } from "./store.js";

type Row =
  | { kind: "text"; key: "nickname"; label: string }
  | { kind: "toggle"; key: "share_nickname_gcs" | "share_nickname_dms"; label: string };

const ROWS: Row[] = [
  { kind: "text", key: "nickname", label: "Nickname" },
  { kind: "toggle", key: "share_nickname_gcs", label: "Reveal nickname in groups" },
  { kind: "toggle", key: "share_nickname_dms", label: "Reveal nickname to new DMs" },
];

function toggleLabel(value: string): string {
  return value === "1" ? "[x]" : "[ ]";
}

/** Local settings (nickname, reveal toggles). All device-local, works offline. */
export default memo(function SettingsForm({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<SettingKey, string>>({
    nickname: getSetting("nickname"),
    share_nickname_gcs: getSetting("share_nickname_gcs"),
    share_nickname_dms: getSetting("share_nickname_dms"),
    theme: getSetting("theme"),
  });
  const [row, setRow] = useState(0);
  const [editing, setEditing] = useState(false);

  const current = ROWS[Math.min(row, ROWS.length - 1)];
  if (!current) return null;

  const commit = (key: SettingKey, value: string) => {
    setSetting(key, value);
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  useInput((input, key) => {
    if (key.escape) {
      if (editing) {
        setEditing(false);
        return;
      }
      onClose();
      return;
    }
    if (editing) return;
    if (key.upArrow) {
      setRow((r) => Math.max(0, r - 1));
      return;
    }
    if (key.downArrow) {
      setRow((r) => Math.min(ROWS.length - 1, r + 1));
      return;
    }
    if (key.return || input === " ") {
      if (current.kind === "toggle") {
        commit(current.key, values[current.key] === "1" ? "0" : "1");
      } else {
        setEditing(true);
      }
    }
  });

  return (
    <Box width={"60%"} borderColor={"#496b22"} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Settings</Text>
      <Text dimColor>local only · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {ROWS.map((r, i) => {
          const active = i === row;
          const prefix = active ? "> " : "  ";
          if (r.kind === "toggle") {
            const label = `${prefix}${r.label}: ${toggleLabel(values[r.key])}`;
            return active ? (
              <Text key={r.key} color={"#9a9e3f"}>{label}</Text>
            ) : (
              <Text key={r.key}>{label}</Text>
            );
          }
          const nameLabel = `${prefix}${r.label}: `;
          return (
            <Box key={r.key}>
              {active ? (
                <Text color={"#9a9e3f"}>{nameLabel}</Text>
              ) : (
                <Text>{nameLabel}</Text>
              )}
              {active && editing ? (
                <TextInput
                  value={values.nickname}
                  onChange={(v) => commit("nickname", v)}
                  focus={true}
                  placeholder="callsign"
                  onSubmit={() => setEditing(false)}
                />
              ) : (
                <Text dimColor>{values.nickname || "(unset)"}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});
