import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// The modal pulls store (DB at import time), so pin an isolated dir first.
const TEST_DIR = path.join(os.tmpdir(), `yapr-nicks-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { NICK_MAX_GRAPHEMES, truncateNick } = await import("./groupNicksModal.js");

describe("truncateNick", () => {
  it("caps at 16 graphemes", () => {
    expect(NICK_MAX_GRAPHEMES).toBe(16);
    expect(truncateNick("  Al  ")).toBe("Al");
    expect(truncateNick("x".repeat(20))).toBe("x".repeat(16));
    // Emoji count as one grapheme each, never split.
    expect(truncateNick("🙂".repeat(20))).toBe("🙂".repeat(16));
    expect(truncateNick("")).toBe("");
  });
});
