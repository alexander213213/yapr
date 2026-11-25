import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// client opens the DB at import time: pin an isolated dir first.
const TEST_DIR = path.join(os.tmpdir(), `yapr-nicktrust-test-${process.pid}-${Date.now()}`);
const PEER_DIR = path.join(os.tmpdir(), `yapr-nicktrust-peer-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { client } = await import("./client.js");
const store = await import("./store.js");
const { loadOrCreateIdentity, sealText } = await import("./crypto.js");
type NickPayload = import("./crypto.js").NickPayload;

const dispatch = (client as unknown as { dispatch: (f: object) => void }).dispatch.bind(client);
const settle = () => new Promise((r) => setTimeout(r, 50));

/** A group where `admin` administers, `member` doesn't, and we receive. */
function setup() {
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const me = `me-${tag}`;
  const admin = `admin-${tag}`;
  const member = `member-${tag}`;
  const gid = `g-${tag}`;
  const mePub = loadOrCreateIdentity().publicKeyB64;
  store.clearSession();
  store.saveSessionUser(me, "s3cret");
  process.env.YAPR_DATA_DIR = PEER_DIR;
  const peerPub = loadOrCreateIdentity().publicKeyB64;
  process.env.YAPR_DATA_DIR = TEST_DIR;
  // Both peers share one key pair here; attribution comes from `from`.
  store.setPeerKey(admin, peerPub);
  store.setPeerKey(member, peerPub);
  store.upsertGroupCache(gid, "G", [
    { user_id: admin, role: "admin", joined_at: 1 },
    { user_id: member, role: "member", joined_at: 1 },
    { user_id: me, role: "member", joined_at: 1 },
  ]);
  const send = async (from: string, kind: NickPayload) => {
    process.env.YAPR_DATA_DIR = PEER_DIR;
    const env = sealText(mePub, from, me, "", "", undefined, kind);
    process.env.YAPR_DATA_DIR = TEST_DIR;
    dispatch({ v: 2, type: "incoming", from, messageId: `m-${Math.random()}`, timestamp: 1, groupId: gid, ...env });
    await settle();
  };
  return { gid, admin, member, send };
}

describe("shared nickname trust", () => {
  it("applies nick updates from the admin", async () => {
    const { gid, admin, member, send } = setup();
    await send(admin, { kind: "nick-update", target: member, nick: "Bee", updatedAt: 10 });
    expect(store.getSharedNick(gid, member)).toEqual({ nick: "Bee", updatedAt: 10 });
  });

  it("ignores nick updates from a non-admin member", async () => {
    const { gid, admin, member, send } = setup();
    await send(member, { kind: "nick-update", target: admin, nick: "Clown", updatedAt: Number.MAX_SAFE_INTEGER });
    expect(store.getSharedNick(gid, admin)).toBeNull();
  });

  it("lets a non-admin snapshot fill blanks but never overwrite", async () => {
    const { gid, admin, member, send } = setup();
    store.setSharedNick(gid, admin, "Boss", 5);
    await send(member, {
      kind: "nick-snapshot",
      nicks: [
        { userId: admin, nick: "Clown", updatedAt: 999 },
        { userId: member, nick: "Me", updatedAt: 3 },
      ],
    });
    expect(store.getSharedNick(gid, admin)).toEqual({ nick: "Boss", updatedAt: 5 });
    expect(store.getSharedNick(gid, member)).toEqual({ nick: "Me", updatedAt: 3 });
  });
});
