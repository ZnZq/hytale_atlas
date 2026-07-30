import { existsSync } from "node:fs";

import type { Database } from "../db/open.ts";
import { assetIdFromPath, collectReferences } from "../indexer/corpus.ts";
import { collectCandidates } from "../indexer/references.ts";
import { buildPointerAligner } from "../indexer/stats.ts";
import { DirectorySource, treeStamp } from "../sources/directory.ts";
import { isTranslationReference, localeFromPath, parseLang, referenceToKey } from "../sources/lang.ts";
import { normalizeSearchText } from "../util/text.ts";

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

type PointerAligner = ReturnType<typeof buildPointerAligner>;

/**
 * The pointer aligner, built once per connection.
 *
 * It is derived ENTIRELY from the frozen tables, so it is identical for every
 * overlay rebuild against the same index -- yet it was rebuilt from scratch on
 * each one, and an overlay rebuild runs on every CLI command and on every MCP
 * call whose tree stamp moved. Measured on the shipped corpus: 1.2-1.4 s, of
 * which ~0.8 s is three unindexed scans of 608 145 candidate rows.
 *
 * That is 6-60x the entire freshness budget this file justifies itself with
 * (~23 ms at 50 files, ~224 ms at 500) and it was not counted in it: the number
 * that decides whether checking before every answer is affordable was measured
 * without the most expensive thing checking does.
 *
 * Keyed on the connection, like `hasThirdPartyPacks`, so it cannot outlive the
 * data it summarises.
 */
const alignerCache = new WeakMap<Database, PointerAligner>();

function pointerAligner(db: Database): PointerAligner {
  let cached = alignerCache.get(db);
  if (cached === undefined) {
    cached = buildPointerAligner(db);
    alignerCache.set(db, cached);
  }
  return cached;
}

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
function typeInferrer(db: Database): (path: string) => string | null {
  // Prepared ONCE. This sat inside the depth loop, so the statement was
  // recompiled on every iteration of every file -- and the query itself cannot
  // use an index (`assets` has none on `path`, and SQLite's case-insensitive
  // LIKE could not use one anyway), so each iteration also walked every typed
  // row. ~9 ms x files x depth levels, against the ~224 ms this file budgets for
  // re-reading a 500-file pack in full.
  const stmt = db.prepare(
    `SELECT type, count(*) AS n FROM main.assets
      WHERE path LIKE ?1 || '%' AND type IS NOT NULL
      GROUP BY type ORDER BY n DESC LIMIT 1`,
  );
  // A pack's files share very few directories -- the repo's own twelve collapse
  // to one distinct prefix -- so the answers are worth keeping for the build.
  const memo = new Map<string, string | null>();
  return (path) => {
    const parts = path.split("/");
    // Longest directory prefix first: the deeper the match, the more specific.
    for (let depth = parts.length - 1; depth >= 1; depth--) {
      const prefix = `${parts.slice(0, depth).join("/")}/`;
      let hit = memo.get(prefix);
      if (hit === undefined) {
        const row = stmt.get(prefix) as { type: string; n: number } | undefined;
        hit = row?.type ?? null;
        memo.set(prefix, hit);
      }
      if (hit !== null) return hit;
    }
    return null;
  };
}

/**
 * Suffixes that make a file an ASSET, read from the frozen corpus.
 *
 * The overlay tested `.json` and nothing else, directly under a comment claiming
 * it applied "the same suffix rule the corpus indexer applies". It does not: the
 * indexer takes the schema's own set, which on this corpus is `.json`,
 * `instance.bson`, `.particlespawner` and `.particlesystem`. A draft
 * `MyEffect.particlesystem` was therefore invisible to the overlay entirely --
 * no row, no FTS entry, no edge -- while the identical file inside a shipped
 * archive indexed normally.
 *
 * Read from `asset_types` rather than the schema set for the same reason
 * `typeInferrer` is: it keeps the overlay working at tier 1 and avoids loading
 * the schemas a second time. Falls back to `.json` on a corpus that records none.
 */
