import stringWidth from "string-width";

export function wrapText(
  text: string,
  maxWidth: number
): { lines: string[]; longest: number; raw: string[] } {
  if (maxWidth <= 0) return { lines: [], longest: 0, raw: [] };

  // Normalize line endings; expand tabs (terminal tab stops are unpredictable).
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");

  // Explicit newlines start new paragraphs (multiline input); each wraps alone.
  const raw: string[] = [];
  for (const paragraph of normalized.split("\n")) {
    if (paragraph === "") {
      raw.push("");
      continue;
    }
    for (const wrapped of wrapParagraph(paragraph, maxWidth)) {
      raw.push(wrapped);
    }
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
  };
}

/** Split a string into chunks of at most maxWidth cells, never splitting a char. */
function splitByWidth(word: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let width = 0;
  for (const ch of word) {
    const w = Math.max(1, stringWidth(ch));
    if (width + w > maxWidth && current) {
      chunks.push(current);
      current = "";
      width = 0;
    }
    current += ch;
    width += w;
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapParagraph(text: string, maxWidth: number): string[] {
  const wrapped: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const word of text.split(" ")) {
    const wordWidth = stringWidth(word);
    const separatorWidth = current ? 1 : 0;
    if (currentWidth + separatorWidth + wordWidth <= maxWidth) {
      current = current ? current + " " + word : word;
      currentWidth += separatorWidth + wordWidth;
      continue;
    }

    if (current) wrapped.push(current);

    if (wordWidth <= maxWidth) {
      current = word;
      currentWidth = wordWidth;
    } else {
      const parts = splitByWidth(word, maxWidth);
      for (const part of parts.slice(0, -1)) {
        wrapped.push(part);
      }
      current = parts[parts.length - 1] ?? "";
      currentWidth = stringWidth(current);
    }
  }

  if (current) wrapped.push(current);
  return wrapped;
}
