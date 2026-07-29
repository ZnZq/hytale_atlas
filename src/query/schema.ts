import type { Database } from "../db/open.ts";
import { splitValues } from "../db/values.ts";
import { buildRelaxedMatchExpressions } from "../util/text.ts";

/**
 * Schema queries: `describe_schema`, `search_schema`, `find_undocumented`.
 *
 * `describe_schema` carries **two layers** and never merges them
 * (`docs/init/04-MCP-SURFACE.md`):
 *
 * - **declared** -- what the game accepts, from its own generated schema
 * - **observed** -- what vanilla actually does, from the indexed corpus
 *
 * A field can have one, the other, or both. Declared-only is the input to
 * `find_undocumented`; observed-only means either the corpus carries a field the
 * schema does not describe, or our pointer normalisation is wrong -- both worth
 * surfacing rather than hiding.
 */

/**
 * True when a declared type holds other fields rather than a value of its own.
 *
 * Containers never produce a candidate, so absence from the observed layer says
 * nothing about whether the corpus uses them. Reporting them as `unused` was the
 * same error as `search_schema` claiming a capability did not exist: a limit of
 * extraction presented as a fact about the data.
 */
export function isContainer(declaredType: string | null): boolean {
  if (declaredType === null) return false;
  return (
    declaredType.includes("object") ||
    declaredType.includes("array") ||
    declaredType === "anyOf" ||
    declaredType === "oneOf" ||
    declaredType.startsWith("$ref")
  );
}

/**
 * Repairs a `--field` argument that a shell mangled, and accepts looser forms.
 *
 * A JSON Pointer starts with `/`, which is hostile on Windows: MSYS (Git Bash,
 * and therefore most agent harnesses here) rewrites a leading-slash argument into
 * a Windows path, so `--field /BlockType` reaches the process as
 * `C:/Program Files/Git/BlockType`. The pointer never arrives, the lookup finds
 * nothing, and the failure looks like the field does not exist -- an agent
 * testing this concluded `--field` was "completely broken" after six attempts,
 * including one pointer copied verbatim from our own output.
 *
 * So: strip a drive-letter prefix, and treat a missing leading slash as fine.
 */
export function normalizeFieldPointer(field: string): string {
  let out = field;
  const drive = /^[A-Za-z]:[\\/]/.test(out);
  if (drive) {
    // Keep only the tail the user actually typed. MSYS prepends its install root,
    // whose segments are real directories, so cut at the last one that exists in
    // no pointer: the first segment starting with an upper-case letter after the
    // known root is the safest anchor we have, and callers are told what we did.
    const segments = out.replace(/\\/g, "/").split("/");
    const git = segments.findIndex((s) => s.toLowerCase() === "git" || s.toLowerCase() === "usr");
    out = "/" + (git >= 0 ? segments.slice(git + 1) : segments.slice(1)).join("/");
  }
  if (!out.startsWith("/")) out = `/${out}`;
  return out.replace(/\/+$/, "") || "/";
}

/** True when a `--field` value shows signs of shell path mangling. */
export function looksMangled(field: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(field);
}

/** Declared pointers of a type that begin with `prefix`, for "did you mean". */
export function pointersLike(
  db: Database,
  assetType: string,
  prefix: string,
  limit = 8,
): string[] {
  return (
    db
      .prepare(
        `SELECT json_pointer FROM schema_fields
          WHERE asset_type = ? AND json_pointer LIKE ? || '%'
          ORDER BY length(json_pointer), json_pointer LIMIT ?`,
      )
      .all(assetType, prefix, limit) as unknown as { json_pointer: string }[]
  ).map((r) => r.json_pointer);
}

export interface DeclaredLayer {
  readonly type: string | null;
  readonly optional: boolean;
  readonly defaultValue: string | null;
  /** The default was a non-finite literal, meaning *unset* rather than null. */
  readonly defaultUnset: boolean;
  /**
   * The single value this field must hold, for a union branch's discriminator.
   *
   * Distinct from `enumValues`, which on those fields lists every value the
   * union as a whole allows. Printing the union's list as `legal:` directly
   * under "must be set to the constant value 'Crafting'" invited the reader to
   * pick any of the four -- and picking another selects a different schema
   * shape, so the very next field they set would be wrong.
   */
  readonly typeConstant: string | null;
  /** Complete legal set, when the schema declares one. */
  readonly enumValues: readonly string[] | null;
  readonly title: string | null;
  readonly description: string | null;
  /** Asset type this field points at, when declared. */
  readonly referenceTarget: string | null;
  readonly inheritsProperty: boolean;
  readonly mergesProperties: boolean;
}

