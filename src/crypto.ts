import crypto from "node:crypto";
import fs from "node:fs";
import { identityPathFor, resolveDataDir } from "./storage.js";

export type Envelope = { ciphertext: string; nonce: string };
export type OpenResult = { ok: true; text: string } | { ok: false };

function b64urlToB64(s: string): string {
  return Buffer.from(s, "base64url").toString("base64");
}

function rawPubB64(publicKey: crypto.KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  const x = (jwk as { x?: string }).x;
  if (!x) throw new Error("x25519 JWK export missing x");
  return b64urlToB64(x);
}

/** X25519 identity, created once and stored 0600 as JWK. Public key is base64. */
export function loadOrCreateIdentity(): { publicKeyB64: string } {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const path = identityPathFor(dir);
  const loaded = loadIdentityFile(path);
  if (loaded) return loaded;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pubB64 = rawPubB64(publicKey);
  fs.writeFileSync(path, JSON.stringify(privateKey.export({ format: "jwk" })), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    // Windows: best effort.
  }
  return { publicKeyB64: pubB64 };
}

function loadIdentityFile(path: string): { publicKeyB64: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const jwk = parsed as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown };
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "X25519" ||
    typeof jwk.x !== "string" ||
    typeof jwk.d !== "string"
  ) {
    return null;
  }
  try {
    const privateKey = crypto.createPrivateKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    return { publicKeyB64: rawPubB64(crypto.createPublicKey(privateKey)) };
  } catch {
    return null;
  }
}

/**
 * Seal plaintext for a peer. C1 SHIM: legacy-style base64 envelope (nonce '').
 * C2 replaces the body with real X25519+HKDF+AES-GCM; call sites stay identical.
 */
export function sealText(
  _peerPubB64: string,
  _senderId: string,
  _recipientId: string,
  text: string
): Envelope {
  return { ciphertext: Buffer.from(text, "utf8").toString("base64"), nonce: "" };
}

/**
 * Open an inbound envelope. Accepts only empty-nonce legacy/plain envelopes in C1;
 * anything else yields { ok: false } so the caller can store a placeholder.
 */
export function openEnvelope(
  _senderPubB64: string | null,
  _ownId: string,
  _senderId: string,
  envelope: Envelope
): OpenResult {
  if (envelope.nonce !== "") return { ok: false };
  try {
    return { ok: true, text: Buffer.from(envelope.ciphertext, "base64").toString("utf8") };
  } catch {
    return { ok: false };
  }
}

/** Placeholder stored when an envelope cannot be opened (e.g. newer crypto). */
export const UNREADABLE_PLACEHOLDER = "[encrypted message — update yapr to read it]";
