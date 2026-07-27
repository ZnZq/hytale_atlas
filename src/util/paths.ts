import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION } from "../db/schema.ts";

/**
 * Cache locations.
 *
 * The global frozen cache is what makes `npx` viable: the first run costs minutes,
 * every subsequent project on the machine costs seconds. Without it the tool feels
 * heavy and nobody uses it twice (`docs/init/06-CLI-UX.md` §Cache layout).
 */

export function cacheRoot(): string {
  const override = process.env["HYTALE_ATLAS_CACHE"];
  if (override) return override;

  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    if (local) return join(local, "hytale-atlas", "cache");
  }
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg) return join(xdg, "hytale-atlas");
  return join(homedir(), ".cache", "hytale-atlas");
}

/**
 * Cache key for a frozen source.
 *
 * Keyed by content identity rather than a version string, because several
 * patchlines commonly coexist on one machine and a version string cannot tell
 * them apart. Size and mtime stand in for the full content hash: hashing 3.4 GB
 * costs seconds on every startup, and a stamp mismatch simply triggers a rebuild.
 */
export function frozenKey(path: string, stamp: { size: number; mtimeMs: number }): string {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(String(stamp.size))
    .update("\0")
    .update(String(Math.trunc(stamp.mtimeMs)))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Path to a frozen index.
 *
 * The schema version is part of the path so that bumping it orphans old databases
 * instead of reusing one whose shape no longer matches. There is no migration
 * path by design — rebuilding a derived artifact is cheaper than migrating it.
 */
export function frozenDbPath(key: string): string {
  return join(cacheRoot(), "frozen", `v${SCHEMA_VERSION}`, key, "corpus.db");
}