export interface ObservedLayer {
  /** Occurrences across the corpus. */
  readonly count: number;
  /** Distinct assets carrying it. */
  readonly assets: number;
  /** Distinct values seen. */
  readonly cardinality: number;
  /**
   * Values seen, when few enough to enumerate.
   *
   * **Not the legal set.** These are what vanilla happens to use; a field may
   * accept more. Only `declared.enumValues` is exhaustive.
   */
  readonly values: readonly string[] | null;
  /** Asset types this field was seen to resolve to. */
  readonly targetTypes: readonly string[] | null;
  /**
   * JSON types seen at this pointer: `string`, `number`, `boolean`.
   *
   * Carries its weight on the 418 fields the schema does not declare, where
   * there is no `declared.type` to read and this is the only statement of what
   * the field holds. `field_stats.value_types` was written by the indexer and
   * read by nothing, so `describe` showed those fields with a count and no type.
   */
  readonly valueTypes: readonly string[] | null;
}

export interface FieldDescription {
  readonly assetType: string;
  readonly pointer: string;
  readonly declared: DeclaredLayer | null;
  readonly observed: ObservedLayer | null;
}

/** One decoder for both writers, so the two cannot drift apart again. */
const splitList = splitValues;

interface FieldRow {
  asset_type: string;
  json_pointer: string;
  declared_type: string | null;
  optional: number | null;
  default_value: string | null;
  default_unset: number | null;
  enum_values: string | null;
  type_constant: string | null;
  observed_values: string | null;
  title: string | null;
  description: string | null;
  reference_target: string | null;
  inherits_property: number | null;
  merges_properties: number | null;
  count: number | null;
  of_total: number | null;
  cardinality: number | null;
  target_types: string | null;
  value_types: string | null;
}

function toDescription(row: FieldRow): FieldDescription {
  const declared: DeclaredLayer | null =
    row.declared_type === null &&
    row.title === null &&
    row.description === null &&
    row.enum_values === null &&
    row.type_constant === null &&
    row.reference_target === null
      ? null
      : {
          type: row.declared_type,
          optional: row.optional === 1,
          defaultValue: row.default_value,
          defaultUnset: row.default_unset === 1,
          typeConstant: row.type_constant,
          enumValues: splitList(row.enum_values),
          title: row.title,
          description: row.description,
          referenceTarget: row.reference_target,
          inheritsProperty: row.inherits_property === 1,
          mergesProperties: row.merges_properties === 1,
        };

  const observed: ObservedLayer | null =
    row.count === null
      ? null
      : {
          count: row.count,
          assets: row.of_total ?? 0,
          cardinality: row.cardinality ?? 0,
          values: splitList(row.observed_values),
          targetTypes: splitList(row.target_types),
          valueTypes: splitList(row.value_types),
        };

  return { assetType: row.asset_type, pointer: row.json_pointer, declared, observed };
}

/**
 * Every field of a type, or one field when `pointer` is given.
 *
 * A FULL OUTER JOIN in spirit: schema-only and corpus-only fields both appear,
 * because "this exists but nothing uses it" and "this is used but undeclared" are
 * exactly the two findings worth having.
 */
export function describeSchema(
  db: Database,
  assetType: string,
  pointer?: string,
): FieldDescription[] {
  // One pass over the union of both pointer sets, rather than a UNION of two
  // SELECTs. The earlier UNION form silently returned nothing: it needed the type
  // and pointer bound twice, and one mismatched binding produced an empty result
  // for types that plainly had rows.
  const filter = pointer === undefined ? "" : " AND p.json_pointer = ?";
  const params = pointer === undefined ? [assetType, assetType] : [assetType, assetType, pointer];

  const rows = db
    .prepare(
      `WITH p(json_pointer) AS (
              -- The empty pointer is the TYPE row, not a field: it carries the
              -- root union branches and the type-level mergesProperties marker.
              -- Once those rows existed for every type, describe printed a
              -- nameless leading row and its count ran one ahead of
              -- undocumented for 996 types.
              SELECT json_pointer FROM schema_fields
               WHERE asset_type = ?1 AND json_pointer <> ''
              UNION
              SELECT json_pointer FROM field_stats   WHERE asset_type = ?2
            )
       SELECT ?1 AS asset_type, p.json_pointer,
              sf.declared_type, sf.optional, sf.default_value, sf.default_unset,
              sf.enum_values, sf.type_constant, coalesce(sf.observed_values, fs.observed_values) AS observed_values,
              sf.title, sf.description,
              sf.reference_target, sf.inherits_property, sf.merges_properties,
              fs.count, fs.of_total, fs.cardinality, fs.target_types, fs.value_types
         FROM p
         LEFT JOIN schema_fields sf
                ON sf.asset_type = ?1 AND sf.json_pointer = p.json_pointer
         LEFT JOIN field_stats fs
                ON fs.asset_type = ?2 AND fs.json_pointer = p.json_pointer
        WHERE 1 = 1${filter}
        ORDER BY p.json_pointer`,
    )
    .all(...(params as never[])) as unknown as FieldRow[];

  return rows.map(toDescription);
}

export interface SchemaHit {
  readonly assetType: string;
  readonly pointer: string;
  readonly title: string | null;
  readonly description: string | null;
}

/**
 * Full-text over the schema itself.
 *
 * Answers "where does capability X live, and does it exist at all" -- the one
 * question a corpus search structurally cannot, because absence is invisible to a
 * search over what exists. See `docs/evaluation/README.md` on the 3x3 pickaxe.
 */
