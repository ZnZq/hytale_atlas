import { existsSync } from "node:fs";

import type { Database } from "../db/open.ts";
import { assetIdFromPath } from "../indexer/corpus.ts";
import { collectCandidates } from "../indexer/references.ts";
import { DirectorySource, treeStamp } from "../sources/directory.ts";

/**
 * The pack being authored, laid over the frozen corpus.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: only the RETRIEVAL tables are shadowed.
 * `assets` and `packs` are unioned, so `get`, `search` and `types` see your work
 * without a single query being rewritten. `candidates`, `field_stats` and every
 * other statistical table are NOT -- they answer "what does the corpus do", and
 * folding a half-written pack into that answers a different question than the one
 * asked. Worse, the pack is often written BY the model that then reads it back:
 * blending the two lets a draft become its own evidence.
 *
 * So the working layer is a third layer, reported separately, never merged. Same
 * discipline the DECLARED and OBSERVED layers already follow.
 *
 * Freshness is by tree stamp rather than a file watcher, so one code path serves
 * both a long-running server and a one-shot CLI run. A watcher can only ever be
 * an optimisation on top: it is unreliable for deep trees on Windows, and a
 * missed event would mean a silently stale answer.
 */

/** Sentinel pack id. Negative, so it cannot collide with an autoincremented one. */
export const WORKING_PACK_ID = -1;
export const WORKING_PACK_NAME = "working";

export interface WorkingLayer {
  readonly root: string;
  readonly stamp: string;
  readonly assets: number;
  /** Reads documents out of the directory; the frozen loader cannot. */
  readonly source: DirectorySource;
}

/** Columns of `assets`, in the order the union view needs them. */
const ASSET_COLUMNS =
  "id, pack_id, logical_id, type, path, is_effective, content_hash, last_changed_epoch";

/**
 * The asset type for a working file, inferred from where it sits.
 *
 * Read out of the frozen corpus rather than the generated schema: the indexer
 * decides types by PATH too, and the corpus already records what every directory
 * holds. That keeps the overlay usable at tier 1, where no schema exists at all,
 * and avoids loading the schema set a second time.
 */
function inferType(db: Database, path: string): string | null {
  const parts = path.split("/");
  // Longest directory prefix first: the deeper the match, the more specific.
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const prefix = `${parts.slice(0, depth).join("/")}/`;
    const row = db
      .prepare(
        `SELECT type, count(*) AS n FROM main.assets
          WHERE path LIKE ?1 || '%' AND type IS NOT NULL
          GROUP BY type ORDER BY n DESC LIMIT 1`,
      )
      .get(prefix) as { type: string; n: number } | undefined;
    if (row !== undefined) return row.type;
  }
  return null;
}

/**
 * Builds (or rebuilds) the overlay inside this connection's temp schema.
 *
 * Temp rather than a file: the overlay belongs to one process and one project,
 * and must never reach the content-addressed cache the whole machine shares.
 */
