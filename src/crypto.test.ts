import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

// Isolate identity files from the real user data dir (crypto reads env lazily).
const TEST_ROOT = path.join(os.tmpdir(), `yapr-crypto-test-${process.pid}`);
process.env.YAPR_DATA_DIR = path.join(TEST_ROOT, "default");

import {
  UNREADABLE_PLACEHOLDER,
  loadOrCreateIdentity,
  openEnvelope,
  sealText,
} from "./crypto.js";

function useDir(name: string): void {
  process.env.YAPR_DATA_DIR = path.join(TEST_ROOT, name);
}

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

describe("seal/open (X25519 + AES-GCM)", () => {
  it("round-trips A->B and B->A with direction separation", () => {
    useDir("a");
    const pubA = loadOrCreateIdentity().publicKeyB64;
    useDir("b");
    const pubB = loadOrCreateIdentity().publicKeyB64;

    useDir("a");
    const ab = sealText(pubB, "alice", "bob", "hello bob");
    expect(ab.nonce).not.toBe("");
    useDir("b");
    expect(openEnvelope(pubA, "bob", "alice", ab)).toEqual({ ok: true, text: "hello bob" });

    // Direction separation: opening an A->B envelope as B->A fails.
    expect(openEnvelope(pubB, "alice", "bob", ab)).toEqual({ ok: false });

    useDir("b");
    const ba = sealText(pubA, "bob", "alice", "hi alice");
    useDir("a");
    expect(openEnvelope(pubB, "alice", "bob", ba)).toEqual({ ok: true, text: "hi alice" });
  });

  it("produces opaque ciphertext (no plaintext leak)", () => {
    useDir("a");
    const pubA = loadOrCreateIdentity().publicKeyB64;
    const env = sealText(pubA, "alice", "alice", "top secret words");
    expect(env.ciphertext).not.toContain("top secret");
    expect(Buffer.from(env.ciphertext, "base64").toString("utf8")).not.toContain("top secret");
  });

  it("rejects tampered envelopes", () => {
    useDir("a");
    const pubA = loadOrCreateIdentity().publicKeyB64;
    const env = sealText(pubA, "alice", "alice", "untampered");
    const tampered = {
      ...env,
      ciphertext: env.ciphertext.slice(0, -4) + "AAAA",
    };
    expect(openEnvelope(pubA, "alice", "alice", tampered)).toEqual({ ok: false });
  });

  it("rejects the wrong sender key", () => {
    useDir("stranger");
    const pubStranger = loadOrCreateIdentity().publicKeyB64;
    useDir("a");
    const pubA = loadOrCreateIdentity().publicKeyB64;
    const env = sealText(pubA, "alice", "alice", "for alice");
    expect(openEnvelope(pubStranger, "alice", "alice", env)).toEqual({ ok: false });
  });

  it("decodes legacy empty-nonce envelopes as plaintext", () => {
    const legacy = { ciphertext: Buffer.from("hello legacy", "utf8").toString("base64"), nonce: "" };
    expect(openEnvelope(null, "bob", "alice", legacy)).toEqual({ ok: true, text: "hello legacy" });
  });

  it("exports a placeholder constant", () => {
    expect(UNREADABLE_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});
