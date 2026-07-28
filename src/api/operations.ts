import { existsSync } from "node:fs";

import { type Database, openDatabase } from "../db/open.ts";
import { craftableAt } from "../indexer/benches.ts";
import { type AssetLoader, type ResolvedAsset, resolveAsset } from "../query/asset.ts";
import {
  type FieldDescription,
  describeSchema,
  findUndocumented,
  isContainer,
  looksMangled,
  normalizeFieldPointer,
  pointersLike,
  searchSchemaDetailed,
} from "../query/schema.ts";
import { type SearchHit, searchAssets } from "../query/search.ts";
import { archiveStamp } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { referenceToKey } from "../sources/lang.ts";
import { frozenDbPath, frozenKey } from "../util/paths.ts";
import { type Caveat, type Result, caveat, ok } from "./types.ts";

/**
 * Every question the tool can answer, once.
 *
 * The CLI and (later) the MCP server both call these and only render what comes
 * back. A front end that computes anything -- a limit, a fallback, a wording --
 * has reintroduced the divergence this layer exists to prevent.
 *
 * Over-fetching by one is done here rather than in each caller, because "there
 * is more" is part of the answer: a truncated list that does not say so reads as
 * complete, which is how `undocumented` came to show 40 rows out of 6 324 in
 * silence.
 */

export interface OpenOptions {
  readonly assets?: string;
  readonly patchline?: string;
}

