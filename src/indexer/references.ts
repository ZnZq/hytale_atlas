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
  readonly value: string;
}

/** Values too generic to be worth recording as possible references. */
const NOISE_VALUES = new Set(["", "none", "default", "null", "true", "false", "any", "all"]);

/**
 * Longest plausible asset identifier. Anything longer is prose, a path, or a
 * serialised blob, and matching it against the symbol table only wastes rows.
 */
const MAX_CANDIDATE_LENGTH = 96;

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Collects every string scalar worth testing against the symbol table.
 *
 * Array indices are preserved here, unlike in schema pointers: a candidate
 * records where a value literally sits, so that an agent can be told which entry
 * of `Recipe.Input` is broken rather than merely that one of them is.
 */
export function collectCandidates(node: unknown, pointer = "", out: Candidate[] = []): Candidate[] {
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_CANDIDATE_LENGTH &&
      !NOISE_VALUES.has(trimmed.toLowerCase())
    ) {
      out.push({ pointer, value: trimmed });
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectCandidates(v, `${pointer}/${i}`, out));
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
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
    db.exec(`
      INSERT INTO edges (src, dst, kind, json_pointer, confidence)
      SELECT c.asset_id, a.id, 'INHERITS_FROM', c.json_pointer, 'high'
        FROM candidates c
        JOIN assets a ON a.logical_id = c.raw_value
       WHERE c.json_pointer = '/Parent' AND a.id <> c.asset_id
    `);

    // Localization: the reference is an explicit field naming a real key, so this
    // is observed rather than derived.
    // `role` (name/description/...) is the pointer's last segment. Deriving it in
    // SQLite means string surgery with no substring-search function; the query
    // layer splits the pointer instead, which is one line there and none here.
    db.exec(`
      INSERT INTO edges (src, dst, kind, json_pointer, confidence)
      SELECT c.asset_id, l.id, 'LOCALIZED_BY', c.json_pointer, 'high'
        FROM candidates c
        JOIN lang_keys l
          ON l.key = CASE
               WHEN c.raw_value LIKE 'server.%' THEN substr(c.raw_value, 8)
               WHEN c.raw_value LIKE 'common.%' THEN substr(c.raw_value, 8)
               ELSE c.raw_value END
       WHERE c.raw_value LIKE '%.%.%' AND l.locale = 'en-US'
    `);

    // Files: Common/-relative paths carrying an extension.
    db.exec(`
      INSERT INTO edges (src, dst, kind, json_pointer, confidence)
      SELECT c.asset_id, f.id, 'REFERENCES_FILE', c.json_pointer, 'high'
        FROM candidates c
        JOIN files f ON f.path = 'Common/' || c.raw_value
       WHERE c.raw_value LIKE '%.%' AND c.raw_value NOT LIKE '% %'
    `);

    // Asset references. Confidence is assigned from the pointer, since the schema
    // does not declare which fields are references.
    db.exec(`
      INSERT INTO edges (src, dst, kind, json_pointer, confidence)
      SELECT c.asset_id, a.id, 'REFERENCES', c.json_pointer,
             CASE
               WHEN c.json_pointer LIKE '%/Id'
                 OR c.json_pointer LIKE '%Id'
                 OR c.json_pointer LIKE '%/Set'
                 OR c.json_pointer LIKE '%/Model'
                 OR c.json_pointer LIKE '%/BlockType'
                 OR c.json_pointer LIKE '%/BlockTypes/%'
                 OR c.json_pointer LIKE '%/BlockSets/%' THEN 'medium'
               ELSE 'low'
             END
        FROM candidates c
        JOIN assets a ON a.logical_id = c.raw_value
       WHERE c.json_pointer <> '/Parent' AND a.id <> c.asset_id
    `);

    // Mark candidates that named something identifier-shaped but matched nothing.
    db.exec(`
      UPDATE candidates SET dangling = 1
       WHERE raw_value GLOB '[A-Za-z]*[_A-Za-z0-9]*'
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
