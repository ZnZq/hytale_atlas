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

/**
 * Groups digits with a plain comma.
 *
 * Not `toLocaleString()`: on a machine with a non-English locale it emits a
 * narrow no-break space, which Windows consoles render as mojibake — `14 628`
 * came out as `14Â 628`. Output is for a terminal, so it stays ASCII.
 */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

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
export interface SourceStamp {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Identity of a whole SET of sources, not of one archive.
 *
 * The moment third-party packs join the index, keying on Assets.zip alone is
 * actively wrong: two different mod sets hash to the same directory, so adding a
 * mod silently reuses the index built without it. That is the worst failure this
 * cache can have, because nothing about it looks broken -- every answer is
 * internally consistent and simply describes a world the user is no longer in.
 *
 * Sources are sorted before hashing, so the order they were discovered in cannot
 * change the key. A single source produces exactly the digest the one-archive
 * version produced, which is deliberate: existing caches stay valid and nobody
 * pays for a rebuild they gain nothing from.
 */
export function frozenKey(...sources: SourceStamp[]): string {
  const hash = createHash("sha256");
  const ordered = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const [i, s] of ordered.entries()) {
    if (i > 0) hash.update("\x1e");
    hash
      .update(s.path)
      .update("\0")
      .update(String(s.size))
      .update("\0")
      .update(String(Math.trunc(s.mtimeMs)));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Path to a frozen index.
 *
 * The schema version is part of the path so that bumping it orphans old databases
 * instead of reusing one whose shape no longer matches. There is no migration
 * path by design — rebuilding a derived artifact is cheaper than migrating it.
 */
export function frozenDbPath(key: string, root: string | null = null): string {
  return join(root ?? cacheRoot(), "frozen", `v${SCHEMA_VERSION}`, key, "corpus.db");
}