/** Resolves and opens the frozen index, or explains precisely why it cannot. */
export async function openIndex(options: OpenOptions = {}): Promise<Database> {
  const archivePath = options.assets ?? detectInstallation(options.patchline)?.assetsZip;
  if (archivePath == null) {
    throw new Error("Assets.zip not found. Set HYTALE_ROOT, or pass an explicit path.");
  }
  const dbPath = frozenDbPath(frozenKey(archivePath, await archiveStamp(archivePath)));
  if (!existsSync(dbPath)) {
    throw new Error(`No index yet. Build it first.\n  expected: ${dbPath}`);
  }
  return openDatabase(dbPath, { readOnly: true });
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  return Number(
    (db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined)?.["n"] ?? 0,
  );
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function searchAssetsOp(
  db: Database,
  query: string,
  limit = 20,
  type?: string,
): Result<SearchHit[]> {
  // `--type` was parsed, passed to `get`, and dropped here: `search stone
  // --type BlockSet` returned byte-identical output to no flag at all, silently.
  const found = searchAssets(db, query, { limit: limit + 1, ...(type ? { type } : {}) });
  const hits = found.slice(0, limit);
  const caveats: Caveat[] = [];
  if (found.length > limit) caveats.push(caveat.truncated(hits.length, "matches"));

  // A miss in the FTS index is not a miss in the corpus. `assets` holds 22 734
  // distinct identifiers and `assets_fts` 22 237: 497 of them -- 4 757 rows,
  // all worldgen under Server/World -- have no FTS row at all, so
  // `search 001_start.node` answered 'No asset is named ... in any indexed
  // locale' about eight assets that exist. Worse, the very next line offered
  // `refs 001_start.node`, because that suggestion consults `assets`.
  if (hits.length === 0) {
    // Honours --type. The first version of this fallback did not, so
    // `search Bench --type Nonexistent` started returning rows for a type that
    // does not exist -- turning a fixed defect back into a worse one.
    // Over-fetched by one, like the indexed path above. It was not, so this
    // branch could never tell that it had capped: `search brush --type
    // ScriptedBrushAsset` printed 20 rows and "these 20 row(s) come from a
    // literal identifier lookup", while --limit 45 returned 21. The withheld row
    // was a brush -- i.e. a mechanism -- and --help promises "every one says so
    // when it truncates". A rule kept by repeating it at each site is a rule
    // that holds until someone adds a site.
    const fetched = db
      .prepare(
        `SELECT DISTINCT logical_id, type FROM assets
          WHERE (logical_id = ?1 COLLATE NOCASE OR logical_id LIKE '%' || ?1 || '%')
            AND (?3 IS NULL OR type = ?3)
          ORDER BY length(logical_id), logical_id LIMIT ?2`,
      )
      .all(query, limit + 1, type ?? null) as unknown as {
      logical_id: string;
      type: string | null;
    }[];
    const literal = fetched.slice(0, limit);
    if (literal.length > 0) {
      const total = count(
        db,
        `SELECT count(*) AS n FROM (SELECT DISTINCT logical_id FROM assets
           WHERE (logical_id = ?1 COLLATE NOCASE OR logical_id LIKE '%' || ?1 || '%')
             AND (?2 IS NULL OR type = ?2))`,
        query,
        type ?? null,
      );
      return ok(
        literal.map((r) => ({
          logicalId: r.logical_id,
          type: r.type ?? "",
          locale: "",
          displayName: r.logical_id,
          relaxation: 0,
        })) as unknown as SearchHit[],
        [
          caveat.identifierOnly(
            literal.length,
            count(
              db,
              `SELECT count(*) AS n FROM (SELECT DISTINCT logical_id FROM assets
                 WHERE logical_id NOT IN (SELECT logical_id FROM assets_fts))`,
            ),
          ),
          ...(fetched.length > limit
            ? [caveat.truncated(literal.length, "matches", total)]
            : []),
        ],
      );
    }
  }
  // Stated on a miss, because "no matches" reads as "this string appears
  // nowhere" when the index only ever held names.
  if (hits.length === 0) caveats.push(caveat.namesNotValues());
  return ok(hits, caveats);
}

export interface AssetCandidate {
  readonly type: string | null;
  readonly path: string;
}

/**
 * Ordering used everywhere an identifier must resolve to one asset.
 *
 * Shared deliberately: the disambiguation note and the loader once ordered
 * differently, so `get Plant_Bush` said "Showing the Item one" and printed the
 * ItemDropList.
 */
const PICK_ORDER = "ORDER BY is_effective DESC, type";

export function sameNamed(db: Database, logicalId: string): AssetCandidate[] {
  return db
    .prepare(`SELECT type, path FROM assets WHERE logical_id = ? ${PICK_ORDER} LIMIT 8`)
    .all(logicalId) as unknown as AssetCandidate[];
}

/**
 * How many assets carry this identifier, without the display cap.
 *
 * The note said '8 assets are named Entry.node' because it counted the SAMPLE:
 * 461 are. 442 identifiers have more than eight rows, and `refs` -- whose
 * target query has no LIMIT -- disagreed with `get` on every one of them.
 */
export function sameNamedCount(db: Database, logicalId: string): number {
  return count(db, "SELECT count(*) AS n FROM assets WHERE logical_id = ?", logicalId);
}

/**
 * The distinct types carrying an identifier.
 *
 * The ambiguity note wants types, not assets: built from the 8-row sample it
 * listed whatever that sample happened to hold, so 461 untyped `Entry.node`
 * rows produced eight repetitions of one word and no information.
 */
export function sameNamedTypes(db: Database, logicalId: string): string[] {
  return (
    db
      .prepare("SELECT DISTINCT type FROM assets WHERE logical_id = ? ORDER BY type")
      .all(logicalId) as unknown as { type: string | null }[]
  ).map((r) => r.type ?? "untyped");
}

export async function getAssetOp(
  db: Database,
  logicalId: string,
  load: AssetLoader,
  type?: string,
): Promise<Result<ResolvedAsset | null>> {
  const candidates = sameNamed(db, logicalId);
  // The count comes from an unlimited query; `candidates` is the 8-row sample.
  // Deriving it here said '8 assets are named Entry.node' where 461 are -- the
  // CLI had already been fixed and this copy had not. The type list is likewise
  // the distinct set, not one entry per sampled row.
  const kinds = candidates.length > 1 ? sameNamedTypes(db, logicalId) : [];
  const caveats: Caveat[] =
    candidates.length > 1 && type === undefined
      ? [
          caveat.ambiguousIdentifier(
            logicalId,
            kinds.slice(0, 8),
            sameNamedCount(db, logicalId),
            kinds.length,
          ),
        ]
      : [];
  return ok(await resolveAsset(db, logicalId, load), caveats);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface UnionType {
  readonly branches: readonly string[];
  readonly discriminatorProperty: string;
  readonly discriminatorValues: readonly string[];
}

/** Non-null when a type is nothing but a union of branches. */
export function unionOf(db: Database, assetType: string): UnionType | null {
  const row = db
    .prepare(
      `SELECT ref_scope, discriminator_property, discriminator_values FROM schema_fields
        WHERE asset_type = ? AND json_pointer = '' AND ref_scope IS NOT NULL`,
    )
    .get(assetType) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const split = (v: unknown): string[] => String(v ?? "").split(" ").filter(Boolean);
  return {
    branches: split(row["ref_scope"]),
    discriminatorProperty: (row["discriminator_property"] as string | null) ?? "Type",
    discriminatorValues: split(row["discriminator_values"]),
  };
}

export interface DescribeRequest {
  readonly assetType: string;
  readonly field?: string;
  readonly limit?: number;
}

export interface DescribeResult {
  /** Non-null when the type is nothing but a union of branches. */
  readonly union: UnionType | null;
  readonly fields: readonly FieldDescription[];
  readonly total: number;
  /** The pointer actually used, after repairing shell mangling. */
  readonly field: string | null;
  /** Set when the caller's pointer was rewritten by their shell. */
  readonly repairedFrom: string | null;
}

export function describeOp(db: Database, request: DescribeRequest): Result<DescribeResult> {
  // A pure union declares no field of its own, so describing it row by row
  // returns a wall of UNDECLARED observations -- 213 of them for `Interaction`,
  // every one with `declared === null`. The CLI intercepts this and prints the
  // branches; this copy did not, and `unionOf` sat thirty lines above it unused.
  const union = request.field === undefined ? unionOf(db, request.assetType) : null;
  const limit = request.limit ?? 60;
  const field = request.field === undefined ? undefined : normalizeFieldPointer(request.field);
  const caveats: Caveat[] = [];

  const all = describeSchema(db, request.assetType, field);
  const fields = all.slice(0, limit);
  if (all.length > limit) caveats.push(caveat.truncated(fields.length, "fields"));
  if (fields.some((f) => f.observed !== null)) caveats.push(caveat.preInheritance());
  for (const f of fields) {
    if (f.observed === null && isContainer(f.declared?.type ?? null) && field !== undefined) {
      caveats.push(caveat.containerNoObservations());
    } else if (
      f.observed !== null &&
      f.observed.values === null &&
      f.observed.cardinality > 0 &&
      f.declared?.enumValues == null
    ) {
      caveats.push(caveat.cardinalityElided(f.observed.cardinality));
    }
  }

  return ok(
    {
      fields,
      union,
      total: all.length,
      field: field ?? null,
      repairedFrom:
        request.field !== undefined && looksMangled(request.field) ? request.field : null,
    },
    caveats,
  );
}

/** Nearest declared pointers, walking up from a miss. */
export function nearestFields(db: Database, assetType: string, field: string): string[] {
  let probe = field;
  while (probe.length > 1) {
    const near = pointersLike(db, assetType, probe);
    if (near.length > 0) return near;
    probe = probe.slice(0, probe.lastIndexOf("/")) || "/";
  }
  return [];
}

/**
 * Namespaced or bare spellings of a type that do exist, then near misses.
 *
 * Exact respelling alone was not enough. Two rounds of blind trials ended with
 * an agent asking for `common:FarmingBlock` and `common:Shape`; neither exists,
 * and each is one word away from one that does (`common:FarmingData`,
 * `common:ConnectedBlockShape`). Those misses fell through to a `search-schema`
 * suggestion, which searches field text and finds nothing for a type name
 * nobody ever wrote -- so the reader concluded the type was undocumented.
 */
export function typeAlternatives(db: Database, assetType: string): string[] {
  const bare = assetType.includes(":") ? assetType.slice(assetType.indexOf(":") + 1) : null;
  const exact = (
    db
      .prepare(
        `SELECT DISTINCT asset_type FROM schema_fields
          WHERE asset_type LIKE '%:' || ?1 OR asset_type = ?2
          ORDER BY asset_type LIMIT 5`,
      )
      .all(assetType, bare ?? " -no-such-type") as unknown as { asset_type: string }[]
  ).map((r) => r.asset_type);
  if (exact.length > 0) return exact;

  // Split the request into CamelCase words and rank every declared type by how
  // many it shares. Words shorter than three letters are dropped: 'Id' and 'To'
  // match most of the corpus and would rank noise above the real neighbour.
  const words = (bare ?? assetType)
    .match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g)
    ?.filter((w) => w.length >= 3);
  if (words === undefined || words.length === 0) return [];
  const lower = words.map((w) => w.toLowerCase());
  return (
    db.prepare("SELECT DISTINCT asset_type FROM schema_fields").all() as unknown as {
      asset_type: string;
    }[]
  )
    .map((r) => {
      const name = r.asset_type.slice(r.asset_type.indexOf(":") + 1).toLowerCase();
      const hit = lower.filter((w) => name.includes(w));
      // Coverage, not word count alone: for 'FarmingBlock' every Block* type
      // scores one word, and ordering those by name length put BlockSet and
      // BlockGroup above common:FarmingData, which is the answer. Measuring how
      // much of the candidate the match accounts for ranks it back up.
      return {
        type: r.asset_type,
        score: hit.length,
        coverage: hit.reduce((n, w) => n + w.length, 0) / Math.max(name.length, 1),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.type.length - b.type.length)
    .slice(0, 5)
    .map((c) => c.type);
}

export interface BrokenRef {
  readonly value: string;
  readonly occurrences: number;
}

export interface BrokenRefs {
  readonly shown: readonly BrokenRef[];
  /** Distinct broken values, before the display cap. */
  readonly distinct: number;
  /** Occurrences across all of them, shown or not. */
  readonly occurrences: number;
}

/**
 * Values on a field that declares a reference target and resolve to nothing.
 *
 * 2 674 occurrences corpus-wide: `Item./Categories/*` names 38 ItemCategory ids
 * that do not exist, 2 175 times; `BlockType./HitboxType` names a
 * BlockBoundingBoxes called 'Full' 256 times. The marker for these was computed
 * and then overwritten by the generic dangling pass, and nothing read the
 * column in any case. These are the findings `validate` will report.
 */
export function brokenRefsFor(
  db: Database,
  assetType: string,
  pointer: string,
  limit = 8,
): BrokenRefs {
  const shown = db
    .prepare(
      `SELECT raw_value AS value, count(*) AS occurrences
         FROM candidates
        WHERE dangling = 2 AND schema_scope = ? AND schema_pointer = ?
        GROUP BY raw_value ORDER BY occurrences DESC, raw_value LIMIT ?`,
    )
    .all(assetType, pointer, limit) as unknown as BrokenRef[];

  // The cap announces itself, like every other one in this file.
  // `common:BlockTypeFarmingStageData./Block` names 63 BlockTypes that do not
  // exist and printed the first eight, in alphabetical order, with nothing to
  // say the list ended early -- the shape of finding this project keeps
  // rediscovering as "a truncated list that does not say so reads as complete".
  return {
    shown,
    distinct: count(
      db,
      `SELECT count(*) AS n FROM (SELECT 1 FROM candidates
         WHERE dangling = 2 AND schema_scope = ? AND schema_pointer = ? GROUP BY raw_value)`,
      assetType,
      pointer,
    ),
    occurrences: count(
      db,
      `SELECT count(*) AS n FROM candidates
        WHERE dangling = 2 AND schema_scope = ? AND schema_pointer = ?`,
      assetType,
      pointer,
    ),
  };
}

export function typeExists(db: Database, assetType: string): boolean {
  return count(db, "SELECT count(*) AS n FROM schema_fields WHERE asset_type = ?", assetType) > 0;
}

/**
 * How many assets carry a type, whatever the schema knows about it.
 *
 * Existence was tested against `schema_fields` alone, so `describe NPCRole`
 * answered "No type 'NPCRole'" about a type 975 assets carry and `search`
 * prints in its own TYPE column -- then suggested `other:NPC:Role`, a
 * different concept. The generated schema simply declares no fields for it,
 * and all 44 938 of its candidates are unaligned, so `field_stats` is empty
 * too. 'The schema says nothing about this type' and 'this type does not
 * exist' are different answers and the reader needs the first one.
 */
export function assetsOfType(db: Database, assetType: string): number {
  return count(db, "SELECT count(*) AS n FROM assets WHERE type = ?", assetType);
}

export function searchSchemaOp(db: Database, query: string, limit = 20) {
  const detailed = searchSchemaDetailed(db, query, limit + 1);
  const hits = detailed.hits.slice(0, limit);
  const caveats: Caveat[] = [];
  if (detailed.hits.length > limit) caveats.push(caveat.truncated(hits.length, "fields"));
  if (detailed.relaxation > 0 || detailed.widened) {
    caveats.push(caveat.relaxed(query, detailed.relaxation, detailed.widened));
  }
  if (hits.length === 0) caveats.push(caveat.lexicalOnly());
  return ok(hits, caveats);
}

export function undocumentedOp(db: Database, type: string | undefined, limit = 40) {
  const found = findUndocumented(db, type, limit + 1);
  // The unlimited total. This command's own docstring records the original
  // defect as '40 rows out of 6 324 in silence'; the silence became the word
  // 'more' and never became a number.
  const total = findUndocumented(db, type, Number.MAX_SAFE_INTEGER).length;
  const fields = found.slice(0, limit);
  const caveats: Caveat[] = [
    caveat.joinIncomplete(
      count(
        db,
        `SELECT count(*) AS n FROM field_stats fs JOIN schema_fields sf
           ON sf.asset_type = fs.asset_type AND sf.json_pointer = fs.json_pointer`,
      ),
      count(db, "SELECT count(*) AS n FROM schema_fields WHERE json_pointer <> ''"),
      "declared",
    ),
  ];
  if (found.length > limit) caveats.push(caveat.truncated(fields.length, "fields", total));
  return ok(
    { fields, total, declared: type === undefined ? 0 : declaredCount(db, type) },
    caveats,
  );
}

export function declaredCount(db: Database, assetType: string): number {
  // Excludes the empty-pointer TYPE row, the same way describe does. They
  // disagreed by exactly one for every type that has one -- describe listing 8
  // fields under a header saying 9 were declared.
  return count(
    db,
    "SELECT count(*) AS n FROM schema_fields WHERE asset_type = ? AND json_pointer <> ''",
    assetType,
  );
}

export interface AssetTypeInfo {
  readonly type: string;
  readonly assets: number;
  readonly declaredFields: number;
  /** Where files of this type live inside the archive. */
  readonly path: string | null;
}

/**
 * Every asset type the game declares.
 *
 * `asset_types` holds 102 rows and had no reader anywhere in the project, so
 * no command could list the types -- while `describe` and `undocumented` both
 * require you to already know the name, and `search-schema` searches field
 * prose rather than the type list. Every blind trial asked for this.
 */
export function assetTypesOp(db: Database): Result<AssetTypeInfo[]> {
  const rows = db
    .prepare(
      `SELECT t.id AS type, t.schema_path AS path,
              (SELECT count(*) FROM assets a WHERE a.type = t.id) AS assets,
              (SELECT count(*) FROM schema_fields sf
                WHERE sf.asset_type = t.id AND sf.json_pointer <> '') AS declaredFields
         FROM asset_types t
        ORDER BY assets DESC, t.id`,
    )
    .all() as unknown as AssetTypeInfo[];
  return ok(rows);
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface Reference {
  readonly logicalId: string;
  readonly type: string | null;
  readonly kind: string;
  readonly pointer: string | null;
  readonly confidence: string;
}

export function refsOp(
  db: Database,
  logicalId: string,
  type: string | undefined,
  limit = 40,
): Result<{
  references: Reference[];
  total: number;
  /** Row ids carried through: callers need them to ask what the edges did NOT cover. */
  targets: (AssetCandidate & { id: number })[];
}> {
  const targets = db
    .prepare("SELECT id, type, path FROM assets WHERE logical_id = ?1 AND (?2 IS NULL OR type = ?2)")
    .all(logicalId, type ?? null) as unknown as ({ id: number } & AssetCandidate)[];

  if (targets.length === 0) return ok({ references: [], total: 0, targets: [] });

  const ids = targets.map((t) => t.id);
  const holes = ids.map(() => "?").join(",");

  /**
   * Drops edges the schema contradicts.
   *
   * Heuristic edges are built to EVERY asset sharing a name, so
   * `Alchemy_Cauldron_Big`'s `PhysicalMaterialId: "Stone"` produced four edges --
   * one per Stone. Only the one matching the declared target became `high`; the
   * other three stayed `medium` in buckets they have nothing to do with. Scoping
   * to a type therefore did not narrow: the four type-scoped totals summed to
   * 5 087 against an unscoped 2 262, while the footer claimed the opposite had
   * happened.
   *
   * Filtered here rather than at index time because the index-time forms -- a
   * correlated DELETE, then a temp table -- took the build from 42 seconds past
   * six minutes without finishing.
   */
  // Parameterised by alias because it has to be applied to BOTH sides of the
  // overlap test below. Applying it only to the outer edge counted an edge as
  // 'shared' with a sibling target that the same filter had already dropped:
  // `refs Stone --type PhysicalMaterial` claimed 644 of 644 where 285 overlap,
  // and `refs Burn --type EntityEffect` claimed 7 of 7 against an observable 3.
  // A wrong number attached to a correct warning is worse than no warning.
  const contradictedFor = (edge: string): string => `NOT EXISTS (
    SELECT 1 FROM candidates c
      JOIN schema_fields sf
            ON sf.asset_type = c.schema_scope
           AND sf.json_pointer = c.schema_pointer
           AND sf.reference_target IS NOT NULL
     WHERE c.asset_id = ${edge}.src AND c.json_pointer = ${edge}.json_pointer
       AND sf.reference_target <> (SELECT type FROM assets WHERE id = ${edge}.dst)
       -- The right answer must exist UNDER THIS NAME. Requiring only that the
       -- declared type exist somewhere deleted Seed_Place -> Rock_Stone:
       -- BlockTypeToPlace declares '-> BlockType', exactly one asset of 35 074
       -- carries that type, and no Rock_Stone does -- so the declaration cannot
       -- be discharged and the name match is still the best evidence there is.
       AND EXISTS (SELECT 1 FROM assets t
                    WHERE t.logical_id = (SELECT logical_id FROM assets WHERE id = ${edge}.dst)
                      AND t.type = sf.reference_target))`;
  const contradicted = contradictedFor("e");
  // DISTINCT across targets. Four assets are named Rock_Stone; a world-gen entry
  // naming that string produces an edge to each, so the unfiltered list counted
  // 303 references where 162 exist -- the Item view plus the ResourceType view,
  // concatenated, 141 rows appearing in both. Internally consistent with the rows
  // printed, and answering a subtly different question than the reader asked.
  const rows = db
    .prepare(
      `SELECT DISTINCT s.logical_id, s.type, e.kind, e.json_pointer, e.confidence
         FROM edges e JOIN assets s ON s.id = e.src
        WHERE e.dst_kind = 'asset' AND e.dst IN (${holes}) AND ${contradicted}
        ORDER BY CASE e.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 s.logical_id
        LIMIT ?`,
    )
    .all(...ids, limit + 1) as unknown as {
    logical_id: string;
    type: string | null;
    kind: string;
    json_pointer: string | null;
    confidence: string;
  }[];

  const references = rows.slice(0, limit).map((r) => ({
    logicalId: r.logical_id,
    type: r.type,
    kind: r.kind,
    pointer: r.json_pointer,
    confidence: r.confidence,
  }));

  const total = count(
    db,
    // Counted over the SAME projection the list uses. The rows collapse two
    // same-named sources into one and the total kept them apart, so
    // `refs Adventure` announced 96 above 85 printed rows -- with no truncation
    // notice, because nothing had been truncated. 95 identifiers were affected.
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT s.logical_id, s.type, e.kind, e.json_pointer, e.confidence
         FROM edges e JOIN assets s ON s.id = e.src
        WHERE e.dst_kind = 'asset' AND e.dst IN (${holes}) AND ${contradicted})`,
    ...ids,
  );

  const caveats: Caveat[] = [
    caveat.untypedBlindSpot(count(db, "SELECT count(*) AS n FROM assets WHERE type IS NULL")),
    // Edges are built from files as written, so an asset that INHERITS a
    // reference is not among them: `refs Drops_Plant_Crop_Carrot_Stage1` lists
    // the two files that name it and not `Plant_Crop_Apple_Block`, whose
    // effective definition -- printed by `get` -- also points there. Both
    // answers are right about different questions, and `--help` calls this one
    // "the inverse of get", which is the reading that makes the pair look like
    // a missing edge. `describe` has carried this caveat all along.
    caveat.preInheritance(),
  ];
  if (rows.length > limit) caveats.push(caveat.truncated(references.length, "references"));
  if (targets.length > 1 && type === undefined) {
    // Distinct types, capped -- not one entry per asset. `targets` is every row
    // sharing the identifier, so `refs Entry.node` rendered the word "untyped"
    // 461 times inside a single sentence. `getAssetOp` already passes a sample
    // plus a separate total; this site passed the whole list as if it were the
    // sample.
    const kinds = [...new Set(targets.map((t) => t.type ?? "untyped"))];
    caveats.push(
      caveat.ambiguousIdentifier(logicalId, kinds.slice(0, 8), targets.length, kinds.length),
    );
  } else if (type !== undefined) {
    // Naming what was excluded. Scoping to one type legitimately changes the edge
    // set -- a BlockSet inheriting from the BlockSet named Stone has no bearing on
    // the PhysicalMaterial of the same name -- but the totals then vary between
    // runs with nothing to explain why, which reads as edges being dropped.
    const others = (
      db
        .prepare("SELECT DISTINCT type FROM assets WHERE logical_id = ? AND type IS NOT ?")
        .all(logicalId, type) as unknown as { type: string | null }[]
    ).map((r) => r.type ?? "untyped");
    if (others.length > 0) {
      // How many of these edges are shared with a same-named asset of another
      // type -- i.e. come from a field that never declared what it points at,
      // so the name alone cannot choose between them.
      //
      // This is why scoped totals can still sum to more than the unscoped one:
      // 'Stone' names four assets, and a field with no declared target produces
      // an edge to each. The previous wording claimed the opposite -- that
      // scoping only excludes -- which made the arithmetic look like a bug in
      // the tool rather than ambiguity in the data.
      const shared = count(
        db,
        `SELECT count(*) AS n FROM (
           SELECT DISTINCT e.src, e.json_pointer, e.kind FROM edges e
            WHERE e.dst_kind = 'asset' AND e.dst IN (${holes}) AND ${contradicted}
              AND EXISTS (SELECT 1 FROM edges e2 JOIN assets d2 ON d2.id = e2.dst
                           WHERE e2.dst_kind = 'asset' AND e2.src = e.src
                             AND e2.json_pointer IS e.json_pointer
                             AND d2.logical_id = ?
                             AND e2.dst NOT IN (${holes})
                             AND ${contradictedFor("e2")}))`,
        ...ids,
        logicalId,
        ...ids,
      );
      caveats.push({
        code: "ambiguous-identifier",
        message:
          `Scoped to '${type}'. ${others.length} other asset(s) share this name ` +
          `(${others.join(", ")}).` +
          (shared > 0
            ? ` ${shared} of these ${total} references also point at one of those: the` +
              ` field does not declare which type it means, so the same source` +
              ` line appears under each. Type-scoped totals therefore overlap and` +
              ` can sum to more than the unscoped total.`
            : ` References to those are excluded, so this total is a subset of the` +
              ` unscoped one.`),
      });
    }
  }

  return ok(
    {
      references,
      total,
      targets,
    },
    caveats,
  );
}

/**
 * Everything a bare string turns out to be, asked once.
 *
 * Every command grew its own answer to "what did the user just type", each from
 * a different single fact, and the disagreements were the most-reported class in
 * the blind trials:
 *
 * - `search <miss>` prints "to find what uses a value, ask for references to it
 *   instead" and then offers `refs` **only when the string IS an asset** -- the
 *   exact inverse of the sentence above it. Three agents followed the printed
 *   advice into `search-schema`, which answers a different question, and one
 *   nearly filed a capability gap because the value's sole vanilla use was
 *   sitting behind the `refs` it was never offered.
 * - `refs <langKey>` -> `search` -> `search-schema`, three misses in a row, while
 *   `search-lang` answers instantly and is suggested by neither.
 * - `bench <categoryId>` says "no bench" and sends the reader to a list that
 *   cannot contain a category, though `refs` will happily say it is one.
 *
 * The loop those comments describe -- `search` pointing at `refs`, `refs`
 * pointing back -- exists because neither command could say what the token was.
 * Asking that question in one place is the fix; suppressing one arm of the loop
 * was the symptom's fix and cost the value case.
 */
export interface TokenIdentity {
  readonly assets: number;
  readonly assetTypes: readonly string[];
  /** Occurrences as a field value, whatever else it may also be. */
  readonly valueOccurrences: number;
  readonly valueAssets: number;
  readonly files: number;
  /** The stored key spelling, when the token names a localization key. */
  readonly langKey: string | null;
  readonly benchId: boolean;
  readonly benchCategory: boolean;
}

/**
 * Occurrences of a string as a field value that produced NO edge to these assets.
 *
 * The number that means something when the token is BOTH an asset and a value.
 * Edges are built FROM candidates, so for an asset every inbound reference is
 * also an occurrence of its name as a value: reporting the raw occurrence count
 * as an additional set said "10 occurrences, not listed above" directly beneath
 * the same ten rows. Four of five blind trials caught it, with counts matching
 * exactly (10/10, 22/22, 164/164, 4/4) -- which is what makes it a double count
 * rather than a coincidence.
 *
 * The residue is real and worth naming: a value can appear where no edge was
 * built -- filtered as noise, inside an unaligned type, or contradicted by a
 * declared target. `refs 5` has 4 edges and 4 756 occurrences, and that gap is
 * the whole answer to "which blocks require Quality 5".
 */
export function valueOccurrencesWithoutEdges(
  db: Database,
  token: string,
  targetIds: readonly number[],
): { occurrences: number; assets: number } {
  if (targetIds.length === 0) return { occurrences: 0, assets: 0 };
  const holes = targetIds.map(() => "?").join(",");
  const where = `c.raw_value = ?
      AND NOT EXISTS (SELECT 1 FROM edges e
                       WHERE e.src = c.asset_id
                         AND e.json_pointer = c.json_pointer
                         AND e.dst_kind = 'asset'
                         AND e.dst IN (${holes}))`;
  return {
    occurrences: count(db, `SELECT count(*) AS n FROM candidates c WHERE ${where}`, token, ...targetIds),
    assets: count(
      db,
      `SELECT count(DISTINCT c.asset_id) AS n FROM candidates c WHERE ${where}`,
      token,
      ...targetIds,
    ),
  };
}

export function identify(db: Database, token: string): TokenIdentity {
  const stored = referenceToKey(token);
  const langRow = db
    .prepare("SELECT key FROM lang_keys WHERE key = ?1 OR key = ?2 LIMIT 1")
    .get(token, stored) as { key: string } | undefined;

  return {
    assets: count(db, "SELECT count(*) AS n FROM assets WHERE logical_id = ?", token),
    assetTypes: (
      db
        .prepare("SELECT DISTINCT type FROM assets WHERE logical_id = ? ORDER BY type")
        .all(token) as unknown as { type: string | null }[]
    ).map((r) => r.type ?? "untyped"),
    valueOccurrences: count(
      db,
      "SELECT count(*) AS n FROM candidates WHERE raw_value = ?",
      token,
    ),
    valueAssets: count(
      db,
      "SELECT count(DISTINCT asset_id) AS n FROM candidates WHERE raw_value = ?",
      token,
    ),
    files: count(
      db,
      "SELECT count(*) AS n FROM files WHERE path = ?1 OR path LIKE '%/' || ?1",
      token,
    ),
    langKey: langRow?.key ?? null,
    benchId: count(db, "SELECT count(*) AS n FROM benches WHERE id = ?", token) > 0,
    benchCategory:
      count(db, "SELECT count(*) AS n FROM bench_categories WHERE category_id = ?", token) > 0,
  };
}

export interface ValueUsage {
  /** Total occurrences, across every field and asset. */
  readonly occurrences: number;
  /** Distinct assets carrying it -- always <= occurrences. */
  readonly assets: number;
  readonly byField: readonly { scope: string; pointer: string; count: number }[];
  /** Distinct fields, so a shown-3-of-N breakdown can say the N. */
  readonly fields: number;
  /** How many byField rows are display rows rather than the over-fetch. */
  readonly fieldsShown: number;
  /**
   * Occurrences the breakdown cannot place, because the candidate never
   * aligned to a declared field.
   *
   * 45 319 of 479 117 candidates carry no `schema_scope`, 44 938 of them
   * NPCRole -- a type the schema declares nothing for. So `refs Variant`
   * printed '466 time(s) in 465 asset(s):' and then an EMPTY breakdown under
   * the colon, and `refs State` accounted for 21 of 1 509.
   */
  readonly unattributed: number;
  readonly examples: readonly { logicalId: string; type: string | null; pointer: string }[];
}

/**
 * Where a plain string appears as a field VALUE rather than an asset id.
 *
 * Three separate defects lived in the old inline version of this query.
 *
 * It said "N **assets** carry it as a VALUE" while counting occurrences:
 * `refs HarvestCrop` claimed 29 assets where `describe` counted 25, and
 * `refs Necromancy_Bones` claimed 2 for a single asset holding the value
 * twice. Both numbers are worth having, so both are returned.
 *
 * Its breakdown was capped at three rows but the total was the sum of those
 * three, so a truncated list added up perfectly and read as exhaustive --
 * `refs 50` reported 389 across three fields while `Item/ItemLevel`, which the
 * index does not store values for, was missing entirely.
 *
 * And it named no assets at all. It pointed at `describe <Type> --field <p>`,
 * which for a high-cardinality field answers "more values than this index
 * keeps -- use refs", pointing straight back. Every one of five blind trials
 * hit that loop; two called it the single biggest gap in the tool.
 */
export function valueUsage(db: Database, value: string, limit = 10): ValueUsage {
  // Both lists move with --limit. Capping the field breakdown at a separate
  // hard-coded 6 while telling the reader to raise --limit produced a page
  // that named a remedy it did not honour, at every limit they tried.
  const fieldLimit = Math.max(6, Math.ceil(limit / 2));
  const byField = db
    .prepare(
      `SELECT schema_scope AS scope, schema_pointer AS pointer, count(*) AS count
         FROM candidates
        WHERE raw_value = ? AND schema_scope IS NOT NULL
        GROUP BY schema_scope, schema_pointer
        ORDER BY count DESC LIMIT ?`,
    )
    .all(value, fieldLimit + 1) as unknown as { scope: string; pointer: string; count: number }[];

  const examples = db
    .prepare(
      `SELECT a.logical_id AS logicalId, a.type, c.json_pointer AS pointer
         FROM candidates c JOIN assets a ON a.id = c.asset_id
        WHERE c.raw_value = ?
        ORDER BY a.logical_id LIMIT ?`,
    )
    .all(value, limit + 1) as unknown as {
    logicalId: string;
    type: string | null;
    pointer: string;
  }[];

  return {
    occurrences: count(db, "SELECT count(*) AS n FROM candidates WHERE raw_value = ?", value),
    assets: count(
      db,
      "SELECT count(DISTINCT asset_id) AS n FROM candidates WHERE raw_value = ?",
      value,
    ),
    byField,
    fieldsShown: Math.min(byField.length, fieldLimit),
    fields: count(
      db,
      `SELECT count(*) AS n FROM (SELECT 1 FROM candidates WHERE raw_value = ?
         AND schema_scope IS NOT NULL GROUP BY schema_scope, schema_pointer)`,
      value,
    ),
    examples,
    unattributed: count(
      db,
      "SELECT count(*) AS n FROM candidates WHERE raw_value = ? AND schema_scope IS NULL",
      value,
    ),
  };
}

export interface FileUsage {
  readonly path: string;
  readonly references: readonly {
    logicalId: string;
    type: string | null;
    pointer: string | null;
  }[];
  /** Edges pointing at the file. One asset can hold several. */
  readonly total: number;
  /** Distinct assets, which is the smaller and more useful number. */
  readonly assets: number;
}

/**
 * Who references a non-JSON file: a model, texture, icon, sound or animation.
 *
 * `refsOp` filters `dst_kind = 'asset'`, so 33 782 REFERENCES_FILE edges over
 * 24 923 files were unreachable: `refs Glow.png` answered 'nothing carries it
 * as a value' about a texture 221 edges point at. The schema names 'file' as a
 * first-class destination kind; nothing joined the table.
 *
 * Matched on the basename as well as the full path, because the stored value
 * is a pack-relative path the reader has no reason to know.
 */
export function fileRefsOp(db: Database, needle: string, limit = 40): Result<FileUsage[]> {
  // Bounded by --limit like every other list here. It was a hard 5, and the
  // truncation notice this function now emits ends "Use --limit <n> for more" --
  // a remedy the caller could not honour, which is the defect `valueUsage`
  // records having fixed one screen above.
  const files = db
    .prepare(
      `SELECT id, path FROM files
        WHERE path = ?1 OR path LIKE '%/' || ?1
        ORDER BY length(path), path LIMIT ?2`,
    )
    .all(needle, limit) as unknown as { id: number; path: string }[];
  if (files.length === 0) return ok([]);

  // A basename is rarely unique: 291 of them name more than five files, and
  // `Model.blockymodel` names 173. Five groups were printed and the other 168
  // went unmentioned, so the answer read as "these are the files with this
  // name".
  const matching = count(
    db,
    "SELECT count(*) AS n FROM files WHERE path = ?1 OR path LIKE '%/' || ?1",
    needle,
  );

  const rows = db.prepare(
    `SELECT a.logical_id AS logicalId, a.type, e.json_pointer AS pointer
       FROM edges e JOIN assets a ON a.id = e.src
      WHERE e.dst_kind = 'file' AND e.dst = ?
      ORDER BY a.logical_id LIMIT ?`,
  );

  const usage = files.map((file) => ({
    path: file.path,
    references: rows.all(file.id, limit) as unknown as {
      logicalId: string;
      type: string | null;
      pointer: string | null;
    }[],
    total: count(
      db,
      "SELECT count(*) AS n FROM edges WHERE dst_kind = 'file' AND dst = ?",
      file.id,
    ),
    // Both, because they differ and the label was wrong about which it was:
    // Frown.blockyanim showed '148 asset(s)' where 38 assets hold 148 pointers.
    // 1 534 of 19 497 referenced files are affected.
    assets: count(
      db,
      "SELECT count(DISTINCT src) AS n FROM edges WHERE dst_kind = 'file' AND dst = ?",
      file.id,
    ),
  }));

  const caveats: Caveat[] = [];
  const shown = usage.reduce((n, u) => n + u.references.length, 0);
  const all = usage.reduce((n, u) => n + u.total, 0);
  if (all > shown) caveats.push(caveat.truncated(shown, "references", all));
  if (matching > files.length) {
    caveats.push(caveat.truncated(files.length, `files named '${needle}'`, matching));
  }
  return ok(usage, caveats);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

export interface LangEntry {
  readonly key: string;
  /**
   * What an asset must actually contain: the key with its root prefix.
   *
   * Printing the stored key alone made a modder who searched successfully
   * paste a dead reference -- `items.Foo.name` where the asset needs
   * `server.items.Foo.name`. Four blind trials in a row reported it, and the
   * rule was only ever explained on a MISS.
   */
  readonly reference: string;
  readonly translations: readonly { locale: string; value: string }[];
  readonly usedBy: readonly { logicalId: string; pointer: string | null }[];
  /** Every asset referencing the key, before the display cap. */
  readonly usedByTotal: number;
}

export function langOp(db: Database, query: string, limit = 20): Result<LangEntry[]> {
  // Both spellings, because a caller pastes whichever they have: assets
  // reference `server.items.X.name`, the table stores `items.X.name`.
  const stripped = referenceToKey(query);
  // A third spelling: strip whatever the caller's first segment is and see if
  // the remainder is a key under exactly that root. `referenceToKey` only knows
  // 'server.' and 'common.', so `wordlists.runes.algas` -- the full path the
  // schema's own WordList documentation gives -- was reported as a real miss,
  // while the wrong `server.runes.algas` resolved.
  const dot = query.indexOf(".");
  const anyRoot = dot < 0 ? null : query.slice(0, dot);
  const anyRest = dot < 0 ? null : query.slice(dot + 1);
  const keys = db
    .prepare(
      `SELECT DISTINCT key FROM lang_keys
        WHERE key = ?1 OR key = ?2 OR key LIKE '%' || ?2 || '%'
           OR value LIKE '%' || ?1 || '%'
           OR (?4 IS NOT NULL AND key = ?4 AND root = ?5)
        ORDER BY length(key), key LIMIT ?3`,
    )
    .all(query, stripped, limit + 1, anyRest, anyRoot) as unknown as { key: string }[];

  const translations = db.prepare(
    "SELECT locale, value FROM lang_keys WHERE key = ? ORDER BY locale",
  );
  const users = db.prepare(
    `SELECT DISTINCT a.logical_id, e.json_pointer FROM edges e
       JOIN lang_keys l ON l.id = e.dst JOIN assets a ON a.id = e.src
      WHERE e.dst_kind = 'lang_key' AND l.key = ? LIMIT ?`,
  );

  const rootOf = db.prepare(
    "SELECT root FROM lang_keys WHERE key = ? AND root IS NOT NULL LIMIT 1",
  );

  const entries = keys.slice(0, limit).map(({ key }) => ({
    key,
    reference: (() => {
      const row = rootOf.get(key) as { root: string } | undefined;
      return row === undefined ? key : `${row.root}.${key}`;
    })(),
    translations: translations.all(key) as unknown as { locale: string; value: string }[],
    usedByTotal: count(
      db,
      `SELECT count(DISTINCT e.src) AS n FROM edges e JOIN lang_keys l ON l.id = e.dst
        WHERE e.dst_kind = 'lang_key' AND l.key = ?`,
      key,
    ),
    usedBy: (
      // Capped at a hard 5 with no signal, so `interactionHints.openDoor`
      // showed 5 of 91 users and looked complete. --limit did not move it.
      users.all(key, limit + 1) as unknown as {
        logical_id: string;
        json_pointer: string | null;
      }[]
    ).map((u) => ({ logicalId: u.logical_id, pointer: u.json_pointer })),
  }));

  const caveats: Caveat[] = [];
  if (keys.length > limit) caveats.push(caveat.truncated(entries.length, "keys"));
  return ok(entries, caveats);
}

export interface ValueLink {
  readonly link: string;
  /** 'declares' names the value; 'references' uses it. */
  readonly role: string;
  /** Values declared at the OTHER end of the link. */
  readonly declared: readonly string[];
  /** Where those declarations live, for a follow-up command. */
  readonly declaredBy: readonly { logicalId: string; pointer: string }[];
  /** How many assets declare values for this link, before the display cap. */
  readonly declaredByTotal: number;
  /** Referenced values nothing declares -- vanilla ships some. */
  readonly unresolved: readonly string[];
}

/**
 * The value link a field takes part in, if any.
 *
 * Pass 4 fills `value_links` -- 5 287 rows across three links -- and until now
 * nothing read it. An entire indexing pass with no reader, holding exactly the
 * answers blind trials kept failing to get: `gather-type` records 14 values
 * declared by tools against 16 referenced by blocks, which one agent could only
 * reconstruct by merging three commands and still missed three; another
 * reported flatly that the tool 'cannot define or extend GatherType'.
 *
 * A value link is a string whose legal values are declared somewhere else in
 * the corpus. JSON Schema has no vocabulary for that, so neither `enum` nor a
 * reference target can express it and `describe` had nothing to show.
 */
export function valueLinkFor(
  db: Database,
  assetType: string,
  pointer: string,
): ValueLink | null {
  const site = db
    .prepare(
      `SELECT vl.link, vl.role FROM value_links vl
         JOIN candidates c ON c.asset_id = vl.asset_id AND c.json_pointer = vl.json_pointer
        WHERE c.schema_scope = ? AND c.schema_pointer = ? LIMIT 1`,
    )
    .get(assetType, pointer) as { link: string; role: string } | undefined;
  if (site === undefined) return null;

  const other = site.role === "declares" ? "references" : "declares";
  const declared = (
    db
      .prepare(
        "SELECT DISTINCT value FROM value_links WHERE link = ? AND role = 'declares' ORDER BY value",
      )
      .all(site.link) as unknown as { value: string }[]
  ).map((r) => r.value);

  const declaredBy = db
    .prepare(
      // DISTINCT by asset. Grouping by row listed the same debug asset six times,
      // once per array index, which looks like six sources and names none.
      `SELECT a.logical_id AS logicalId, min(vl.json_pointer) AS pointer
         FROM value_links vl JOIN assets a ON a.id = vl.asset_id
        WHERE vl.link = ? AND vl.role = 'declares'
        GROUP BY a.logical_id ORDER BY a.logical_id LIMIT 6`,
    )
    .all(site.link) as unknown as { logicalId: string; pointer: string }[];

  const unresolved = (
    db
      .prepare(
        `SELECT DISTINCT value FROM value_links
          WHERE link = ? AND role = 'references' AND resolved = 0 ORDER BY value`,
      )
      .all(site.link) as unknown as { value: string }[]
  ).map((r) => r.value);

  void other;
  return {
    link: site.link,
    role: site.role,
    declared,
    declaredBy,
    // Six of 27 read as the complete set. Every other cap in this file
    // announces itself.
    declaredByTotal: count(
      db,
      "SELECT count(DISTINCT asset_id) AS n FROM value_links WHERE link = ? AND role = 'declares'",
      site.link,
    ),
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// Benches
// ---------------------------------------------------------------------------

/**
 * Every bench, including the ones no asset declares.
 *
 * The list was built from declarations alone, so `Fieldcraft` -- hand-crafting,
 * with no physical block to declare it -- was absent from a table titled "all
 * benches" while `bench Fieldcraft` worked and listed nine real recipes, and
 * vanilla's own Workbench recipe requires it. A summary that silently omits a
 * row is the same failure as a truncated list that does not say so.
 */
export function benchesOp(db: Database) {
  return ok(
    db
      .prepare(
        `SELECT ids.id,
                (SELECT bench_type FROM benches b WHERE b.id = ids.id) bench_type,
                (SELECT group_concat(a.logical_id, ', ') FROM bench_declarations d
                   JOIN assets a ON a.id = d.asset_id WHERE d.bench_id = ids.id) declared_by,
                (SELECT count(*) FROM bench_categories c WHERE c.bench_id = ids.id) cats,
                (SELECT count(*) FROM bench_requirements r WHERE r.bench_id = ids.id) reqs,
                -- Fall back to the Type the RECIPES declare. Six ids have no
                -- declaring asset and printed TYPE '?', though every one of
                -- their 78 requirements carries Type 'Crafting' -- the tool had
                -- the answer and showed a question mark.
                (SELECT c.raw_value FROM bench_requirements r
                   JOIN candidates c
                     ON c.asset_id = r.asset_id
                    AND c.json_pointer = r.json_pointer || '/Type'
                  WHERE r.bench_id = ids.id LIMIT 1) req_type,
                -- Whether the id is a declared BenchCategory rather than a bench.
                -- 'Furniture_Misc' is one, typo'd into an Id slot, and the tool
                -- listed it under 'BENCH ID (use this)' with a confident gloss.
                EXISTS (SELECT 1 FROM bench_categories bc WHERE bc.category_id = ids.id)
                  AS is_category
           FROM (SELECT id FROM benches
                 UNION
                 SELECT bench_id FROM bench_requirements) ids
          ORDER BY reqs DESC`,
      )
      .all() as unknown as {
      id: string;
      bench_type: string | null;
      req_type: string | null;
      is_category: number;
      declared_by: string | null;
      cats: number;
      reqs: number;
    }[],
  );
}

export function benchOp(db: Database, benchId: string, limit = 200) {
  const categories = db
    .prepare(
      `SELECT c.category_id, c.parent_id, c.name_key, l.value
         FROM bench_categories c
         LEFT JOIN lang_keys l ON l.key = c.name_key AND l.locale = 'en-US'
        WHERE c.bench_id = ?
        ORDER BY coalesce(c.parent_id, c.category_id), c.parent_id IS NOT NULL, c.category_id`,
    )
    .all(benchId) as unknown as {
    category_id: string;
    parent_id: string | null;
    name_key: string | null;
    value: string | null;
  }[];
  // Over-fetch and total, exactly as the CLI does. This copy called
  // `craftableAt(db, benchId, limit)` and returned no total and no caveat --
  // i.e. it reproduced verbatim the defect `cmdBench`'s own comment records as
  // fixed ('said 200 craftable here while the bench table said 911'). An MCP
  // server reading this layer would have shipped it.
  const fetched = craftableAt(db, benchId, limit + 1);
  const items = fetched.slice(0, limit);
  const total = benchRecipeCount(db, benchId);
  return ok(
    { categories, items, total },
    fetched.length > limit ? [caveat.truncated(items.length, "recipes", total)] : [],
  );
}

/** The bench id declared by an asset, for the "you passed the asset" hint. */
export function benchDeclaredBy(db: Database, logicalId: string): string | null {
  const row = db
    .prepare(
      `SELECT d.bench_id FROM bench_declarations d JOIN assets a ON a.id = d.asset_id
        WHERE a.logical_id = ? LIMIT 1`,
    )
    .get(logicalId) as Record<string, unknown> | undefined;
  return (row?.["bench_id"] as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface IndexStats {
  readonly assets: number;
  readonly typed: number;
  readonly declaredFields: number;
  readonly observedFields: number;
  readonly joinedFields: number;
  readonly edges: number;
  /**
   * Named, never counted.
   *
   * This operation returned `count(DISTINCT locale)` while the CLI, one file
   * over, had already replaced its own count with the names -- because '5
   * locales' led a reader to work out which five by inference and conclude
   * Ukrainian was absent. It is not. An MCP server reading this layer would
   * have shipped the regression the CLI had already fixed.
   */
  readonly locales: readonly string[];
  readonly epoch: number;
}

export function statsOp(db: Database): Result<IndexStats> {
  const stats: IndexStats = {
    assets: count(db, "SELECT count(*) AS n FROM assets"),
    typed: count(db, "SELECT count(*) AS n FROM assets WHERE type IS NOT NULL"),
    declaredFields: count(
      db,
      "SELECT count(*) AS n FROM schema_fields WHERE json_pointer <> ''",
    ),
    observedFields: count(db, "SELECT count(*) AS n FROM field_stats"),
    joinedFields: count(
      db,
      `SELECT count(*) AS n FROM field_stats fs JOIN schema_fields sf
         ON sf.asset_type = fs.asset_type AND sf.json_pointer = fs.json_pointer`,
    ),
    edges: count(db, "SELECT count(*) AS n FROM edges"),
    locales: (
      db
        .prepare("SELECT DISTINCT locale FROM lang_keys ORDER BY locale")
        .all() as unknown as { locale: string }[]
    ).map((r) => r.locale),
    epoch: count(db, "SELECT CAST(ifnull(value,'0') AS INTEGER) AS n FROM meta WHERE key='epoch'"),
  };
  return ok(stats, [
    caveat.joinIncomplete(stats.joinedFields, stats.observedFields, "observed"),
  ]);
}

/** True when a string names a crafting bench rather than an asset. */
export function benchIdExists(db: Database, id: string): boolean {
  return count(db, "SELECT count(*) AS n FROM benches WHERE id = ?", id) > 0;
}

/** How many recipes name this bench, before any display cap. */
export function benchRecipeCount(db: Database, benchId: string): number {
  return count(db, "SELECT count(*) AS n FROM bench_requirements WHERE bench_id = ?", benchId);
}

/**
 * Fields the corpus shows for a type that its schema never declares.
 *
 * `describe Item` lists 96 rows while `undocumented Item` says 95 are declared.
 * Both are right -- describe unions the observed layer -- but printed side by
 * side with no explanation the pair reads as an off-by-one, and a blind trial
 * filed it as one.
 */
export function undeclaredObserved(db: Database, assetType: string): number {
  return count(
    db,
    `SELECT count(*) AS n FROM field_stats fs
      WHERE fs.asset_type = ?1
        AND NOT EXISTS (SELECT 1 FROM schema_fields sf
                         WHERE sf.asset_type = ?1 AND sf.json_pointer = fs.json_pointer)`,
    assetType,
  );
}
