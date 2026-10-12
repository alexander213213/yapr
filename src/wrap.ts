import stringWidth from "string-width";

/** One wrapped line plus its start offset in the (normalized) source text. */
export type WrappedLine = { text: string; start: number };

export function wrapText(
  text: string,
  maxWidth: number
): { lines: string[]; longest: number; raw: string[]; starts: number[] } {
  if (maxWidth <= 0) return { lines: [], longest: 0, raw: [], starts: [] };

  // Normalize line endings; expand tabs (terminal tab stops are unpredictable).
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");

  // Explicit newlines start new paragraphs (multiline input); each wraps alone.
  const raw: string[] = [];
  const starts: number[] = [];
  let paraStart = 0;
  for (const paragraph of normalized.split("\n")) {
    if (paragraph === "") {
      raw.push("");
      starts.push(paraStart);
    } else {
      for (const wrapped of wrapParagraph(paragraph, maxWidth)) {
        raw.push(wrapped.text);
        starts.push(paraStart + wrapped.start);
      }
    }
    paraStart += paragraph.length + 1; // +1 for the consumed "\n"
  }

  // Find longest line in TERMINAL CELLS (wide chars count double).
  let longest = 0;
  for (const line of raw) {
    const w = stringWidth(line);
    if (w > longest) longest = w;
  }

  // Pad all lines to match longest (by width, not characters).
  const paddedLines = raw.map((line) => line + " ".repeat(Math.max(0, longest - stringWidth(line))));

  return {
    lines: paddedLines,
    longest,
    raw,
    starts,
  };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Split a string into chunks of at most maxWidth cells, never splitting a
 * grapheme cluster (ZWJ emoji sequences, flag pairs, combining marks stay
 * whole — splitting them renders tofu/orphaned halves).
 */
function splitByWidth(word: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let width = 0;
  for (const { segment } of segmenter.segment(word)) {
    const w = Math.max(1, stringWidth(segment));
    if (width + w > maxWidth && current) {
      chunks.push(current);
      current = "";
      width = 0;
    }
    current += segment;
    width += w;
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapParagraph(text: string, maxWidth: number): WrappedLine[] {
  const wrapped: WrappedLine[] = [];
  let current = "";
  let currentWidth = 0;
  // Start index (into text) of the first contributing word of the current
  // line; null while nothing visible has been added yet.
  let lineStart: number | null = null;
  // Start index of the word being processed. Separators are single spaces,
  // so positions advance by word length + 1.
  let pos = 0;
  const push = () => {
    wrapped.push({ text: current, start: lineStart ?? pos });
    current = "";
    currentWidth = 0;
    lineStart = null;
  };

  for (const word of text.split(" ")) {
    const wordStart = pos;
    pos += word.length + 1;
    const wordWidth = stringWidth(word);
    const separatorWidth = current ? 1 : 0;
    if (currentWidth + separatorWidth + wordWidth <= maxWidth) {
      // A word contributes visible chars when it is non-empty or a separator
      // is emitted for it. Leading empty words add nothing, so the line
      // starts at the first real word — matching the rendered text exactly.
      if (lineStart === null && (word.length > 0 || current.length > 0)) {
        lineStart = wordStart;
      }
      current = current ? current + " " + word : word;
      currentWidth += separatorWidth + wordWidth;
      continue;
    }

    if (current) push();

    if (wordWidth <= maxWidth) {
      current = word;
      currentWidth = wordWidth;
      lineStart = word.length > 0 ? wordStart : null;
    } else {
      const parts = splitByWidth(word, maxWidth);
      let sub = wordStart;
      for (const part of parts.slice(0, -1)) {
        wrapped.push({ text: part, start: sub });
        sub += part.length;
      }
      current = parts[parts.length - 1] ?? "";
      currentWidth = stringWidth(current);
      lineStart = current.length > 0 ? sub : null;
    }
  }

  if (current) wrapped.push({ text: current, start: lineStart ?? pos });
  return wrapped;
}
