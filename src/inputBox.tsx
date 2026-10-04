import { Box, Text, useInput } from "ink";
import { memo, useState } from "react";
import { getTheme } from "./themes.js";
import {
  cursorPosition,
  emptyEditor,
  eraseBackward,
  eraseForward,
  insertText,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  type EditorState,
} from "./editor.js";

const MAX_VISIBLE_LINES = 8;

/**
 * Multiline composer with LOCAL draft state (keystrokes never leave this box).
 * Enter submits; Ctrl+J inserts a newline everywhere; Shift+Enter does too on
 * terminals reporting it (kitty protocol — see index.ts render options).
 */
export default memo(function ChatInput({
  focused,
  onSubmit,
}: {
  focused: boolean;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<EditorState>(emptyEditor());
  const theme = getTheme();

  useInput((input, key) => {
    if (!focused) return;
    if (key.tab) return;
    if (key.return && !key.shift) {
      if (draft.text.trim()) {
        onSubmit(draft.text);
        setDraft(emptyEditor());
      }
      return;
    }
    if ((key.return && key.shift) || input === "\n") {
      setDraft((d) => insertText(d, "\n"));
      return;
    }
    if (key.backspace) {
      setDraft(eraseBackward);
      return;
    }
    if (key.delete) {
      setDraft(eraseForward);
      return;
    }
    if (key.leftArrow) {
      setDraft(moveLeft);
      return;
    }
    if (key.rightArrow) {
      setDraft(moveRight);
      return;
    }
    if (key.upArrow) {
      setDraft(moveUp);
      return;
    }
    if (key.downArrow) {
      setDraft(moveDown);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft((d) => insertText(d, input));
    }
  });

  const lines = draft.text.split("\n");
  const pos = cursorPosition(draft);
  const hidden = Math.max(0, lines.length - MAX_VISIBLE_LINES);
  const visible = lines.slice(hidden);
  const cursorLine = pos.line - hidden;

  return (
    <Box
      width={"100%"}
      paddingX={1}
      borderStyle={"round"}
      borderColor={focused ? theme.roles.borderFocused : theme.roles.borderDim}
      flexDirection="column"
    >
      {draft.text === "" ? (
        <Text dimColor>Enter to send · ^J newline</Text>
      ) : (
        <>
          {hidden > 0 ? <Text dimColor>↑ {hidden} more</Text> : null}
          {visible.map((line, i) => {
            if (focused && i === cursorLine) {
              const before = line.slice(0, pos.col);
              const at = line.slice(pos.col, pos.col + 1) || " ";
              const after = line.slice(pos.col + 1);
              return (
                <Text key={i}>
                  {before}
                  <Text inverse>{at}</Text>
                  {after}
                </Text>
              );
            }
            return <Text key={i}>{line === "" ? " " : line}</Text>;
          })}
        </>
      )}
    </Box>
  );
});
