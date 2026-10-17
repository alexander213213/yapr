import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";
import { clearSession, getSetting, setSetting, type SettingKey } from "./store.js";
import { deleteReclaimToken, resolveDataDir } from "./storage.js";
import { client } from "./client.js";
import AccountResetModal from "./accountResetModal.js";
import { getTheme } from "./themes.js";
import { useEditMode } from "./editMode.js";

type Row =
  | { kind: "text"; key: "nickname"; label: string }
  | { kind: "toggle"; key: "share_nickname_gcs" | "share_nickname_dms"; label: string }
  | { kind: "cycle"; key: "time_format"; label: string }
  | { kind: "action"; key: "theme"; label: string }
  | { kind: "reset"; key: "reset"; label: string };

const ROWS: Row[] = [
  { kind: "text", key: "nickname", label: "Nickname" },
  { kind: "toggle", key: "share_nickname_gcs", label: "Reveal nickname in groups" },
  { kind: "toggle", key: "share_nickname_dms", label: "Reveal nickname to new DMs" },
  { kind: "action", key: "theme", label: "Theme" },
  { kind: "cycle", key: "time_format", label: "Time format" },
  { kind: "reset", key: "reset", label: "Reset account" },
];

function toggleLabel(value: string): string {
  return value === "1" ? "[x]" : "[ ]";
}

/** Nicknames render bare in sender headers: never store leading/trailing blanks. */
export function normalizeNickname(value: string): string {
  return value.trim();
}

/** Local settings (nickname, reveal toggles). All device-local, works offline. */
export default memo(function SettingsForm({
  onClose,
  onOpenThemePicker,
}: {
  onClose: () => void;
  onOpenThemePicker: () => void;
}) {
  const [values, setValues] = useState<Record<SettingKey, string>>({
    nickname: getSetting("nickname"),
    share_nickname_gcs: getSetting("share_nickname_gcs"),
    share_nickname_dms: getSetting("share_nickname_dms"),
    theme: getSetting("theme"),
    time_format: getSetting("time_format"),
    history_sync_pending: getSetting("history_sync_pending"),
    history_full_sync: getSetting("history_full_sync"),
  });
  const [row, setRow] = useState(0);
  const [editing, setEditing] = useState(false);
  // The reset confirm modal owns its keys while mounted (same pattern as
  // `editing` above): without this early return, Esc would leave Settings
  // instead of just dismissing the modal (Ink broadcasts to every handler).
  const [confirmingReset, setConfirmingReset] = useState(false);
  useEditMode(editing);
  const theme = getTheme();

  const current = ROWS[Math.min(row, ROWS.length - 1)];
  if (!current) return null;

  const commit = (key: SettingKey, value: string) => {
    setSetting(key, value);
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Drop the session (all rows) and the old recovery token, then reconnect:
   * with no session the client registers a brand-new id. Messages, contacts,
   * groups and the identity key are kept; group re-adding stays manual.
   */
  const doResetAccount = () => {
    clearSession();
    try {
      deleteReclaimToken(resolveDataDir());
    } catch {
      // Best effort; a stale token only matters if the server wipes again.
    }
    setConfirmingReset(false);
    onClose();
    client.stop();
    client.start();
  };

  useInput((input, key) => {
    if (confirmingReset) return;
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
      } else if (current.kind === "cycle") {
        commit(current.key, values[current.key] === "12" ? "24" : "12");
      } else if (current.kind === "reset") {
        setConfirmingReset(true);
      } else if (current.kind === "action") {
        onOpenThemePicker();
      } else {
        setEditing(true);
      }
    }
  });

  if (confirmingReset) {
    return (
      <AccountResetModal
        onConfirm={doResetAccount}
        onClose={() => setConfirmingReset(false)}
      />
    );
  }

  return (
    <Box width={"60%"} borderColor={theme.roles.borderFocused} borderStyle={"round"} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Settings</Text>
      <Text dimColor>local only · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {ROWS.map((r, i) => {
          const active = i === row;
          const prefix = active ? "> " : "  ";
          if (r.kind === "toggle") {
            const label = `${prefix}${r.label}: ${toggleLabel(values[r.key])} (Enter/Space flips)`;
            return active ? (
              <Text key={r.key} color={theme.roles.accent}>{label}</Text>
            ) : (
              <Text key={r.key}>{label}</Text>
            );
          }
          if (r.kind === "cycle") {
            const label = `${prefix}${r.label}: ${values[r.key]}-hour (Enter switches)`;
            return active ? (
              <Text key={r.key} color={theme.roles.accent}>{label}</Text>
            ) : (
              <Text key={r.key}>{label}</Text>
            );
          }
          if (r.kind === "action") {
            const label = `${prefix}${r.label}: ${values[r.key]} (Enter picks…)`;
            return active ? (
              <Text key={r.key} color={theme.roles.accent}>{label}</Text>
            ) : (
              <Text key={r.key}>{label}</Text>
            );
          }
          if (r.kind === "reset") {
            const label = `${prefix}${r.label}…`;
            return active ? (
              <Text key={r.key} color={theme.roles.danger}>{label}</Text>
            ) : (
              <Text key={r.key} dimColor>{label}</Text>
            );
          }
          const nameLabel = `${prefix}${r.label}: `;
          return (
            <Box key={r.key}>
              {active ? (
                <Text color={theme.roles.accent}>{nameLabel}</Text>
              ) : (
                <Text>{nameLabel}</Text>
              )}
              {active && editing ? (
                <TextInput
                  value={values.nickname}
                  onChange={(v) => commit("nickname", normalizeNickname(v))}
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
