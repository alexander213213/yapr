import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { memo, useState } from "react";
import { setSetting } from "./store.js";
import { BUILT_IN_THEMES, getTheme } from "./themes.js";
import { ThemedIndicator, ThemedItem } from "./themedSelect.js";

/**
 * Theme picker: list on the left, live role preview on the right.
 * Enter commits the highlighted theme, Esc cancels. Closing the modal
 * re-renders the app, so the new theme applies immediately.
 */
export default memo(function ThemePickerModal({ onDone }: { onDone: () => void }) {
  const chrome = getTheme();
  const current = chrome.name;
  const items = BUILT_IN_THEMES.map((t) => ({
    label: t.name === current ? `${t.name} (current)` : t.name,
    value: t.name,
  }));
  const initialIndex = Math.max(
    0,
    BUILT_IN_THEMES.findIndex((t) => t.name === current)
  );
  const [previewName, setPreviewName] = useState(current);
  const preview =
    BUILT_IN_THEMES.find((t) => t.name === previewName) ?? chrome;

  useInput((_input, key) => {
    if (key.escape) onDone();
  });

  return (
    <Box
      width={"70%"}
      borderColor={chrome.roles.borderFocused}
      borderStyle={"round"}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold>Theme</Text>
      <Text dimColor>Enter applies · Esc back</Text>
      <Box marginTop={1} flexDirection="row">
        <Box width={"40%"} flexDirection="column" marginRight={2}>
          <SelectInput
            isFocused={true}
            items={items}
            initialIndex={initialIndex}
            indicatorComponent={ThemedIndicator}
            itemComponent={ThemedItem}
            onHighlight={(item) => setPreviewName(item.value)}
            onSelect={(item) => {
              setSetting("theme", item.value);
              onDone();
            }}
          />
        </Box>
        <Box
          width={"60%"}
          borderStyle={"round"}
          borderColor={preview.roles.accent}
          flexDirection="column"
          paddingX={1}
        >
          <Text bold color={preview.roles.accent}>
            {preview.name}
          </Text>
          <Text>
            <Text color={preview.roles.e1}>e1 Aa </Text>
            <Text color={preview.roles.e2}>e2 Aa </Text>
            <Text color={preview.roles.e3}>e3 Aa</Text>
          </Text>
          <Text>
            <Text backgroundColor={preview.roles.codeBg}>{"`code`"}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text backgroundColor={preview.roles.pending} color={preview.roles.accent}>
                {" pending "}
              </Text>{" "}
              <Text backgroundColor={preview.roles.danger} color="white">
                {" danger "}
              </Text>
            </Text>
            <Text color={preview.roles.error}>error text</Text>
            <Text color={preview.roles.borderFocused}>focused border sample</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
});
