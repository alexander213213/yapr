import { describe, expect, it } from "vitest";
import { parseMarkup, sliceSegments, stripMarkup } from "./markup.js";

describe("parseMarkup", () => {
  it("leaves plain text alone (lone asterisks need no escape)", () => {
    expect(parseMarkup("2 * 3 = 6 and *star*")).toEqual([{ text: "2 * 3 = 6 and *star*", style: "plain" }]);
  });

  it("parses emphasis spans", () => {
    expect(parseMarkup("hey $C1[you] there")).toEqual([
      { text: "hey ", style: "plain" },
      { text: "you", style: "e1" },
      { text: " there", style: "plain" },
    ]);
    expect(parseMarkup("$C2[a] $C3[b]").map((s) => s.style)).toEqual(["e2", "plain", "e3"]);
  });

  it("parses bold and code spans", () => {
    expect(parseMarkup("a **bold** word")).toEqual([
      { text: "a ", style: "plain" },
      { text: "bold", style: "bold" },
      { text: " word", style: "plain" },
    ]);
    expect(parseMarkup("run `cmd` now")[1]).toEqual({ text: "cmd", style: "code" });
  });

  it("renders unclosed openers literally", () => {
    expect(parseMarkup("oops $C1[never")).toEqual([{ text: "oops $C1[never", style: "plain" }]);
    expect(parseMarkup("a **b b")).toEqual([{ text: "a **b b", style: "plain" }]);
    expect(parseMarkup("tick `tock")).toEqual([{ text: "tick `tock", style: "plain" }]);
  });

  it("does not nest (first closer wins, inner kept raw)", () => {
    expect(parseMarkup("$C1[a **b]")).toEqual([{ text: "a **b", style: "e1" }]);
  });

  it("honors backslash escapes", () => {
    expect(parseMarkup("\\$C1[x]")).toEqual([{ text: "$C1[x]", style: "plain" }]);
    expect(parseMarkup("\\*\\*literal\\*\\*")).toEqual([{ text: "**literal**", style: "plain" }]);
    expect(parseMarkup("back\\\\slash")).toEqual([{ text: "back\\slash", style: "plain" }]);
  });

  it("handles empty spans and adjacency", () => {
    expect(parseMarkup("$C1[]done")).toEqual([
      { text: "", style: "e1" },
      { text: "done", style: "plain" },
    ]);
    expect(parseMarkup("$C1[a]$C2[b]").map((s) => s.style)).toEqual(["e1", "e2"]);
  });

  it("strips markers for width math", () => {
    expect(stripMarkup("hey $C1[you] **there**")).toBe("hey you there");
  });

  it("slices styled runs by visible offsets", () => {
    const segs = parseMarkup("ab$C1[cde]f");
    expect(sliceSegments(segs, 2, 3)).toEqual([{ text: "cde", style: "e1" }]);
    expect(sliceSegments(segs, 0, 2)).toEqual([{ text: "ab", style: "plain" }]);
    expect(sliceSegments(segs, 1, 5)).toEqual([
      { text: "b", style: "plain" },
      { text: "cde", style: "e1" },
      { text: "f", style: "plain" },
    ]);
  });
});
