import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

// Isolate identity files from the real user data dir (crypto reads env lazily).
process.env.YAPR_DATA_DIR =
  process.env.YAPR_DATA_DIR ?? path.join(os.tmpdir(), `yapr-test-${process.pid}`);

import {
  UNREADABLE_PLACEHOLDER,
  loadOrCreateIdentity,
  openEnvelope,
  sealText,
} from "./crypto.js";

describe("identity", () => {
  it("creates a stable base64 identity across loads", () => {
    const first = loadOrCreateIdentity();
    expect(first.publicKeyB64.length).toBeGreaterThan(20);
    const second = loadOrCreateIdentity();
    expect(second.publicKeyB64).toBe(first.publicKeyB64);
  });

  it("uses an isolated data dir per test env", () => {
    expect(process.env.YAPR_DATA_DIR).toBeTruthy();
  });
});

describe("shim envelope (C1 legacy-style)", () => {
  it("round-trips text through seal/open", () => {
    const env = sealText("peer", "me", "peer", "hello");
    expect(env.nonce).toBe("");
    expect(openEnvelope("peer", "me", "peer", env)).toEqual({ ok: true, text: "hello" });
  });

  it("rejects non-empty nonces (newer crypto) for placeholder flow", () => {
    expect(
      openEnvelope("peer", "me", "peer", { ciphertext: "eA==", nonce: "bm9uY2U=" })
    ).toEqual({ ok: false });
    expect(UNREADABLE_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});
