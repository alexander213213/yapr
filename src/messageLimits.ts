// Size limits a chat message must fit to be relayable at all. Mirrors the
// server defaults (yapr-server protocol.ts / limits.ts / server.ts). An
// oversized send is not merely rejected: past the frame cap the server drops
// the socket, the reconnect flushes the same row, and the client loops.

/** Server cap on one envelope's base64 ciphertext. */
export const MAX_CIPHERTEXT_B64 = 32 * 1024;
/** Server cap on a whole send_group frame. */
export const MAX_GROUP_FRAME_BYTES = 512 * 1024;

const GCM_TAG_LEN = 16;
/** Headroom for the rest of the sealed payload JSON: `{"v":1,"nick":…}` with
 *  a nick up to 64 chars, and a history share's forward block. */
const PAYLOAD_OVERHEAD = 512;
/** Per-envelope JSON around the ciphertext in send_group (`to`, nonce, keys). */
const GROUP_ENVELOPE_OVERHEAD = 128;
/** send_group frame fields outside the envelopes. */
const GROUP_FRAME_OVERHEAD = 512;

/** Base64 length of AES-GCM output for `payloadBytes` of plaintext. */
export function sealedB64Length(payloadBytes: number): number {
  return 4 * Math.ceil((payloadBytes + GCM_TAG_LEN) / 3);
}

/** Worst-case sealed size of a message text (JSON-escaped, UTF-8). */
export function estimateCiphertextB64(text: string): number {
  return sealedB64Length(Buffer.byteLength(JSON.stringify(text), "utf8") + PAYLOAD_OVERHEAD);
}

/**
 * Null when `text` fits; otherwise a user-facing reason. `groupRecipients` is
 * the number of envelopes a group send fans out to (members minus self);
 * omit it for DMs.
 */
export function messageSizeError(text: string, groupRecipients?: number): string | null {
  const b64 = estimateCiphertextB64(text);
  if (b64 > MAX_CIPHERTEXT_B64) {
    return "Message too long to send — split it into smaller messages.";
  }
  if (groupRecipients !== undefined && groupRecipients > 0) {
    const frame = GROUP_FRAME_OVERHEAD + groupRecipients * (b64 + GROUP_ENVELOPE_OVERHEAD);
    if (frame > MAX_GROUP_FRAME_BYTES) {
      return `Message too long for a group of ${groupRecipients + 1} — split it into smaller messages.`;
    }
  }
  return null;
}
