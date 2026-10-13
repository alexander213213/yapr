import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  loadReclaimToken,
  reclaimPathFor,
  resolveDataDir,
  saveReclaimToken,
} from "./storage.js";

function freshDir(): string {
  const dir = path.join(os.tmpdir(), `yapr-reclaim-test-${process.pid}-${Date.now()}-${Math.random()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("reclaim token storage", () => {
  it("round-trips a token through the data dir", () => {
    const dir = freshDir();
    expect(loadReclaimToken(dir)).toBeNull();
    saveReclaimToken(dir, "dG9rZW4=");
    expect(loadReclaimToken(dir)).toBe("dG9rZW4=");
    expect(reclaimPathFor(dir)).toBe(path.join(dir, "reclaim.token"));
  });

  it("rejects missing, empty and non-token file contents", () => {
    const dir = freshDir();
    expect(loadReclaimToken(dir)).toBeNull();
    fs.writeFileSync(reclaimPathFor(dir), "\n");
    expect(loadReclaimToken(dir)).toBeNull();
    fs.writeFileSync(reclaimPathFor(dir), "has spaces in it");
    expect(loadReclaimToken(dir)).toBeNull();
    fs.writeFileSync(reclaimPathFor(dir), "x".repeat(513));
    expect(loadReclaimToken(dir)).toBeNull();
  });

  it("resolves the data dir from YAPR_DATA_DIR", () => {
    const prev = process.env.YAPR_DATA_DIR;
    try {
      process.env.YAPR_DATA_DIR = freshDir();
      expect(resolveDataDir()).toBe(process.env.YAPR_DATA_DIR);
    } finally {
      if (prev === undefined) delete process.env.YAPR_DATA_DIR;
      else process.env.YAPR_DATA_DIR = prev;
    }
  });
});
