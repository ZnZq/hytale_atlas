import type { Database } from "../db/open.ts";
import { referenceKeySql } from "../sources/lang.ts";
import { escapeSegment } from "../util/json.ts";

/** One candidate, with the raw document position it was collected from. */
export interface CandidateRow {
  asset_id: number;
  json_pointer: string;
  raw_value: string;
}

/**
 * Candidates of one resolved schema field.
 *
 * Lives here because this pass owns what a candidate IS. The bench pass and the
 * value-link pass read the same table through the same predicate and each kept a
 * byte-identical copy of this, so a column either of them came to need -- or any
 * change to the `schema_scope` form -- would have been applied to one and not the
 * other, and the two passes would have disagreed about the same rows.
 */
export function candidateRows(db: Database, scope: string, pointer: string): CandidateRow[] {
  return db
    .prepare(
      `SELECT asset_id, json_pointer, raw_value FROM candidates
        WHERE schema_scope = ? AND schema_pointer = ?`,
    )
    .all(scope, pointer) as unknown as CandidateRow[];
}

/**
 * Pass 2 — candidate extraction and reference resolution.
 *
 * Every string scalar in every asset becomes a **candidate**
 * `(asset, json_pointer, raw_value)`. Candidates that match the symbol table
 * become edges; those that do not are **kept**, because that table is what makes
 * incremental indexing possible at all: when an asset is later added, the edges
 * that should point at it are one indexed lookup away instead of a full corpus
 * walk (`docs/init/03-ARCHITECTURE.md` §Incremental).
 *
 * Resolution runs in SQL rather than in JavaScript. The alternative — re-reading
 * and re-parsing 32 704 documents after the symbol table is complete — costs a
 * second full pass over a 3.4 GB archive to compute a join SQLite already does
 * against an index.
 */

export interface Candidate {
  readonly pointer: string;
  /** `pointer` with array indices collapsed to `*`, matching schema_fields. */
  readonly schemaPointer: string;
  readonly value: string;
  /** Only `string` can be a reference; the rest exist so the field is not "unused". */
  readonly kind: "string" | "number" | "boolean";
}

/**
 * Collapses array indices so a document location can be joined to a schema field.
 *
 * `/Recipe/Input/0/ItemId` becomes `/Recipe/Input/*​/ItemId`. Dynamic map keys are
 * not collapsed here: at extraction time a map key is indistinguishable from a
 * property name without consulting the schema, so those simply fail to join and
 * fall back to the heuristic tier.
 */
export function toSchemaPointer(pointer: string): string {
  return pointer.replace(/\/\d+(?=\/|$)/g, "/*");
}

/**
 * Values too generic to be worth testing against the symbol table.
 *
 * They are still COLLECTED -- they are real data. Dropping them at extraction
 * removed them from the observed layer as well, and several are meaningful
 * values in their own right: `Default` is the stage set every crop starts in,
 * and `All` is a bench category declared by both Farmingbench and Loombench.
 * `describe common:FarmingData --field StartingStageSet` consequently reported
 * `seen: Starting, used in 2 assets` -- true of the two Tomato assets that spell
 * it differently, and silent about every other crop, which an agent reasonably
 * read as the command being wrong.
 *
 * Filtered at edge-resolution time instead, the same way numbers are.
 */
const NOISE_VALUES = new Set(["", "none", "default", "null", "true", "false", "any", "all"]);

/**
 * SQL fragment excluding generic values, for whichever column holds the value.
 *
 * Every site derives its list from {@link NOISE_VALUES} rather than spelling one
 * out: the dangling passes here and in `stats.ts` each carried a hand-written
 * copy, so the set was declared once and written three times. They agreed only
 * by inspection, and nothing would have failed had they stopped agreeing.
 */
export function notNoise(column: string): string {
  return `lower(${column}) NOT IN (${[...NOISE_VALUES]
    .filter((v) => v.length > 0)
    .map((v) => `'${v}'`)
    .join(",")})`;
}

const NOT_NOISE = notNoise("c.raw_value");

/**
 * Longest plausible asset identifier. Anything longer is prose, a path, or a
 * serialised blob, and matching it against the symbol table only wastes rows.
 */
