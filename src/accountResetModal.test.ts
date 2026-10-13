import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// The modal pulls themes (which read settings via the store), so pin an
// isolated dir before the dynamic import below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-reset-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { RESET_CONFIRM_PHRASE, isResetConfirmed } = await import("./accountResetModal.js");

describe("isResetConfirmed", () => {
  it("accepts only the exact phrase", () => {
    expect(RESET_CONFIRM_PHRASE).toBe("I Understand");
    expect(isResetConfirmed("I Understand")).toBe(true);
  });

  it("rejects near-misses, casing included", () => {
    for (const raw of [
      "",
      "i understand",
      "I UNDERSTAND",
      "I understand",
      "I Understand ",
      " I Understand",
      "IUnderstand",
      "I Understand.",
      "yes",
    ]) {
      expect(isResetConfirmed(raw)).toBe(false);
    }
  });
});
