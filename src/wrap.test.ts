import { describe, expect, it } from "vitest";
import { wrapText } from "./wrap.js";

describe("wrapText", () => {
  it("returns no lines for non-positive widths", () => {
    expect(wrapText("hello", 0)).toEqual({ lines: [], longest: 0 });
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
});
