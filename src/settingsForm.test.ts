import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// settingsForm transitively opens the DB (via store at import time), so load
// it dynamically AFTER pointing at an isolated dir — same pattern as store.test.ts.
const TEST_DIR = path.join(os.tmpdir(), `yapr-settings-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { normalizeNickname } = await import("./settingsForm.js");

describe("normalizeNickname", () => {
  it("strips leading and trailing blanks", () => {
    expect(normalizeNickname("  Al  ")).toBe("Al");
    expect(normalizeNickname("\tAl\n")).toBe("Al");
  });

  it("leaves interior text untouched", () => {
    expect(normalizeNickname("Al Pacino")).toBe("Al Pacino");
    expect(normalizeNickname("")).toBe("");
  });
});
