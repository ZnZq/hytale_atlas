import type { Database } from "../db/open.ts";
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

export interface DeclaredLayer {
  readonly type: string | null;
  readonly optional: boolean;
  readonly defaultValue: string | null;
  /** The default was a non-finite literal, meaning *unset* rather than null. */
  readonly defaultUnset: boolean;
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
}

export interface FieldDescription {
  readonly assetType: string;
  readonly pointer: string;
  readonly declared: DeclaredLayer | null;
  readonly observed: ObservedLayer | null;
}

function splitList(value: unknown): string[] | null {
  return typeof value === "string" && value.length > 0 ? value.split(" ").filter(Boolean) : null;
}

interface FieldRow {
  asset_type: string;
  json_pointer: string;
  declared_type: string | null;
  optional: number | null;
  default_value: string | null;
  default_unset: number | null;
  enum_values: string | null;
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
}

function toDescription(row: FieldRow): FieldDescription {
  const declared: DeclaredLayer | null =
    row.declared_type === null &&
    row.title === null &&
    row.description === null &&
    row.enum_values === null &&
    row.reference_target === null
      ? null
      : {
          type: row.declared_type,
          optional: row.optional === 1,
          defaultValue: row.default_value,
          defaultUnset: row.default_unset === 1,
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
              SELECT json_pointer FROM schema_fields WHERE asset_type = ?1
              UNION
              SELECT json_pointer FROM field_stats   WHERE asset_type = ?2
            )
       SELECT ?1 AS asset_type, p.json_pointer,
              sf.declared_type, sf.optional, sf.default_value, sf.default_unset,
              sf.enum_values, sf.observed_values, sf.title, sf.description,
              sf.reference_target, sf.inherits_property, sf.merges_properties,
              fs.count, fs.of_total, fs.cardinality, fs.target_types
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
export function searchSchema(db: Database, query: string, limit = 20): SchemaHit[] {
  const statement = db.prepare(
    `SELECT asset_type, json_pointer, title, description
       FROM schema_fts WHERE schema_fts MATCH ? ORDER BY rank LIMIT ?`,
  );

  // Asset search ANDs its terms, because a user naming an asset names it exactly.
  // Schema search is the opposite: a user asking "brush width shape area" is
  // describing a capability from several angles and expects any of them to hit.
  // ANDing returned nothing for exactly that query while each term alone matched.
  const expressions = [
    ...buildRelaxedMatchExpressions(query),
    ...buildRelaxedMatchExpressions(query).map((e) => e.split(" AND ").join(" OR ")),
  ];

  for (const expression of expressions) {
    const rows = statement.all(expression, limit) as unknown as {
      asset_type: string;
      json_pointer: string;
      title: string | null;
      description: string | null;
    }[];
    if (rows.length > 0) {
      return rows.map((r) => ({
        assetType: r.asset_type,
        pointer: r.json_pointer,
        title: r.title,
        description: r.description,
      }));
    }
  }
  return [];
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
        WHERE NOT EXISTS (SELECT 1 FROM field_stats fs
                           WHERE fs.asset_type = sf.asset_type
                             AND fs.json_pointer = sf.json_pointer)${filter}
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
