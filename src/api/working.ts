import { existsSync } from "node:fs";

import type { Database } from "../db/open.ts";
import { assetIdFromPath, collectReferences } from "../indexer/corpus.ts";
import { collectCandidates } from "../indexer/references.ts";
import { buildPointerAligner } from "../indexer/stats.ts";
import { DirectorySource, treeStamp } from "../sources/directory.ts";
import { isTranslationReference, localeFromPath, parseLang, referenceToKey } from "../sources/lang.ts";

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
    "CREATE TEMP TABLE working_values (asset_id INTEGER, asset_type TEXT," +
      " json_pointer TEXT, schema_pointer TEXT, raw_value TEXT, value_kind TEXT," +
      " logical_id TEXT)",
  );
  const insValue = db.prepare(
    "INSERT INTO temp.working_values" +
      " (asset_id, asset_type, json_pointer, schema_pointer, raw_value, value_kind, logical_id)" +
      " VALUES (?,?,?,?,?,?,?)",
  );

  const insert = db.prepare(
    `INSERT INTO temp.working_assets (${ASSET_COLUMNS}) VALUES (?,?,?,?,?,1,NULL,0)`,
  );

  // Same suffix rule the corpus indexer applies, so an id here means what it
  // means there.
  // The SAME walk pass 3 runs over the corpus. A pointer collected here is raw,
  // exactly as pass 2 collects them, so anything sitting behind a `$ref` matches
  // no declared field until it is rebased -- which silently swallowed the ItemId
  // inside a Recipe, the commonest shape there is.
  const aligner = buildPointerAligner(db);
  // Parsed ONCE. Both the candidate pass and the search pass need the document,
  // and reading each file twice doubled the cost of every refresh -- the one
  // number that decides whether checking freshness before each answer is
  // affordable at all.
  const parsed = new Map<string, unknown>();

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
    parsed.set(entry.path, doc);
    for (const c of collectCandidates(doc)) {
      // Union branches are chosen from a discriminator read out of `candidates`,
      // which a working asset has no row in -- so a union stays unresolved and
      // the pointer is left as collected. Plain crossings, which is most of them,
      // rebase correctly.
      const aligned = aligner.knows(assetType)
        ? aligner.align(assetType, c.schemaPointer, c.pointer, id + 1)
        : { type: assetType, pointer: c.schemaPointer };
      insValue.run(id + 1, aligned.type, c.pointer, aligned.pointer, c.value, c.kind, logicalId);
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

  await buildWorkingSearch(db, source, parsed);
  buildWorkingEdges(db);
  return { root, stamp, assets, source };
}

/**
 * A tiny FTS index over the pack being written.
 *
 * Its own table rather than a union view: `assets_fts` is an FTS5 virtual table,
 * and `MATCH` cannot run against a view, so the shadowing trick the rest of this
 * overlay relies on is not available here. `searchAssets` therefore queries both
 * and merges -- the one place the working layer is not transparent.
 *
 * Rows carry the identifier only. Translated names live in the pack's own `.lang`
 * files, which are not parsed here, so a draft is found by what it is CALLED in
 * code and not yet by what it says on screen.
 */
async function buildWorkingSearch(
  db: Database,
  source: DirectorySource,
  parsed: ReadonlyMap<string, unknown>,
): Promise<void> {
  // The pack's OWN translations. A draft is looked for by the name it will show
  // on screen at least as often as by its identifier, and until these are read
  // the only thing findable is what the file happens to be called.
  const byLocale = new Map<string, Map<string, string>>();
  for (const entry of source.entries) {
    if (!entry.path.endsWith(".lang")) continue;
    const locale = localeFromPath(entry.path);
    if (locale === null) continue; // fallback.lang maps locales, it is not one
    // Stored keys carry NO root prefix -- `lang.ts` states the invariant: the
    // prefix is on the REFERENCE, and `referenceToKey` strips it. Prefixing by
    // the file's stem here was wrong, and wrong in the worst way: this pack's
    // file is `server.lang`, so the stem WAS the root, and every key became
    // `server.items.X.name` against a lookup of `items.X.name`. Not one of the
    // pack's eleven items was ever findable by its translated name.
    const parsed = parseLang(await source.readText(entry.path));
    const bucket = byLocale.get(locale) ?? new Map<string, string>();
    for (const [k, v] of parsed) bucket.set(k, v);
    byLocale.set(locale, bucket);
  }

  db.exec("DROP TABLE IF EXISTS temp.working_fts");
  db.exec(
    // Same tokenizer and prefix settings as `assets_fts`. Without them the two
    // halves of the union split text differently: `MyMod_Frost_Cleaver` answered
    // to its full identifier but not to `cleaver`, while every frozen row did.
    "CREATE VIRTUAL TABLE temp.working_fts USING fts5" +
      " (logical_id, type, locale UNINDEXED, display_name, description," +
      " tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')",
  );
  const insFts = db.prepare(
    "INSERT INTO temp.working_fts (logical_id, type, locale, display_name, description)" +
      " VALUES (?,?,?,?,?)",
  );
  const rows = db
    .prepare("SELECT logical_id, ifnull(type,'') AS type, path FROM temp.working_assets")
    .all() as unknown as { logical_id: string; type: string; path: string }[];

  for (const row of rows) {
    // The identifier row always exists, with separators opened up so a single
    // token matches -- the frozen index does the same for unlocalized assets.
    insFts.run(row.logical_id, row.type, "", row.logical_id.replace(/[_.]/g, " "), "");
    if (byLocale.size === 0) continue;

    // Already parsed by the caller; absent means it did not parse, and that was
    // reported there.
    const doc = parsed.get(row.path);
    if (doc === undefined) continue;
    const refs = collectReferences(doc, "", [], isTranslationReference);
    if (refs.length === 0) continue;

    for (const [locale, entries] of byLocale) {
      let name = "";
      let description = "";
      for (const ref of refs) {
        const value = entries.get(referenceToKey(ref.reference));
        if (value === undefined) continue;
        if (ref.role.toLowerCase().includes("desc")) description = value;
        else name = value;
      }
      if (name !== "" || description !== "") {
        insFts.run(row.logical_id, row.type, locale, name, description);
      }
    }
  }
}