const MAX_CANDIDATE_LENGTH = 96;

/**
 * The same ceiling for a value that names a **file** rather than an asset.
 *
 * The identifier limit was applied to every string, and a file path is not an
 * identifier: measured on the release corpus, 1 144 scalar strings exceed 96
 * characters and **959 of them name a path that is already in `files`**. Every
 * one was an edge the file rule below would have made and never saw -- audio
 * above all, since `Sounds/Environments/Zone1/.../Emit_Bird_Wings_Stereo_01.ogg`
 * is 97 characters before anyone has done anything unusual. 403 of 4 243 `.ogg`
 * files had no inbound reference as a result, and `refs <sound>` answered
 * "nothing points at this" about a file three assets point at.
 *
 * Longest `Common/`-relative path in the archive is 137, so this leaves room for
 * a patch to add deeper trees without silently truncating the graph again.
 */
const MAX_PATH_CANDIDATE_LENGTH = 192;

/**
 * Whether a value is shaped like the `Common/`-relative path the file rule joins on.
 *
 * Deliberately the same shape that rule tests for -- a dot, no spaces -- plus a
 * slash. Nothing in the archive sits directly in `Common/`, so requiring the
 * slash costs no edge and keeps long prose out of the exemption.
 */
function isPathLike(value: string): boolean {
  return value.includes("/") && value.includes(".") && !value.includes(" ");
}

/**
 * Collects every scalar leaf: strings to test against the symbol table, numbers
 * and booleans so the observed layer knows they exist.
 *
 * Array indices are preserved here, unlike in schema pointers: a candidate
 * records where a value literally sits, so that an agent can be told which entry
 * of `Recipe.Input` is broken rather than merely that one of them is.
 *
 * **Numbers and booleans were originally skipped**, on the reasoning that they can
 * never be references -- which is true, and which is handled by `value_kind`
 * rather than by not looking. Skipping them meant all 1 963 non-string scalar
 * fields were missing from `field_stats` and so reported as `unused`, a claim
 * `describe_schema` makes about the corpus while it was really a claim about
 * extraction. `Item./ItemLevel` was labelled unused while vanilla items set it to
 * 40 and 5.
 *
 * Noise filtering stays string-only on purpose: `0`, `1` and `false` are ordinary
 * values, not the placeholder junk `NOISE_VALUES` exists to drop.
 */
export function collectCandidates(node: unknown, pointer = "", out: Candidate[] = []): Candidate[] {
  if (typeof node === "string") {
    const trimmed = node.trim();
    const limit = isPathLike(trimmed) ? MAX_PATH_CANDIDATE_LENGTH : MAX_CANDIDATE_LENGTH;
    if (trimmed.length > 0 && trimmed.length <= limit) {
      out.push({ pointer, schemaPointer: toSchemaPointer(pointer), value: trimmed, kind: "string" });
    }
    return out;
  }
  if (typeof node === "number" || typeof node === "boolean") {
    // Non-finite numbers arrive as the repaired sentinel from parseJsonLenient and
    // mean "unset", not "observed at this value".
    if (typeof node === "number" && !Number.isFinite(node)) return out;
    out.push({
      pointer,
      schemaPointer: toSchemaPointer(pointer),
      value: String(node),
      kind: typeof node === "number" ? "number" : "boolean",
    });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectCandidates(v, `${pointer}/${i}`, out));
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // Node-editor scratch keys are stripped from the schema side already; not
      // stripping them here left thousands of observed-but-undeclared rows
      // (`/$NodeId`, `/$NodeEditorMetadata/$Groups/*/$name`) that can never join.
      if (k.startsWith("$")) continue;
      collectCandidates(v, `${pointer}/${escapeSegment(k)}`, out);
    }
  }
  return out;
}

