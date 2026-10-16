import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// The modal pulls store (DB at import time), so pin an isolated dir first.
const TEST_DIR = path.join(os.tmpdir(), `yapr-nicks-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { NICK_MAX_GRAPHEMES, truncateNick, nickRowLabel } = await import("./groupNicksModal.js");
const store = await import("./store.js");

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

describe("nickRowLabel", () => {
  const tag = Date.now();
  const gid = `g-row-${tag}`;
  const self = `self-row-${tag}`;
  const other = `other-row-${tag}`;
  const seedSelf = () => {
    store.clearSession();
    store.saveSessionUser(self, "s3cret");
  };

  it("shows your own advertised default nick (message rows can't — out-rows file under the thread key)", () => {
    seedSelf();
    store.setSetting("nickname", "Alex");
    store.setSetting("share_nickname_gcs", "1");
    expect(nickRowLabel(gid, self, self)).toEqual({ shown: "Alex", tag: " (you)" });
  });

  it("prefers your personal override on your own row", () => {
    seedSelf();
    store.setSetting("nickname", "Alex");
    store.setSetting("share_nickname_gcs", "1");
    store.setMemberNick(gid, self, "Mine");
    expect(nickRowLabel(gid, self, self)).toEqual({ shown: "Mine", tag: " (you)" });
  });

  it("falls back to id for self when sharing is off and no override exists", () => {
    seedSelf();
    store.setSetting("nickname", "Alex");
    store.setSetting("share_nickname_gcs", "0");
    const gid2 = `g-row-off-${tag}`;
    expect(nickRowLabel(gid2, self, self)).toEqual({ shown: self, tag: " (you)" });
  });

  it("shows another member's advertised nick from their in-rows", () => {
    seedSelf();
    store.insertIncomingMessage(other, `row-adv-${tag}`, "hi", 1000, gid, "AdvNick");
    expect(nickRowLabel(gid, other, self)).toEqual({ shown: "AdvNick", tag: "" });
  });

  it("prefers the shared master over advertised for others", () => {
    seedSelf();
    store.setSharedNick(gid, other, "Shared", 1700000000000);
    expect(nickRowLabel(gid, other, self)).toEqual({ shown: "Shared", tag: "" });
  });

  it("shows a personal override with the local tag and falls back to id", () => {
    seedSelf();
    const stranger = `stranger-row-${tag}`;
    store.setMemberNick(gid, stranger, "Pet");
    expect(nickRowLabel(gid, stranger, self)).toEqual({ shown: "Pet", tag: " (local)" });
    const unknown = `unknown-row-${tag}`;
    const gid3 = `g-row-unknown-${tag}`;
    expect(nickRowLabel(gid3, unknown, self)).toEqual({ shown: unknown, tag: "" });
  });
});
