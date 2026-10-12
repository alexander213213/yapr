import { Box, Text } from "ink";
import { getTheme } from "./themes.js";

/**
 * ink-select-input overrides in the active theme accent. The library's
 * defaults hardcode blue, which is why sidebar/picker highlights ignored
 * every theme. Shared so the lists can't drift apart again.
 */
export function ThemedItem({ isSelected = false, label }: { isSelected?: boolean; label: string }) {
  const theme = getTheme();
  if (!isSelected) return <Text>{label}</Text>;
  return <Text color={theme.roles.accent}>{label}</Text>;
}

export function ThemedIndicator({ isSelected = false }: { isSelected?: boolean }) {
  const theme = getTheme();
  return (
    <Box marginRight={1}>
      {isSelected ? <Text color={theme.roles.accent}>❯</Text> : <Text> </Text>}
    </Box>
  );
}
