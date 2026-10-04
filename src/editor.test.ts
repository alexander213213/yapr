import { describe, expect, it } from "vitest";
import {
  cursorPosition,
  emptyEditor,
  eraseBackward,
  eraseForward,
  insertText,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
} from "./editor.js";

describe("editor", () => {
  it("inserts and moves the cursor", () => {
    let st = emptyEditor();
    st = insertText(st, "hi");
    expect(st).toEqual({ text: "hi", cursor: 2 });
    st = moveLeft(st);
    st = insertText(st, "X");
    expect(st).toEqual({ text: "hXi", cursor: 2 });
  });

  it("erases backward across newlines", () => {
    let st = { text: "a\nb", cursor: 2 };
    st = eraseBackward(st);
    expect(st).toEqual({ text: "ab", cursor: 1 });
    st = eraseBackward(eraseBackward(st));
    expect(st).toEqual({ text: "b", cursor: 0 });
  });

  it("erases forward without moving", () => {
    expect(eraseForward({ text: "ab", cursor: 0 })).toEqual({ text: "b", cursor: 0 });
    expect(eraseForward({ text: "ab", cursor: 2 })).toEqual({ text: "ab", cursor: 2 });
  });

  it("clamps horizontal movement", () => {
    expect(moveLeft({ text: "ab", cursor: 0 }).cursor).toBe(0);
    expect(moveRight({ text: "ab", cursor: 2 }).cursor).toBe(2);
  });

  it("moves vertically with column memory", () => {
    const st = { text: "abcd\ne\nfghij", cursor: 3 };
    expect(moveDown(st)).toEqual({ text: "abcd\ne\nfghij", cursor: 6 });
    expect(moveUp(moveDown(st))).toEqual({ text: "abcd\ne\nfghij", cursor: 1 });
    expect(moveUp({ text: "ab", cursor: 1 })).toEqual({ text: "ab", cursor: 1 });
  });

  it("locates the cursor line and column", () => {
    expect(cursorPosition({ text: "ab\ncde", cursor: 5 })).toEqual({ line: 1, col: 2 });
  });
});
