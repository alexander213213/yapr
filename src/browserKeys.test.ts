import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Both modules transitively open the DB (via store at import time), so pin
// an isolated dir before the dynamic imports below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-keys-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { resolveBrowserKey } = await import("./contactsBrowser.js");
const { resolveHistoryKey } = await import("./historyApproveModal.js");

describe("resolveBrowserKey", () => {
  it("fires manage-mode actions only outside filter mode", () => {
    const base = { ctrl: false, meta: false, pickMode: false, hasCurrent: true };
    expect(resolveBrowserKey({ ...base, input: "d", filtering: false })).toBe("delete");
    expect(resolveBrowserKey({ ...base, input: "e", filtering: false })).toBe("edit");
    expect(resolveBrowserKey({ ...base, input: "a", filtering: false })).toBe("add");
    // Typing "dan" must filter, never delete — even on the first keystroke.
    expect(resolveBrowserKey({ ...base, input: "d", filtering: true })).toBe("filter");
    expect(resolveBrowserKey({ ...base, input: "e", filtering: true })).toBe("filter");
    expect(resolveBrowserKey({ ...base, input: "a", filtering: true })).toBe("filter");
  });

  it("requires a current row for row actions", () => {
    const base = { ctrl: false, meta: false, pickMode: false, filtering: false, hasCurrent: false };
    expect(resolveBrowserKey({ ...base, input: "d" })).toBe("ignore");
    expect(resolveBrowserKey({ ...base, input: "e" })).toBe("ignore");
    expect(resolveBrowserKey({ ...base, input: "a" })).toBe("add");
  });

  it("always filters printable keys in picker mode", () => {
    const base = { ctrl: false, meta: false, pickMode: true, filtering: false, hasCurrent: true };
    expect(resolveBrowserKey({ ...base, input: "d" })).toBe("filter");
    expect(resolveBrowserKey({ ...base, input: "z" })).toBe("filter");
  });

  it("ignores control chords and multi-char input", () => {
    const base = { pickMode: true, filtering: false, hasCurrent: true };
    expect(resolveBrowserKey({ ...base, input: "d", ctrl: true, meta: false })).toBe("ignore");
    expect(resolveBrowserKey({ ...base, input: "", ctrl: false, meta: false })).toBe("ignore");
  });
});

describe("resolveHistoryKey", () => {
  it("accepts only explicit y/n", () => {
    expect(resolveHistoryKey("y")).toBe("approve");
    expect(resolveHistoryKey("n")).toBe("dismiss");
    expect(resolveHistoryKey("s")).toBe("ignore");
    expect(resolveHistoryKey("q")).toBe("ignore");
    expect(resolveHistoryKey("")).toBe("ignore");
  });
});
