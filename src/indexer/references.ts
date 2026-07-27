import type { Database } from "../db/open.ts";

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

/** SQL fragment excluding generic values from reference matching. */
const NOT_NOISE = `lower(c.raw_value) NOT IN (${[...NOISE_VALUES]
  .filter((v) => v.length > 0)
  .map((v) => `'${v}'`)
  .join(",")})`;

/**
 * Longest plausible asset identifier. Anything longer is prose, a path, or a
 * serialised blob, and matching it against the symbol table only wastes rows.
 */
const MAX_CANDIDATE_LENGTH = 96;

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
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
    if (trimmed.length > 0 && trimmed.length <= MAX_CANDIDATE_LENGTH) {
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
 */
export type Confidence = "high" | "medium" | "low";

/** Field names whose value is a reference by convention, measured on the corpus. */
const STRONG_SUFFIXES = ["Id", "Ids", "Ref", "Refs", "TypeId", "SetId", "ListId"];
const STRONG_NAMES = new Set([
  "Parent", "ItemId", "BlockType", "BlockTypes", "BlockSets", "Set", "Model",
  "ResourceTypeId", "PlayerAnimationsId", "ItemSoundSetId", "SoundEventId",
]);

export function classifyConfidence(pointer: string, value: string): Confidence {
  const name = pointer.slice(pointer.lastIndexOf("/") + 1);

  // `Parent` is inheritance, which the engine resolves itself; there is no guessing.
  if (name === "Parent") return "high";
  if (STRONG_NAMES.has(name)) return "medium";
  if (STRONG_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length)) return "medium";

  // A bare short word that happens to collide with an identifier. Kept, because
  // the "did you mean" case needs it, but never presented as a fact.
  if (value.length <= 6 || !value.includes("_")) return "low";
  return "low";
}

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
 */
export function resolveCandidates(db: Database): ResolveResult {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM edges WHERE kind IN ('REFERENCES','REFERENCES_FILE','INHERITS_FROM','LOCALIZED_BY')");
    db.exec("UPDATE candidates SET resolved_edge_id = NULL, dangling = 0");

    // Inheritance: an explicit, engine-resolved relationship, not a guess.
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
        JOIN assets a ON a.logical_id = c.raw_value AND a.type IS src.type
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
          ON l.key = CASE
               WHEN c.raw_value LIKE 'server.%' THEN substr(c.raw_value, 8)
               WHEN c.raw_value LIKE 'common.%' THEN substr(c.raw_value, 8)
               ELSE c.raw_value END
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
             CASE
               WHEN c.json_pointer LIKE '%Id'
                 OR c.json_pointer LIKE '%/Set'
                 OR c.json_pointer LIKE '%/Model'
                 OR c.json_pointer LIKE '%/BlockType'
                 OR c.json_pointer LIKE '%/BlockTypes/%'
                 OR c.json_pointer LIKE '%/BlockSets/%' THEN 'medium'
               ELSE 'low'
             END
        FROM candidates c
        JOIN assets src ON src.id = c.asset_id
        JOIN assets a ON a.logical_id = c.raw_value
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
       WHERE value_kind = 'string' AND lower(raw_value) NOT IN ('none','default','null','true','false','any','all') AND EXISTS (
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
      UPDATE candidates SET dangling = 1
       WHERE value_kind = 'string' AND lower(raw_value) NOT IN ('none','default','null','true','false','any','all') AND raw_value GLOB '[A-Za-z]*[_A-Za-z0-9]*'
         AND raw_value NOT LIKE '% %'
         AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.logical_id = candidates.raw_value)
         AND NOT EXISTS (SELECT 1 FROM lang_keys l WHERE l.key = candidates.raw_value)
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
