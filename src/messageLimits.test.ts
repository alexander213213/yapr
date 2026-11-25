import { describe, expect, it } from "vitest";
import { MAX_CIPHERTEXT_B64, estimateCiphertextB64, messageSizeError } from "./messageLimits.js";

describe("messageSizeError", () => {
  it("accepts ordinary messages", () => {
    expect(messageSizeError("hello")).toBeNull();
    expect(messageSizeError("hello", 49)).toBeNull();
  });

  it("rejects DMs whose sealed envelope exceeds the server cap", () => {
    expect(messageSizeError("x".repeat(30_000))).toMatch(/too long/);
    expect(estimateCiphertextB64("x".repeat(30_000))).toBeGreaterThan(MAX_CIPHERTEXT_B64);
  });

  it("counts JSON escaping and multi-byte characters", () => {
    // 8k newlines escape to 16k bytes; 8k emoji are 32k UTF-8 bytes.
    expect(messageSizeError("\n".repeat(8_000))).toBeNull();
    expect(messageSizeError("😀".repeat(8_000))).toMatch(/too long/);
  });

  it("tightens the cap by fan-out for groups", () => {
    const text = "x".repeat(15_000); // fits one envelope, not 49 of them
    expect(messageSizeError(text)).toBeNull();
    expect(messageSizeError(text, 2)).toBeNull();
    expect(messageSizeError(text, 49)).toMatch(/group of 50/);
  });
});
