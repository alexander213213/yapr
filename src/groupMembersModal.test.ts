import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// The modal pulls store (DB at import time), so pin an isolated dir first.
const TEST_DIR = path.join(os.tmpdir(), `yapr-members-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { mergeKnownIds } = await import("./groupMembersModal.js");

describe("mergeKnownIds", () => {
  it("dedups server-confirmed ids instead of double-counting them", () => {
    // The reported bug: 2 members + 1 typed id showed "3 picked", then "4
    // picked" once the snapshot refresh included the new member.
    expect(mergeKnownIds(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
    expect(mergeKnownIds(["a", "b", "c"], ["c"])).toEqual(["a", "b", "c"]);
  });

  it("keeps members first, then genuinely fresh ids, singles only", () => {
    expect(mergeKnownIds(["a"], ["b", "c", "b"])).toEqual(["a", "b", "c"]);
    expect(mergeKnownIds([], [])).toEqual([]);
    expect(mergeKnownIds([], ["x"])).toEqual(["x"]);
    expect(mergeKnownIds(["a"], [])).toEqual(["a"]);
  });
});
