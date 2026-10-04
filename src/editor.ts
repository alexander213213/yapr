/**
 * Multiline draft state for the composer. Pure functions so the cursor and
 * line logic stay unit-tested; ChatInput owns rendering and key wiring.
 */
export type EditorState = { text: string; cursor: number };

export function emptyEditor(): EditorState {
  return { text: "", cursor: 0 };
}

export function insertText(state: EditorState, s: string): EditorState {
  if (!s) return state;
  const text = state.text.slice(0, state.cursor) + s + state.text.slice(state.cursor);
  return { text, cursor: state.cursor + s.length };
}

export function eraseBackward(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return {
    text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
    cursor: state.cursor - 1,
  };
}

export function eraseForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state;
  return {
    text: state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1),
    cursor: state.cursor,
  };
}

export function moveLeft(state: EditorState): EditorState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) };
}

export function moveRight(state: EditorState): EditorState {
  return { ...state, cursor: Math.min(state.text.length, state.cursor + 1) };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function moveVertical(state: EditorState, dir: -1 | 1): EditorState {
  const starts = lineStarts(state.text);
  let line = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (s !== undefined && s <= state.cursor) line = i;
  }
  const target = line + dir;
  if (target < 0 || target >= starts.length) return state;
  const lineStart = starts[line] ?? 0;
  const col = state.cursor - lineStart;
  const targetStart = starts[target] ?? state.text.length;
  const nextNl = state.text.indexOf("\n", targetStart);
  const targetEnd = nextNl === -1 ? state.text.length : nextNl;
  return { ...state, cursor: Math.min(targetStart + col, targetEnd) };
}

export function moveUp(state: EditorState): EditorState {
  return moveVertical(state, -1);
}

export function moveDown(state: EditorState): EditorState {
  return moveVertical(state, 1);
}

/** Split for rendering: lines plus the cursor's line/column. */
export function cursorPosition(state: EditorState): { line: number; col: number } {
  const upto = state.text.slice(0, state.cursor);
  const line = upto.split("\n").length - 1;
  const lastNl = upto.lastIndexOf("\n");
  return { line, col: state.cursor - lastNl - 1 };
}
