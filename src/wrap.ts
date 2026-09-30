export function wrapText(
  text: string,
  maxWidth: number
): { lines: string[]; longest: number } {
  if (maxWidth <= 0) return { lines: [], longest: 0 };

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(" ")) {
    const candidate = current ? current + " " + word : word;

    if (candidate.length <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    if (word.length <= maxWidth) {
      current = word;
    } else {
      let rest = word;
      while (rest.length > maxWidth) {
        lines.push(rest.slice(0, maxWidth));
        rest = rest.slice(maxWidth);
      }
      current = rest;
    }
  }

  if (current) lines.push(current);

  // Find longest line
  let longest = 0;
  for (const line of lines) {
    if (line.length > longest) longest = line.length;
  }

  // Pad all lines to match longest
  const paddedLines = lines.map(line => line.padEnd(longest, " "));

  return {
    lines: paddedLines,
    longest
  };
}