export async function buildWorkingLayer(
  db: Database,
  root: string,
  types?: { resolve(path: string): string | null },
): Promise<WorkingLayer | null> {
  if (!existsSync(root)) return null;

  const stamp = treeStamp(root);
  const source = DirectorySource.open(root);

  db.exec("DROP VIEW IF EXISTS temp.assets");
  db.exec("DROP VIEW IF EXISTS temp.packs");
  db.exec("DROP TABLE IF EXISTS temp.working_assets");
  db.exec("DROP TABLE IF EXISTS temp.working_packs");
  db.exec("DROP TABLE IF EXISTS temp.working_values");

  db.exec(`CREATE TEMP TABLE working_assets AS SELECT ${ASSET_COLUMNS} FROM main.assets LIMIT 0`);
  db.exec("CREATE TEMP TABLE working_packs AS SELECT * FROM main.packs LIMIT 0");

  db.prepare(
    "INSERT INTO temp.working_packs (id, group_name, name, version, path, kind, priority, source_hash)" +
      " VALUES (?, NULL, ?, NULL, ?, 'working', 1, NULL)",
  ).run(WORKING_PACK_ID, WORKING_PACK_NAME, root);

  // NOT unioned into `candidates`. This is the third layer, read only by the
  // WORKING section of an answer -- folding it into the observed statistics is
  // precisely the merge this design exists to prevent.
  db.exec(
    "CREATE TEMP TABLE working_values (asset_type TEXT, schema_pointer TEXT," +
      " raw_value TEXT, logical_id TEXT)",
  );
  const insValue = db.prepare(
    "INSERT INTO temp.working_values (asset_type, schema_pointer, raw_value, logical_id)" +
      " VALUES (?,?,?,?)",
  );

  const insert = db.prepare(
    `INSERT INTO temp.working_assets (${ASSET_COLUMNS}) VALUES (?,?,?,?,?,1,NULL,0)`,
  );

  // Same suffix rule the corpus indexer applies, so an id here means what it
  // means there.
  let id = -1;
  let assets = 0;
  for (const entry of source.entries) {
    if (!entry.path.endsWith(".json")) continue;
    const assetType = types?.resolve(entry.path) ?? inferType(db, entry.path);
    const logicalId = assetIdFromPath(entry.path);
    insert.run(id, WORKING_PACK_ID, logicalId, assetType, entry.path);
    id -= 1;
    assets += 1;

    if (assetType === null) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(await source.readText(entry.path));
    } catch {
      // A file mid-edit is routinely invalid JSON. It stays listed as an asset --
      // which is itself worth seeing -- and contributes no values.
      continue;
    }
    for (const c of collectCandidates(doc)) {
      insValue.run(assetType, c.schemaPointer, c.value, logicalId);
    }
  }

  // Retrieval only. Temp objects take precedence over `main` for an unqualified
  // name, so every existing query picks these up untouched -- verified: an
  // indexed lookup still reports SEARCH ... USING INDEX through the view.
  db.exec(
    `CREATE TEMP VIEW assets AS SELECT ${ASSET_COLUMNS} FROM main.assets` +
      ` UNION ALL SELECT ${ASSET_COLUMNS} FROM temp.working_assets`,
  );
  db.exec(
    "CREATE TEMP VIEW packs AS SELECT * FROM main.packs UNION ALL SELECT * FROM temp.working_packs",
  );

  return { root, stamp, assets, source };
}

/**
 * Rebuilds only when the tree actually changed.
 *
 * Measured on synthetic packs: the stamp walk is ~3ms at 50 files and ~19ms at
 * 500, against ~23ms and ~224ms to re-read and parse them. Checking before every
 * answer is therefore affordable at the size real packs are -- the median
 * third-party pack in this corpus holds 23 assets.
 */
export async function refreshWorkingLayer(
  db: Database,
  current: WorkingLayer | null,
  root: string,
  types?: { resolve(path: string): string | null },
): Promise<WorkingLayer | null> {
  if (current === null) return buildWorkingLayer(db, root, types);
  if (treeStamp(root) === current.stamp) return current;
  current.source.close();
  return buildWorkingLayer(db, root, types);
}

export interface WorkingValue {
  readonly value: string;
  readonly logicalId: string;
}

/**
 * What the pack you are writing puts at this field.
 *
 * Read on its own, never joined into the observed layer. Returns nothing when no
 * overlay is attached, so callers need no separate check.
 */
export function workingValues(db: Database, assetType: string, pointer: string): WorkingValue[] {
  const present = db
    .prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'working_values'")
    .get();
  if (present === undefined) return [];
  return db
    .prepare(
      `SELECT DISTINCT raw_value AS value, logical_id AS logicalId FROM temp.working_values
        WHERE asset_type = ? AND schema_pointer = ? ORDER BY raw_value`,
    )
    .all(assetType, pointer) as unknown as WorkingValue[];
}