/**
 * Confidence for a resolved reference.
 *
 * `03-ARCHITECTURE.md` §Confidence expected schema to supply a `high` tier by
 * declaring which fields are references. Measurement disproved that: the
 * generated schema does not mark reference targets, so the tier has to be earned
 * from the pointer and the value instead. Tiers are therefore honest guesses,
 * which is exactly why low-confidence edges are kept and filtered at query time
 * rather than discarded at index time.
 *
 * THE RULE LIVES IN SQL, in `resolveCandidates` below, and only there. A second
 * implementation of it stood here -- `classifyConfidence`, with its own
 * STRONG_NAMES list -- called by nothing, its last branch a tautology returning
 * `low` either way, and disagreeing with the SQL that actually runs: it graded
 * `/Parent` as `high` by name while the query grades by edge KIND, and it knew
 * nothing of the GLOB rule that stops `/Solid` and `/Fluid` being promoted. A
 * maintainer extending the tiers would have read the prose-shaped copy, changed
 * it, seen the tests pass because nothing calls it, and shipped no behaviour
 * change at all. It is removed rather than revived: the SQL is authoritative and
 * the `confidence` column the docs describe is written by it.
 */
export interface ResolveResult {
  readonly candidates: number;
  readonly references: number;
  readonly fileReferences: number;
  readonly inherits: number;
  readonly localizedBy: number;
  readonly dangling: number;
  /**
   * Declared references whose target type has no asset of that name.
   *
   * Stronger than an ordinary dangling string: the schema states what the field
   * points at, so this is a broken reference rather than a guess that missed.
   */
  readonly brokenDeclared: number;
  /** Distinct raw values that matched an asset id but look like noise. */
  readonly ambiguous: number;
}

/**
 * Turns stored candidates into edges with one indexed join per edge kind.
 *
 * Deliberately does not delete unmatched candidates. They are the dangling
 * references `validate_pack` reports, and the hook that lets a later-added asset
 * light up the edges pointing at it.
 *
 * **Edges terminate on the definition the engine loads**, hence `a.is_effective
 * = 1` on every destination join. A pack override is whole-asset replacement and
 * the losers are inert, but drawing an edge to every copy made one `/Parent`
 * report two parents -- an inheritance graph that is not a tree, at `high` --
 * and split an asset's inbound set across the winning row and the shadowed one.
 * 137 (logical_id, type) groups are defined by more than one pack in a real mods
 * folder, so this is the common case, not the exotic one. Runs after
 * `markEffective`, which `cmdIndex` already sequences.
 *
 * `REFERENCES_FILE` is the exception: `files` carries no `is_effective`, so a
 * file reference cannot yet be narrowed the same way.
 */