/**
 * Edges FROM the pack being written, resolved against the frozen corpus.
 *
 * Mirrors the indexer's own two asset rules rather than inventing looser ones:
 * `/Parent` binds to an asset of the SAME type, and any other field binds only
 * where the schema declares a reference target. Matching on name alone would
 * make `refs` claim edges the corpus itself would not draw.
 *
 * Only this direction exists. Nothing the game ships can point at a pack that
 * does not exist yet, and that asymmetry is why one pass is enough.
 */
function buildWorkingEdges(db: Database): void {
  db.exec("DROP VIEW IF EXISTS temp.edges");
  db.exec("DROP TABLE IF EXISTS temp.working_edges");
  db.exec("CREATE TEMP TABLE working_edges AS SELECT * FROM main.edges LIMIT 0");

  db.exec(`
    INSERT INTO temp.working_edges (id, src, dst, dst_kind, kind, json_pointer, confidence, role)
    SELECT -w.rowid, w.asset_id, a.id, 'asset', 'INHERITS_FROM', w.json_pointer, 'high', NULL
      FROM temp.working_values w
      JOIN assets a ON a.logical_id = w.raw_value AND a.type = w.asset_type
     WHERE w.value_kind = 'string' AND w.json_pointer = '/Parent' AND a.id <> w.asset_id
  `);

  db.exec(`
    INSERT INTO temp.working_edges (id, src, dst, dst_kind, kind, json_pointer, confidence, role)
    SELECT -100000 - w.rowid, w.asset_id, a.id, 'asset', 'REFERENCES', w.json_pointer, 'high', NULL
      FROM temp.working_values w
      JOIN main.schema_fields sf
             ON sf.asset_type = w.asset_type
            AND sf.json_pointer = w.schema_pointer
            AND sf.reference_target IS NOT NULL
      JOIN assets a ON a.logical_id = w.raw_value AND a.type = sf.reference_target
     WHERE w.value_kind = 'string' AND w.json_pointer <> '/Parent' AND a.id <> w.asset_id
  `);

  // The naming-convention rule, at the corpus's own confidence grades. Without it
  // the draft loses every reference the schema does not declare a target for --
  // 2 237 of them at `/Recipe/Input/*/ItemId` alone, which is exactly the shape a
  // modder writes most. GLOB, not LIKE: SQLite's LIKE folds case, so '%Id' also
  // catches /Solid and /Fluid.
  db.exec(`
    INSERT INTO temp.working_edges (id, src, dst, dst_kind, kind, json_pointer, confidence, role)
    SELECT -200000 - w.rowid, w.asset_id, a.id, 'asset', 'REFERENCES', w.json_pointer,
           CASE
             WHEN w.json_pointer GLOB '*Id'
               OR w.json_pointer GLOB '*/Set'
               OR w.json_pointer GLOB '*/Model'
               OR w.json_pointer GLOB '*/BlockType'
               OR w.json_pointer GLOB '*/BlockTypes/*'
               OR w.json_pointer GLOB '*/BlockSets/*' THEN 'medium'
             ELSE 'low'
           END,
           NULL
      FROM temp.working_values w
      JOIN assets a ON a.logical_id = w.raw_value
     WHERE w.value_kind = 'string' AND w.json_pointer <> '/Parent' AND a.id <> w.asset_id
       AND NOT EXISTS (
             SELECT 1 FROM main.schema_fields sf
              WHERE sf.asset_type = w.asset_type
                AND sf.json_pointer = w.schema_pointer
                AND sf.reference_target IS NOT NULL)
  `);

  // `edges` is a RETRIEVAL table: `refs` answers "what points at this", and a
  // modder asking that about a vanilla asset wants to know their own pack now
  // points at it. Statistics keep reading `main.edges` explicitly.
  db.exec(
    "CREATE TEMP VIEW edges AS SELECT * FROM main.edges UNION ALL SELECT * FROM temp.working_edges",
  );
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