export interface SchemaSearchResult {
  readonly hits: readonly SchemaHit[];
  /**
   * How much the query had to be loosened. 0 means every term matched as typed.
   *
   * Reported because a loosened match is a different kind of answer. Searching
   * "quarry" returned CurveType, EasingType and MoonPhaseWeightModifiers -- three
   * rows with no visible relation to the query, indistinguishable from real hits,
   * because suffix-trimming reduced the term until something matched. A caller
   * drawing a negative conclusion needs to know which of the two they got.
   */
  readonly relaxation: number;
  /** True when terms were ORed rather than ANDed to find anything at all. */
  readonly widened: boolean;
}

export function searchSchema(db: Database, query: string, limit = 20): readonly SchemaHit[] {
  return searchSchemaDetailed(db, query, limit).hits;
}

export function searchSchemaDetailed(
  db: Database,
  query: string,
  limit = 20,
): SchemaSearchResult {
  const statement = db.prepare(
    `SELECT asset_type, json_pointer, title, description
       FROM schema_fts WHERE schema_fts MATCH ? ORDER BY rank LIMIT ?`,
  );

  // Asset search ANDs its terms, because a user naming an asset names it exactly.
  // Schema search is the opposite: a user asking "brush width shape area" is
  // describing a capability from several angles and expects any of them to hit.
  // ANDing returned nothing for exactly that query while each term alone matched.
  const strict = buildRelaxedMatchExpressions(query);
  const expressions = [
    ...strict.map((e, i) => ({ e, relaxation: i, widened: false })),
    ...strict.map((e, i) => ({
      e: e.split(" AND ").join(" OR "),
      relaxation: i,
      widened: true,
    })),
  ];

  for (const { e: expression, relaxation, widened } of expressions) {
    const rows = statement.all(expression, limit) as unknown as {
      asset_type: string;
      json_pointer: string;
      title: string | null;
      description: string | null;
    }[];
    if (rows.length > 0) {
      return {
        hits: rows.map((r) => ({
          assetType: r.asset_type,
          pointer: r.json_pointer,
          title: r.title,
          description: r.description,
        })),
        relaxation,
        widened,
      };
    }
  }
  return { hits: [], relaxation: 0, widened: false };
}

export interface UndocumentedField {
  readonly assetType: string;
  readonly pointer: string;
  readonly declaredType: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly referenceTarget: string | null;
}

/**
 * What "declared but never observed" means, in one place.
 *
 * Containers are excluded, not deprioritised: an object, array or `$ref` pointer
 * holds no scalar of its own, so it can never reach `field_stats` however heavily
 * the corpus uses it. Listing them makes a limit of extraction look like a
 * discovery.
 *
 * Exported because the indexer counts the same population for the line `index`
 * prints, and the two filters had drifted: the indexer omitted the `$ref` clause,
 * so it reported **8 439 declared-but-unused** while `undocumented` -- reading the
 * same table for the same question -- answered **7 405**. 1 035 `$ref` rows, one
 * predicate, two numbers a reader has no way to reconcile.
 */
export const DECLARED_UNOBSERVED_SQL = `
  ifnull(sf.declared_type,'') NOT LIKE '%object%'
  AND ifnull(sf.declared_type,'') NOT LIKE '%array%'
  AND ifnull(sf.declared_type,'') NOT LIKE '$ref%'
  AND ifnull(sf.declared_type,'') NOT IN ('anyOf','oneOf')
  AND NOT EXISTS (SELECT 1 FROM field_stats fs
                   WHERE fs.asset_type = sf.asset_type
                     AND fs.json_pointer = sf.json_pointer)`;

/**
 * Fields the schema permits that appear in **zero** vanilla assets.
 *
 * Framing matters and the tool description must carry it: these are *fields the
 * schema permits*, not "undocumented features". Such a field may be deprecated,
 * engine-internal, populated programmatically rather than from JSON, or a debug
 * hook (`docs/init/04-MCP-SURFACE.md`, `OPEN-QUESTIONS.md` Q15).
 *
 * The game's own `description` is the best available signal for telling a live
 * capability from a vestigial one, which is why it is returned alongside.
 */
export function findUndocumented(
  db: Database,
  assetType?: string,
  limit = 100,
): UndocumentedField[] {
  const filter = assetType === undefined ? "" : " AND sf.asset_type = ?";
  const params = assetType === undefined ? [limit] : [assetType, limit];

  const rows = db
    .prepare(
      `SELECT sf.asset_type, sf.json_pointer, sf.declared_type, sf.title,
              sf.description, sf.reference_target
         FROM schema_fields sf
        WHERE ${DECLARED_UNOBSERVED_SQL}${filter}
        ORDER BY sf.asset_type, sf.json_pointer
        LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as {
    asset_type: string;
    json_pointer: string;
    declared_type: string | null;
    title: string | null;
    description: string | null;
    reference_target: string | null;
  }[];

  return rows.map((r) => ({
    assetType: r.asset_type,
    pointer: r.json_pointer,
    declaredType: r.declared_type,
    title: r.title,
    description: r.description,
    referenceTarget: r.reference_target,
  }));
}