function assetSuffixesOf(db: Database): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT file_extension AS ext FROM main.asset_types WHERE file_extension IS NOT NULL",
    )
    .all() as unknown as { ext: string }[];
  const found = rows.map((r) => r.ext).filter((e) => e !== "");
  return found.length > 0 ? found : [".json"];
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
  // CTAS copies columns and NOTHING else -- no primary key, no index -- so every
  // join reaching this side had SQLite build an AUTOMATIC COVERING INDEX first,
  // per execution. Indexed here instead. `CREATE TABLE AS` is kept because
  // writing the columns out would duplicate the main schema and let the two
  // drift; the indexes are dropped with their tables on the next rebuild.
  db.exec("CREATE UNIQUE INDEX temp.idx_working_assets_id ON working_assets (id)");
  db.exec("CREATE INDEX temp.idx_working_assets_logical ON working_assets (logical_id)");
  db.exec("CREATE INDEX temp.idx_working_assets_type ON working_assets (type)");

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

  // The SAME walk pass 3 runs over the corpus. A pointer collected here is raw,
  // exactly as pass 2 collects them, so anything sitting behind a `$ref` matches
  // no declared field until it is rebased -- which silently swallowed the ItemId
  // inside a Recipe, the commonest shape there is.
  //
  // Cached per connection AND lazy: a pack whose files have no schema-known type
  // never touches it, and a pack that does pays for it once per process rather
  // than once per command.
  let alignerRef: PointerAligner | null = null;
  const aligner = (): PointerAligner => (alignerRef ??= pointerAligner(db));
  // Parsed ONCE. Both the candidate pass and the search pass need the document,
  // and reading each file twice doubled the cost of every refresh -- the one
  // number that decides whether checking freshness before each answer is
  // affordable at all.
  const parsed = new Map<string, unknown>();

  // Same suffix rule the corpus indexer applies, so an id here means what it
  // means there -- taken from the corpus rather than assumed.
  const suffixes = assetSuffixesOf(db);
  const inferType = typeInferrer(db);

  let id = -1;
  let assets = 0;
  for (const entry of source.entries) {
    if (!suffixes.some((s) => entry.path.endsWith(s))) continue;
    // Pack METADATA, not an asset. It was indexed as one: a searchable, untyped
    // asset called `manifest`, which also pushed the untyped-blind-spot count up
    // by one for every pack. The frozen indexer never sees this because archives
    // are filtered by configured root as well as by suffix.
    if (entry.path === "manifest.json") continue;
    const assetType = types?.resolve(entry.path) ?? inferType(entry.path);
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
      const aligned = aligner().knows(assetType)
        ? aligner().align(assetType, c.schemaPointer, c.pointer, id + 1)
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
    // NORMALISED, like the frozen half. The tokenizer settings were copied here
    // and the other half of the contract was not: `normalizeSearchText` segments
    // CJK ideographs and folds Ukrainian G-with-upturn to G, and
    // `buildMatchExpression` applies it to every QUERY. Storing raw meant a draft
    // with a zh-CN or uk-UA name could not be found by that name -- including by
    // typing it verbatim -- while the identical string in a vanilla asset was.
    insFts.run(
      row.logical_id,
      row.type,
      "",
      normalizeSearchText(row.logical_id.replace(/[_.]/g, " ")),
      "",
    );
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
        insFts.run(
          row.logical_id,
          row.type,
          locale,
          normalizeSearchText(name),
          normalizeSearchText(description),
        );
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
  // Same reason as `working_assets`: `refs` joins this side on both src and dst.
  //
  // NOT unique on `id`, unlike `main.edges` where it is the primary key. The ids
  // here are synthesised as `-rowid` off `working_values`, and one working value
  // can resolve to SEVERAL destination assets -- the heuristic rule below joins
  // on logical_id alone, and 442 identifiers in this corpus name more than eight
  // assets. So the same rowid legitimately produces several edges and they share
  // an id. Worth knowing before anything treats `edges.id` as a key across the
  // union view: on the frozen side it is one, on this side it is not.
  db.exec("CREATE INDEX temp.idx_working_edges_src ON working_edges (src, kind)");
  db.exec("CREATE INDEX temp.idx_working_edges_dst ON working_edges (dst, kind)");

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
  // points at it.
  //
  // Statistics read `main.edges` explicitly -- which was stated here as a fact
  // for some time before it was one. No such query existed: `statsOp` and
  // `assetsOfType` read the unqualified names and so counted the draft whenever
  // an overlay was attached, and the only reason the totals looked right was
  // that `statusOp` opens its own connection. They are qualified now, and this
  // sentence is a description again rather than a hope.
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
