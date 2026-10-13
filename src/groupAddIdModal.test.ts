import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// The modal transitively opens the DB (via store at import time), so pin an
// isolated dir before the dynamic import below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-addid-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { validateMemberIdInput } = await import("./groupAddIdModal.js");

describe("validateMemberIdInput", () => {
  it("accepts a 12-digit id, trimmed", () => {
    expect(validateMemberIdInput("  123456789012  ", [], "999")).toEqual({
      ok: true,
      id: "123456789012",
    });
  });

  it("rejects non-numeric, short and long input", () => {
    for (const raw of ["alice", "1234abcd5678", "12345678", "1".repeat(16), "", "   "]) {
      const res = validateMemberIdInput(raw, [], "999");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/numeric/);
    }
  });

  it("rejects your own id", () => {
    const res = validateMemberIdInput("123456789012", [], "123456789012");
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/own ID/);
  });

  it("rejects already-picked ids", () => {
    const res = validateMemberIdInput("123456789012", ["123456789012"], "999");
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/Already picked/);
  });

  it("allows an empty own id (session unknown) without crashing", () => {
    expect(validateMemberIdInput("123456789012", [], "")).toEqual({
      ok: true,
      id: "123456789012",
    });
  });
});
