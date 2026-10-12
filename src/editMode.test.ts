import { describe, expect, it } from "vitest";
import {
  beginBlock,
  beginEdit,
  endBlock,
  endEdit,
  isBlocked,
  isEditingText,
} from "./editMode.js";

describe("editMode counters", () => {
  it("tracks text editing with balanced begin/end", () => {
    expect(isEditingText()).toBe(false);
    beginEdit();
    beginEdit();
    expect(isEditingText()).toBe(true);
    endEdit();
    expect(isEditingText()).toBe(true);
    endEdit();
    expect(isEditingText()).toBe(false);
  });

  it("floors at zero on unbalanced ends", () => {
    endEdit();
    endEdit();
    expect(isEditingText()).toBe(false);
    beginEdit();
    endEdit();
    endEdit();
    expect(isEditingText()).toBe(false);
  });

  it("tracks modal blocking independently", () => {
    expect(isBlocked()).toBe(false);
    beginBlock();
    expect(isBlocked()).toBe(true);
    expect(isEditingText()).toBe(false);
    endBlock();
    expect(isBlocked()).toBe(false);
    endBlock();
    expect(isBlocked()).toBe(false);
  });
});
