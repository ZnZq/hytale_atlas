import type { Database } from "../db/open.ts";
import { scopes } from "../sources/schema-doc.ts";

/**
 * Value links -- the one kind of domain knowledge the index has to carry.
 *
 * JSON Schema can say "this is a string" and, via `hytaleAssetRef`, "this points
 * at an asset of type T". It cannot say "the legal values of this field are
 * whatever some other field declares". Three such relationships exist in this
 * corpus and none is visible to the reference resolver: the marker it needs is
 * absent, and the values are not asset ids to fall back on.
 *
 * The distinction this module is built around: a **fact about the data** (where a
 * string is declared) belongs in the index, because deriving it means scanning
 * 35 074 assets. A **fact about the world** ("a bench is where you craft") does
 * not -- the agent already knows it, and an index restating it goes stale without
 * anyone noticing. So each link below states pointers and nothing else. No entry
 * says what a bench *is*.
 *
 * Everything except these few lines is read from the schema at index time. That
 * was not the original design: the bench model first hardcoded JSON pointers
 * lifted from the corpus, and all four of its defects came from guessing a shape
 * instead of reading the declared one -- an invented nesting level that matched
 * nothing while dropping the 12 real nested categories, a discriminator written as
 * NULL though the schema declares it an enum, a second declarer silently
 * discarded, and an unhandled sibling field.
 *
 * **Why these are declared rather than discovered.** A generic value-set
 * containment detector was built and run over 1 553 qualifying pointers. It
 * produced 49 pairs at coverage >= 0.8, of which roughly 6 were real -- the rest
 * being one 5-value `Attitude` enum reused across the corpus, `Type` discriminator
 * vocabulary shared between unions, and recursive structures matching themselves
 * at two nesting depths. It also misses benches outright: the declarations split
 * across four union branches (9 + 4 + 1 + 1 of 15 ids), so no single site holds
 * the domain, and even their union reaches only 0.714 coverage because vanilla
 * ships 78 requirements naming ids that do not exist. Useful for FINDING links to
 * declare here; wrong as the thing that decides them.
 */

/** One end of a link: a schema-resolved field, or every branch of a union. */
export type Site =
  | { readonly scope: string; readonly pointer: string }
  | {
      /** Union field whose branches each declare `pointer`; branches from the schema. */
      readonly unionAt: { readonly scope: string; readonly pointer: string };
      readonly pointer: string;
    };

export interface ValueLink {
  readonly name: string;
  /** Where the value is named. */
  readonly declaredAt: readonly Site[];
  /** Where the value is used. */
  readonly referencedAt: readonly Site[];
  /** What an unresolved reference means, for validate_pack and the CLI. */
  readonly unresolvedMeans: string;
}

export const VALUE_LINKS: readonly ValueLink[] = [
  {
    // Verified irreducible: common:BenchRequirement./Id declares reference_target,
    // enum_values and description all null, and the values are not asset ids --
    // the id is 'Builders' where the asset is 'Bench_Builders'.
    name: "bench",
    declaredAt: [{ unionAt: { scope: "BlockType", pointer: "/Bench" }, pointer: "/Id" }],
    referencedAt: [{ scope: "common:BenchRequirement", pointer: "/Id" }],
    unresolvedMeans: "recipe requires a bench nothing declares",
  },
  {
    // 19 subcategories declared across 2 ItemCategory assets, used by 775 items.
    // Before this link the field was served only by name-collision guesses: 2 042
    // edges for 775 candidates, every one of them low confidence.
    name: "item-subcategory",
    declaredAt: [{ scope: "common:SubCategoryDefinition", pointer: "/Id" }],
    referencedAt: [{ scope: "Item", pointer: "/SubCategory" }],
    unresolvedMeans: "item filed under a subcategory nothing declares",
  },
  {
    // Directional, not a foreign key: a tool spec PROVIDES a gather type, a block
    // REQUIRES one. Tools provide 14 distinct values, blocks require 16, so the
    // unresolved side is the interesting half -- blocks no tool can gather.
    name: "gather-type",
    declaredAt: [{ scope: "ItemToolSpec", pointer: "/GatherType" }],
    referencedAt: [{ scope: "common:BlockBreakingDropType", pointer: "/GatherType" }],
    unresolvedMeans: "block requires a gather type no tool provides",
  },
];

