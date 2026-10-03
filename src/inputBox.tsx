import { Box } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";

/**
 * Message composer with LOCAL draft state. Keystrokes re-render only this box —
 * previously the draft lived in App, so every key re-rendered the sidebar,
 * thread, header and modal tree (visible full-screen flicker).
 */
export default memo(function ChatInput({
  focused,
  onSubmit,
}: {
  focused: boolean;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <Box
      width={"100%"}
      paddingX={1}
      borderStyle={"round"}
      borderColor={focused ? "#496b22" : "#0e450b"}
    >
      <TextInput
        value={value}
        onChange={setValue}
        focus={focused}
        placeholder="Enter Your Message Here"
        onSubmit={(submitted) => {
          const text = submitted.trim();
          if (!text) return;
          onSubmit(text);
          setValue("");
        }}
      />
    </Box>
  );
});
