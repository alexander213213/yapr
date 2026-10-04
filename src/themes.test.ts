import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Isolated DB: themes reads settings via the store, which opens the DB at
// import time — so the env must be pinned before the dynamic import below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-themes-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { BUILT_IN_THEMES, DEFAULT_THEME_NAME, getTheme, themeNames } = await import("./themes.js");

function luminance(hex: string): number {
  const rgb = hex
    .replace("#", "")
    .match(/../g)
    ?.map((h) => {
      const v = parseInt(h, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
  if (!rgb || rgb.length !== 3) throw new Error(`bad hex ${hex}`);
  const [r, g, b] = rgb as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const HEX_OR_NAMED = /^(#[0-9a-fA-F]{6}|[a-z]+)$/;

describe("themes", () => {
  it("registers the default theme plus alternatives", () => {
    expect(themeNames()).toContain(DEFAULT_THEME_NAME);
    expect(BUILT_IN_THEMES.length).toBeGreaterThanOrEqual(3);
  });

  it("fills every role with a plausible color", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const [role, value] of Object.entries(theme.roles)) {
        expect(value, `${theme.name}.${role}`).toMatch(HEX_OR_NAMED);
      }
    }
  });

  it("keeps emphasis ramps monotonic (e1 brightest) in every theme", () => {
    for (const theme of BUILT_IN_THEMES) {
      const l1 = luminance(theme.roles.e1);
      const l2 = luminance(theme.roles.e2);
      const l3 = luminance(theme.roles.e3);
      expect(l1, `${theme.name}.e1>e2`).toBeGreaterThan(l2);
      expect(l2, `${theme.name}.e2>e3`).toBeGreaterThan(l3);
    }
  });

  it("falls back to the default theme for unknown names", () => {
    expect(getTheme().name).toBe("moss");
  });
});
