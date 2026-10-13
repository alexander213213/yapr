import crypto from "node:crypto";
import fs from "node:fs";
import { identityPathFor, resolveDataDir } from "./storage.js";

export type Envelope = { ciphertext: string; nonce: string };

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

/** Cached private key, reloaded when the data dir changes (tests, profile switch). */
let cachedPrivateKey: { dir: string; key: crypto.KeyObject } | null = null;

function loadPrivateKey(): crypto.KeyObject {
  const dir = resolveDataDir();
  if (cachedPrivateKey && cachedPrivateKey.dir === dir) return cachedPrivateKey.key;
  // Ensure the identity exists, then read it back through the validated loader.
  loadOrCreateIdentity();
  const raw = fs.readFileSync(identityPathFor(dir), "utf8");
  const key = crypto.createPrivateKey({
    key: JSON.parse(raw) as crypto.JsonWebKey,
    format: "jwk",
  });
  cachedPrivateKey = { dir, key };
  return key;
}

function publicKeyFromB64(pubB64: string): crypto.KeyObject {
  const x = Buffer.from(pubB64, "base64").toString("base64url");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x },
    format: "jwk",
  });
}

function deriveMessageKey(
  sharedSecret: Buffer,
  nonce: Buffer,
  senderId: string,
  recipientId: string
): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", sharedSecret, nonce, `yapr-v1|${senderId}|${recipientId}`, 32)
  );
}

const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;

/** Inner payload version: `{ v: 1, nick, text, fwd? }` as JSON. The optional
 *  forward block carries original attribution for silently backfilled history.
 *  `v` stays 1 on purpose: old readers ignore unknown keys and degrade to
 *  today's behavior instead of showing garbage. */
const PAYLOAD_VERSION = 1;

/** Original attribution for a backfilled history row. */
export type ForwardBlock = {
  /** Original server message id (stable dedup key across sharers). */
  id: string;
  /** Original sender user id. */
  from: string;
  /** Original sender nickname at share time (may be ""). */
  nick: string;
  /** Original server timestamp. */
  sentAt: number;
};

export type OpenResult =
  | { ok: true; text: string; nick: string; fwd: ForwardBlock | null }
  | { ok: false };

function encodePayload(nick: string, text: string, fwd?: ForwardBlock): string {
  return JSON.stringify({ v: PAYLOAD_VERSION, nick, text, ...(fwd ? { fwd } : {}) });
}

function validForwardBlock(value: unknown): ForwardBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (
    typeof o.id !== "string" || o.id.length < 1 || o.id.length > 128 ||
    typeof o.from !== "string" || o.from.length < 1 || o.from.length > 64 ||
    typeof o.nick !== "string" || o.nick.length > 64 ||
    typeof o.sentAt !== "number" || !Number.isInteger(o.sentAt) || o.sentAt < 0
  ) {
    return null;
  }
  return { id: o.id, from: o.from, nick: o.nick, sentAt: o.sentAt };
}

/** Decode a payload, accepting both current `{v,nick,text,fwd?}` and legacy raw text. */
function decodePayload(plaintext: string): { text: string; nick: string; fwd: ForwardBlock | null } {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as { v?: unknown; nick?: unknown; text?: unknown; fwd?: unknown };
      if (obj.v === PAYLOAD_VERSION) {
        return {
          text: typeof obj.text === "string" ? obj.text : plaintext,
          nick: typeof obj.nick === "string" ? obj.nick : "",
          fwd: validForwardBlock(obj.fwd),
        };
      }
    }
  } catch {
    // Not JSON: pre-nick raw-text envelope from an older client.
  }
  return { text: plaintext, nick: "", fwd: null };
}

/**
 * Seal plaintext for a peer: X25519 DH + HKDF-SHA256 + AES-256-GCM.
 * Static-static scheme per docs/CRYPTO.md (no forward secrecy — documented).
 * The sender's nickname travels inside the encrypted payload (never metadata).
 */
export function sealText(
  peerPubB64: string,
  senderId: string,
  recipientId: string,
  text: string,
  nick: string = "",
  fwd?: ForwardBlock
): Envelope {
  const shared = crypto.diffieHellman({
    privateKey: loadPrivateKey(),
    publicKey: publicKeyFromB64(peerPubB64),
  });
  const nonce = crypto.randomBytes(GCM_NONCE_LEN);
  const key = deriveMessageKey(shared, nonce, senderId, recipientId);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const payload = encodePayload(nick, text, fwd);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { ciphertext: sealed.toString("base64"), nonce: nonce.toString("base64") };
}

/** Decode a pre-E2EE legacy envelope (empty nonce, base64 plaintext). */
function openLegacy(envelope: Envelope): OpenResult {
  try {
    return {
      ok: true,
      text: Buffer.from(envelope.ciphertext, "base64").toString("utf8"),
      nick: "",
      fwd: null,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Open an inbound envelope. Empty nonce decodes as legacy plaintext; otherwise
 * authenticated decryption runs and any failure yields { ok: false } so the
 * caller stores a placeholder instead of crashing or showing garbage.
 */
export function openEnvelope(
  senderPubB64: string | null,
  ownId: string,
  senderId: string,
  envelope: Envelope
): OpenResult {
  if (envelope.nonce === "") return openLegacy(envelope);
  if (!senderPubB64) return { ok: false };
  try {
    const shared = crypto.diffieHellman({
      privateKey: loadPrivateKey(),
      publicKey: publicKeyFromB64(senderPubB64),
    });
    const nonce = Buffer.from(envelope.nonce, "base64");
    if (nonce.length !== GCM_NONCE_LEN) return { ok: false };
    const sealed = Buffer.from(envelope.ciphertext, "base64");
    if (sealed.length < GCM_TAG_LEN + 1) return { ok: false };
    const key = deriveMessageKey(shared, nonce, senderId, ownId);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_LEN));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_LEN)),
      decipher.final(),
    ]).toString("utf8");
    const { text, nick, fwd } = decodePayload(plaintext);
    return { ok: true, text, nick, fwd };
  } catch {
    return { ok: false };
  }
}

/** Placeholder stored when an envelope cannot be opened (e.g. newer crypto). */
export const UNREADABLE_PLACEHOLDER = "[encrypted message — update yapr to read it]";
