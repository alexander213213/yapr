import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Fresh isolated DB per run (store reads env lazily via db import).
const TEST_DIR = path.join(os.tmpdir(), `yapr-store-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const UID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

import {
  addNewContact,
  getUnreadCounts,
  insertIncomingMessage,
  insertPendingMessage,
  markThreadRead,
} from "./store.js";

describe("store threads", () => {
  it("tracks unread counts and flips threads read with ids", () => {
    const peer = `peer-${UID}`;
    const first = insertIncomingMessage(peer, `m1-${UID}`, "one", 1000);
    const second = insertIncomingMessage(peer, `m2-${UID}`, "two", 2000);
    expect(first.inserted && second.inserted).toBe(true);

    expect(getUnreadCounts()[peer]).toBe(2);

    const ids = markThreadRead(peer);
    expect([...ids].sort()).toEqual([`m1-${UID}`, `m2-${UID}`]);
    expect(getUnreadCounts()[peer] ?? 0).toBe(0);

    // Duplicate redelivery reports duplicate.
    expect(insertIncomingMessage(peer, `m1-${UID}`, "one", 1000)).toEqual({
      inserted: false,
      duplicate: true,
    });
  });

  it("queues outbox rows as pending", () => {
    const { clientMessageId } = insertPendingMessage("peer-x", "queued");
    expect(clientMessageId.length).toBeGreaterThan(0);
  });

  it("reports friendly contact constraint errors", () => {
    const id = `dup-${UID}`;
    expect(addNewContact(id, `Alias One ${UID}`)).toEqual({ ok: true });
    expect(addNewContact(id, `Alias Two ${UID}`)).toEqual({
      ok: false,
      message: "ID already exists in contacts.",
    });
    expect(addNewContact(`other-${UID}`, `Alias One ${UID}`)).toEqual({
      ok: false,
      message: "Alias already taken.",
    });
  });
});