export function resolveCandidates(db: Database): ResolveResult {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM edges WHERE kind IN ('REFERENCES','REFERENCES_FILE','INHERITS_FROM','LOCALIZED_BY')");
    db.exec("UPDATE candidates SET resolved_edge_id = NULL, dangling = 0");

    // Inheritance: an explicit, engine-resolved relationship, not a guess.
    //
    // `=`, not `IS`. SQLite's `IS` treats NULL as comparable, so two UNTYPED
    // assets sharing a logical_id satisfied "the same type" and inherited from
    // each other -- at `high`, the tier that means "not a heuristic at all",
    // while nothing is known about either one's type. It produces no edge on the
    // release corpus only because the untyped population is voxel data excluded
    // from candidate extraction; 243 untyped assets live outside those roots and
    // one `/Parent` among them is enough. `=` yields NULL for an unknown type,
    // so the row is simply not claimed.
    //
    // **Within a type.** A BlockSoundSet with Parent "Stone" inherits from the
    // BlockSoundSet named Stone, never from the PhysicalMaterial, BlockSet or
    // BlockParticleSet that happen to share the name. Matching on the identifier
    // alone produced an edge to every one of them: 845 of 4 575 inheritance edges
    // pointed at the wrong type, all labelled `high` -- the tier that means "not a
    // heuristic at all". `refs Stone --type PhysicalMaterial` therefore returned
    // the identical rows as `--type BlockSoundSet`, and the count was exactly 4x
    // the truth.
    db.exec(`
      INSERT INTO edges (src, dst, dst_kind, kind, json_pointer, confidence)
      SELECT c.asset_id, a.id, 'asset', 'INHERITS_FROM', c.json_pointer, 'high'
        FROM candidates c
        JOIN assets src ON src.id = c.asset_id
        JOIN assets a ON a.logical_id = c.raw_value AND a.type = src.type
                     AND a.is_effective = 1
       WHERE c.value_kind = 'string' AND ${NOT_NOISE}
         AND c.json_pointer = '/Parent' AND a.id <> c.asset_id
    `);


    // Localization: the reference is an explicit field naming a real key, so this
    // is observed rather than derived.
    // `role` (name/description/...) is the pointer's last segment. Deriving it in
    // SQLite means string surgery with no substring-search function; the query
    // layer splits the pointer instead, which is one line there and none here.
    db.exec(`
      INSERT INTO edges (src, dst, dst_kind, kind, json_pointer, confidence)
      SELECT c.asset_id, l.id, 'lang_key', 'LOCALIZED_BY', c.json_pointer, 'high'
        FROM candidates c
        JOIN lang_keys l
          ON l.key = ${referenceKeySql("c.raw_value")}
       WHERE c.value_kind = 'string' AND ${NOT_NOISE}
         AND c.raw_value LIKE '%.%.%' AND l.locale = 'en-US'
    `);

    // Files: Common/-relative paths carrying an extension.
    db.exec(`
      INSERT INTO edges (src, dst, dst_kind, kind, json_pointer, confidence)
      SELECT c.asset_id, f.id, 'file', 'REFERENCES_FILE', c.json_pointer, 'high'
        FROM candidates c
        JOIN files f ON f.path = 'Common/' || c.raw_value
       WHERE c.value_kind = 'string' AND ${NOT_NOISE}
         AND c.raw_value LIKE '%.%' AND c.raw_value NOT LIKE '% %'
    `);

    // Asset references, in two steps.
    //
    // `hytale.hytaleAssetRef` names the asset type a field points at -- 849 fields
    // across 70 targets. Where it is present the reference is a declared fact, and
    // crucially it also **disambiguates the target**: `Wood` exists simultaneously
    // as a PhysicalMaterial, a BlockSoundSet and a BlockParticleSet, and matching
    // on name alone produced an edge to each. Requiring the declared type picks the
    // one the field actually means.
    //
    //   high    declared target type, and an asset of that type carries the name
    //   medium  no declared target, but the field name follows a naming convention
    //   low     neither: the value merely collides with some identifier
    db.exec(`
      INSERT INTO edges (src, dst, dst_kind, kind, json_pointer, confidence)
      SELECT c.asset_id, a.id, 'asset', 'REFERENCES', c.json_pointer, 'high'
        FROM candidates c
        JOIN assets src ON src.id = c.asset_id
        JOIN schema_fields sf
               ON sf.asset_type = src.type
              AND sf.json_pointer = c.schema_pointer
              AND sf.reference_target IS NOT NULL
        JOIN assets a
               ON a.logical_id = c.raw_value
              AND a.type = sf.reference_target
              AND a.is_effective = 1
       WHERE c.value_kind = 'string' AND ${NOT_NOISE}
         AND c.json_pointer <> '/Parent' AND a.id <> c.asset_id
    `);

    // Everything else: no declared target, or a declared target that nothing of
    // that type answers to. The second case is a genuine finding -- a reference
    // pointing at the wrong kind of asset, or at nothing -- and is left to the
    // dangling pass below rather than fabricated into an edge of the wrong type.
    db.exec(`
      INSERT INTO edges (src, dst, dst_kind, kind, json_pointer, confidence)
      SELECT c.asset_id, a.id, 'asset', 'REFERENCES', c.json_pointer,
             -- GLOB, not LIKE. SQLite's LIKE folds ASCII case, so '%Id' also
             -- matched /Solid, /Fluid, /TransformFluid and /SpreadFluid: 5 292
             -- edges were promoted to 'medium' under a legend that reads "the
             -- field name follows a reference convention". /Material/Solid
             -- follows no such convention -- it is the word 'solid'.
             CASE
               WHEN c.json_pointer GLOB '*Id'
                 OR c.json_pointer GLOB '*/Set'
                 OR c.json_pointer GLOB '*/Model'
                 OR c.json_pointer GLOB '*/BlockType'
                 OR c.json_pointer GLOB '*/BlockTypes/*'
                 OR c.json_pointer GLOB '*/BlockSets/*' THEN 'medium'
               ELSE 'low'
             END
        FROM candidates c
        JOIN assets src ON src.id = c.asset_id
        JOIN assets a ON a.logical_id = c.raw_value AND a.is_effective = 1
       WHERE c.value_kind = 'string' AND ${NOT_NOISE}
         AND c.json_pointer <> '/Parent'
         AND a.id <> c.asset_id
         AND NOT EXISTS (
               SELECT 1 FROM schema_fields sf
                WHERE sf.asset_type = src.type
                  AND sf.json_pointer = c.schema_pointer
                  AND sf.reference_target IS NOT NULL)
    `);

    // A declared reference whose target type has no such asset: the field says it
    // points at an X named N, and no X is named N. Recorded distinctly from an
    // ordinary dangling string, because the schema makes this one unambiguous.
    db.exec(`
      UPDATE candidates SET dangling = 2
       WHERE value_kind = 'string' AND ${notNoise("raw_value")} AND EXISTS (
             SELECT 1 FROM assets src
               JOIN schema_fields sf
                 ON sf.asset_type = src.type
                AND sf.json_pointer = candidates.schema_pointer
                AND sf.reference_target IS NOT NULL
              WHERE src.id = candidates.asset_id
                AND NOT EXISTS (
                      SELECT 1 FROM assets a
                       WHERE a.logical_id = candidates.raw_value
                         AND a.type = sf.reference_target))
    `);

    // Mark candidates that named something identifier-shaped but matched nothing.
    db.exec(`
      -- Never over the stronger marker. This UPDATE had no guard, so it
      -- overwrote every dangling = 2 row set moments earlier and the count of
      -- 'the schema says this points at an X named N, and no X is named N'
      -- came out as 1.
      --
      -- 'Matched nothing' means no edge, not 'no asset and no lang key'. Testing
      -- only those two tables marked every resolved FILE reference dangling --
      -- all 33 782 of them -- because a file is neither, and every localization
      -- reference carrying a 'server.' root, because the LOCALIZED_BY join strips
      -- that prefix and this test did not. 39 320 of the 119 723 rows reported as
      -- 'identifier-shaped string matching nothing' had a visible edge saying
      -- what they matched. Asking the edges directly covers every edge kind,
      -- including any added later.
      UPDATE candidates SET dangling = 1
       WHERE dangling = 0 AND value_kind = 'string' AND ${notNoise("raw_value")}
         -- Two characters minimum, and that is deliberate rather than incidental:
         -- the GLOB reads as "a letter, then anything, then an identifier
         -- character", which cannot match a single character. 1 030 one-letter
         -- values name no asset -- Seed 'A' on four noise assets, Axis 'Y' on
         -- the scanners -- and they are scalar values, not identifiers that
         -- failed to resolve. Calling them dangling would report 1 030 broken
         -- references that are nothing of the kind.
         AND raw_value GLOB '[A-Za-z]*[_A-Za-z0-9]*'
         AND raw_value NOT LIKE '% %'
         AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.logical_id = candidates.raw_value)
         AND NOT EXISTS (SELECT 1 FROM lang_keys l WHERE l.key = candidates.raw_value)
         AND NOT EXISTS (SELECT 1 FROM edges e
                          WHERE e.src = candidates.asset_id
                            AND e.json_pointer = candidates.json_pointer)
    `);

    const count = (sql: string): number =>
      (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;

    const result: ResolveResult = {
      candidates: count("SELECT count(*) AS n FROM candidates"),
      references: count("SELECT count(*) AS n FROM edges WHERE kind = 'REFERENCES'"),
      fileReferences: count("SELECT count(*) AS n FROM edges WHERE kind = 'REFERENCES_FILE'"),
      inherits: count("SELECT count(*) AS n FROM edges WHERE kind = 'INHERITS_FROM'"),
      localizedBy: count("SELECT count(*) AS n FROM edges WHERE kind = 'LOCALIZED_BY'"),
      dangling: count("SELECT count(*) AS n FROM candidates WHERE dangling = 1"),
      brokenDeclared: count("SELECT count(*) AS n FROM candidates WHERE dangling = 2"),
      ambiguous: count(
        "SELECT count(*) AS n FROM edges WHERE kind = 'REFERENCES' AND confidence = 'low'",
      ),
    };
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
