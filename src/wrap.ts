export function wrapText(
  text: string,
  maxWidth: number
): { lines: string[]; longest: number; raw: string[] } {
  if (maxWidth <= 0) return { lines: [], longest: 0, raw: [] };

  // Explicit newlines start new paragraphs (multiline input); each wraps alone.
  const raw: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      raw.push("");
      continue;
    }
    for (const wrapped of wrapParagraph(paragraph, maxWidth)) {
      raw.push(wrapped);
    }
  }

  // Find longest line
  let longest = 0;
  for (const line of raw) {
    if (line.length > longest) longest = line.length;
  }

  // Pad all lines to match longest
  const paddedLines = raw.map(line => line.padEnd(longest, " "));

  return {
    lines: paddedLines,
    longest,
    raw
  };
}

function wrapParagraph(text: string, maxWidth: number): string[] {
  const wrapped: string[] = [];
  let current = "";

  for (const word of text.split(" ")) {
    const candidate = current ? current + " " + word : word;

    if (candidate.length <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) wrapped.push(current);

    if (word.length <= maxWidth) {
      current = word;
    } else {
      let rest = word;
      while (rest.length > maxWidth) {
        wrapped.push(rest.slice(0, maxWidth));
        rest = rest.slice(maxWidth);
      }
      current = rest;
    }
  }

  if (current) wrapped.push(current);
  return wrapped;
}