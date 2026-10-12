import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { MessageRow } from "./types.js";

// Isolated DB per run. Static imports evaluate BEFORE this body runs, so any
// module transitively opening the DB (messages -> store) must be loaded
// dynamically AFTER the env assignment.
const TEST_DIR = path.join(os.tmpdir(), `yapr-messages-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { messagesToLines } = await import("./messages.js");

function row(text: string): MessageRow {
  return {
    id: 1,
    peer_id: "peer-x",
    direction: "out",
    client_message_id: "cm-1",
    text,
    created_at: 1700000000000,
    status: "sent",
  };
}

/** Visible text of a rendered line (trailing bubble padding stripped). */
function visible(line: { segments: { text: string }[] }): string {
  return line.segments
    .map((s) => s.text)
    .join("")
    .replace(/ +$/, "");
}

describe("messagesToLines", () => {
  it("keeps single-line messages on one flagged line", () => {
    const lines = messagesToLines(row("hi"), 10, null);
    expect(lines).toHaveLength(1);
    expect(visible(lines[0]!)).toBe("hi");
    expect(lines[0]!.isFirstLine).toBe(true);
    expect(lines[0]!.isLastLine).toBe(true);
  });

  it("never leaks newlines into continuation lines (multiline drift)", () => {
    // Regression: offsets ran over the whole text while wrapText consumes
    // "\n", so every continuation line started with "\n" and lost its last char.
    const lines = messagesToLines(row("aaa\nbb"), 10, null);
    expect(lines).toHaveLength(2);
    expect(visible(lines[0]!)).toBe("aaa");
    expect(visible(lines[1]!)).toBe("bb");
    for (const line of lines) {
      for (const seg of line.segments) {
        expect(seg.text.startsWith("\n")).toBe(false);
      }
    }
    expect(lines[0]!.isFirstLine).toBe(true);
    expect(lines[1]!.isLastLine).toBe(true);
  });

  it("keeps styles aligned across paragraphs", () => {
    const lines = messagesToLines(row("hey $C1[you]\nthere **bud**"), 20, null);
    expect(lines).toHaveLength(2);
    expect(visible(lines[0]!)).toBe("hey you");
    expect(visible(lines[1]!)).toBe("there bud");
    expect(lines[0]!.segments.map((s) => s.style)).toEqual(["plain", "e1", "plain"]);
    expect(lines[1]!.segments.map((s) => s.style)).toEqual(["plain", "bold"]);
  });

  it("renders blank paragraphs as padded empty rows", () => {
    const lines = messagesToLines(row("a\n\nb"), 10, null);
    expect(lines).toHaveLength(3);
    expect(visible(lines[1]!)).toBe("");
    expect(visible(lines[2]!)).toBe("b");
  });

  it("survives tabs and CRLF without offset drift", () => {
    const lines = messagesToLines(row("a\tb\r\nc"), 10, null);
    expect(lines.map(visible)).toEqual(["a  b", "c"]);
  });

  it("never leads wrapped continuation lines with the eaten separator", () => {
    // Regression: wrap points consume one space, so length-accumulated
    // offsets sliced one char early — " bb " instead of "bb c".
    const lines = messagesToLines(row("aaa bb c"), 4, null);
    expect(lines).toHaveLength(2);
    expect(visible(lines[0]!)).toBe("aaa");
    expect(visible(lines[1]!)).toBe("bb c");
    const joined = lines[1]!.segments.map((s) => s.text).join("");
    expect(joined.startsWith(" ")).toBe(false);
  });

  it("keeps styles aligned across wrapped lines", () => {
    const lines = messagesToLines(row("hey $C1[you there friend]"), 8, null);
    expect(lines.map(visible)).toEqual(["hey you", "there", "friend"]);
    expect(lines[0]!.segments.map((s) => s.style)).toEqual(["plain", "e1"]);
    // Continuation lines carry the emphasis style with no leading separator.
    expect(lines[1]!.segments[0]).toEqual({ text: "there", style: "e1" });
    expect(lines[1]!.segments.map((s) => s.style)).toEqual(["e1", "plain"]);
    expect(lines[2]!.segments[0]).toEqual({ text: "friend", style: "e1" });
    expect(lines[2]!.segments.map((s) => s.style)).toEqual(["e1", "plain"]);
  });

  it("drops eaten leading blanks from indented first lines", () => {
    const lines = messagesToLines(row("  hi"), 10, null);
    expect(lines).toHaveLength(1);
    const joined = lines[0]!.segments.map((s) => s.text).join("");
    expect(joined.startsWith(" ")).toBe(false);
    expect(visible(lines[0]!)).toBe("hi");
  });
});
