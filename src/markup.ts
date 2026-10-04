/**
 * Minimal emphasis markup, parsed at render time:
 *   $C1[...] $C2[...] $C3[...]  (ordered emphasis, theme-colored)
 *   **bold**  `code`
 * A lone `*` needs no escape. `\` escapes `$`, `*` and backtick.
 * No nesting in v1: the first closing bracket ends the span; unclosed
 * openers render literally. Plaintext (with markers) is what gets
 * encrypted, stored and searched — styling is purely local.
 */
export type SegmentStyle = "plain" | "bold" | "code" | "e1" | "e2" | "e3";
export type Segment = { text: string; style: SegmentStyle };

const EMPHASIS: Record<string, SegmentStyle> = {
  $C1: "e1",
  $C2: "e2",
  $C3: "e3",
};

export function parseMarkup(input: string): Segment[] {
  const segments: Segment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      segments.push({ text: plain, style: "plain" });
      plain = "";
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === "$" || next === "*" || next === "`" || next === "\\") {
        plain += next;
        i += 2;
        continue;
      }
      plain += ch;
      i += 1;
      continue;
    }
    const marker3 = input.slice(i, i + 3);
    const style = EMPHASIS[marker3];
    if (style && input[i + 3] === "[") {
      const close = input.indexOf("]", i + 4);
      if (close !== -1) {
        flush();
        segments.push({ text: input.slice(i + 4, close), style });
        i = close + 1;
        continue;
      }
      plain += marker3;
      i += 3;
      continue;
    }
    if (input.startsWith("**", i)) {
      const close = input.indexOf("**", i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        segments.push({ text: input.slice(i + 2, close), style: "bold" });
        i = close + 2;
        continue;
      }
      plain += "**";
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        segments.push({ text: input.slice(i + 1, close), style: "code" });
        i = close + 1;
        continue;
      }
      plain += ch;
      i += 1;
      continue;
    }
    plain += ch ?? "";
    i += 1;
  }
  flush();
  return segments;
}

/** Visible text without any markers (width math, search previews). */
export function stripMarkup(input: string): string {
  return parseMarkup(input)
    .map((s) => s.text)
    .join("");
}

/** Slice styled runs by visible character offsets (re-applying styles post-wrap). */
export function sliceSegments(segments: Segment[], start: number, length: number): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const end = pos + seg.text.length;
    const from = Math.max(start, pos);
    const to = Math.min(start + length, end);
    if (from < to) {
      out.push({ text: seg.text.slice(from - pos, to - pos), style: seg.style });
    }
    pos = end;
  }
  return out;
}