export interface LinkResult {
  readonly name: string;
  readonly declared: number;
  readonly distinctValues: number;
  readonly references: number;
  readonly resolved: number;
  readonly unresolvedValues: readonly string[];
}

interface Row {
  asset_id: number;
  json_pointer: string;
  raw_value: string;
}

/**
 * Expands a site into concrete (scope, pointer) pairs.
 *
 * A union site resolves through the schema's own `ref_scope`, so a renamed or
 * added branch is picked up without editing the link.
 */
function resolveSite(db: Database, site: Site): { scope: string; pointer: string }[] {
  if (!("unionAt" in site)) return [{ scope: site.scope, pointer: site.pointer }];
  const row = db
    .prepare("SELECT ref_scope FROM schema_fields WHERE asset_type = ? AND json_pointer = ?")
    .get(site.unionAt.scope, site.unionAt.pointer) as Record<string, unknown> | undefined;
  return scopes((row?.["ref_scope"] as string | null) ?? null).map((scope) => ({
    scope,
    pointer: site.pointer,
  }));
}

function rowsAt(db: Database, scope: string, pointer: string): Row[] {
  return db
    .prepare(
      `SELECT asset_id, json_pointer, raw_value FROM candidates
        WHERE schema_scope = ? AND schema_pointer = ?`,
    )
    .all(scope, pointer) as unknown as Row[];
}

export function indexValueLinks(db: Database): LinkResult[] {
  const insert = db.prepare(
    `INSERT INTO value_links (link, value, asset_id, json_pointer, role, resolved)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (link, asset_id, json_pointer, role) DO NOTHING`,
  );

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM value_links");
    const results: LinkResult[] = [];

    for (const link of VALUE_LINKS) {
      const declared = new Set<string>();
      let declarations = 0;

      for (const site of link.declaredAt.flatMap((s) => resolveSite(db, s))) {
        for (const row of rowsAt(db, site.scope, site.pointer)) {
          insert.run(link.name, row.raw_value, row.asset_id, row.json_pointer, "declares", 1);
          declared.add(row.raw_value);
          declarations++;
        }
      }

      let references = 0;
      let resolved = 0;
      const unresolved = new Set<string>();

      for (const site of link.referencedAt.flatMap((s) => resolveSite(db, s))) {
        for (const row of rowsAt(db, site.scope, site.pointer)) {
          const known = declared.has(row.raw_value);
          insert.run(
            link.name,
            row.raw_value,
            row.asset_id,
            row.json_pointer,
            "references",
            known ? 1 : 0,
          );
          references++;
          if (known) resolved++;
          else unresolved.add(row.raw_value);
        }
      }

      results.push({
        name: link.name,
        declared: declarations,
        distinctValues: declared.size,
        references,
        resolved,
        unresolvedValues: [...unresolved].sort(),
      });
    }

    db.exec("COMMIT");
    return results;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface LinkedAsset {
  readonly logicalId: string;
  readonly pointer: string;
}

/** Assets declaring a value, and assets referencing it. */
export function whoUses(
  db: Database,
  link: string,
  value: string,
  role: "declares" | "references",
  limit = 100,
): LinkedAsset[] {
  return db
    .prepare(
      `SELECT a.logical_id AS logicalId, v.json_pointer AS pointer
         FROM value_links v JOIN assets a ON a.id = v.asset_id
        WHERE v.link = ? AND v.value = ? AND v.role = ?
        ORDER BY a.logical_id LIMIT ?`,
    )
    .all(link, value, role, limit) as unknown as LinkedAsset[];
}
