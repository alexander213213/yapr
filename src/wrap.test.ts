import { describe, expect, it } from "vitest";
import { wrapText } from "./wrap.js";

describe("wrapText", () => {
  it("returns no lines for non-positive widths", () => {
    expect(wrapText("hello", 0)).toEqual({ lines: [], longest: 0, raw: [] });
  });

  it("wraps on word boundaries and pads to the longest line", () => {
    const { lines, longest } = wrapText("aaa bb c", 4);
    expect(lines).toEqual(["aaa ", "bb c"]);
    expect(longest).toBe(4);
  });

  it("hard-splits words longer than the width", () => {
    const { lines } = wrapText("abcdef", 2);
    expect(lines).toEqual(["ab", "cd", "ef"]);
  });

  it("keeps short text on one line", () => {
    expect(wrapText("hi", 10).lines).toEqual(["hi"]);
  });

  it("keeps explicit newlines as paragraph breaks", () => {
    const { lines, longest } = wrapText("aaa bb\n\ncc dd", 4);
    expect(lines).toEqual(["aaa", "bb ", "   ", "cc ", "dd "]);
    expect(longest).toBe(3);
  });

  it("measures wide characters in terminal cells, not UTF-16 units", () => {
    // "日本" is 2 chars but 4 cells; longest must be cells.
    const { longest } = wrapText("日本", 10);
    expect(longest).toBe(4);
    const emoji = wrapText("hi 😀", 10);
    expect(emoji.longest).toBe(5);
  });

  it("never splits a wide character across lines", () => {
    // "a日b": widths 1+2+1; at maxWidth 3 the group packs as a日 | b.
    expect(wrapText("a日b", 3).raw).toEqual(["a日", "b"]);
    // "ab日c": ab fills 2 cells, 日 needs 2 more — moves whole.
    expect(wrapText("ab日c", 3).raw).toEqual(["ab", "日c"]);
  });

  it("pads to the widest line by cells", () => {
    const { lines } = wrapText("日本 x", 10);
    const widths = lines.map((l) => l.length);
    // "日本 x" is one line of 6 cells; padding is spaces.
    expect(lines).toEqual(["日本 x"]);
    expect(widths).toEqual([4]);
  });

  it("expands tabs deterministically", () => {
    const { raw } = wrapText("a\tb", 10);
    expect(raw).toEqual(["a  b"]);
  });

  it("normalizes CRLF line endings", () => {
    const { raw } = wrapText("a\r\nb\rc", 10);
    expect(raw).toEqual(["a", "b", "c"]);
  });
});
