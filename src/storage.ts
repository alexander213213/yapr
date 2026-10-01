import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const APP_NAME = "yapr";
export const DB_FILENAME = "yapr.db";
export const IDENTITY_FILENAME = "identity.key";

/** Resolve the persistent data dir. Never points inside the installed package. */
export function resolveDataDir(): string {
  const override = process.env.YAPR_DATA_DIR?.trim();
  if (override) return override;

  const home = os.homedir();
  switch (os.platform()) {
    case "win32": {
      const base =
        process.env.APPDATA || process.env.LOCALAPPDATA || path.join(home, "AppData", "Roaming");
      return path.join(base, APP_NAME);
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_NAME);
    default: {
      const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
      return path.join(xdg, APP_NAME);
    }
  }
}

/** Legacy v0 location inside the package dir (wiped on npm update). Kept for migration only. */
export function legacyDbPath(): string {
  // import.meta.dirname is unavailable under tsx's CJS transform; fall back to import.meta.url.
  const here =
    typeof import.meta.dirname === "string"
      ? import.meta.dirname
      : path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "data", DB_FILENAME);
}

export function dbPathFor(dataDir: string): string {
  return path.join(dataDir, DB_FILENAME);
}

export function identityPathFor(dataDir: string): string {
  return path.join(dataDir, IDENTITY_FILENAME);
}

/**
 * Ensure the data dir exists and migrate a legacy v0 DB once (copy, don't move).
 * Returns the resolved data dir.
 */
export function ensureDataDir(): string {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });

  const target = dbPathFor(dir);
  if (!fs.existsSync(target)) {
    const legacy = legacyDbPath();
    if (path.resolve(legacy) !== path.resolve(target) && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, target);
      console.log(`migrated legacy db ${legacy} -> ${target}`);
    }
  }
  return dir;
}
