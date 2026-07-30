import type { Database } from "../db/open.ts";
import { referenceToKey } from "../sources/lang.ts";
import { scopes } from "../sources/schema-doc.ts";
import { candidateRows } from "./references.ts";
import { VALUE_LINKS } from "./value-links.ts";

/**
 * Crafting benches: the structure around the `bench` value link.
 *
 * The link itself -- the one fact the schema cannot express -- is declared in
 * `value-links.ts` alongside the other two. What lives here is the part with no
 * generic counterpart: categories, their nesting, and the reverse lookup.
 * Everything about their shape is READ FROM THE SCHEMA at index time rather than
 * written down.
 *
 * That split was not the original design and the difference is measurable. The
 * first version hardcoded JSON pointers and regexes lifted from the corpus, and
 * every one of its defects came from guessing a shape instead of reading the
 * declared one:
 *
 * - `/BlockType/Bench/...` and `/Recipe/BenchRequirement/...` are HOST paths, not
 *   field identities. The schema declares `BlockType./Bench` and
 *   `CraftingRecipe./BenchRequirement`; the prefixes exist only because `Item`
 *   embeds both. Any other host, or a renamed embed key, matched nothing silently.
 * - A nested `Categories` under a category was invented. `BenchCategory` declares
 *   `ItemCategories`. The guessed shape matched nothing (parent_id null for all 67
 *   rows) while the 12 real nested categories were dropped.
 * - `bench_type` was written as NULL for all 15 benches although the schema
 *   declares `/Type` as an enum and all 16 declarations carry a value.
 * - `/Icon` had no handler, dropping 41 more values.
 *
 * Querying `schema_scope`/`schema_pointer` -- the namespace-resolved form pass 3
 * produces, with polymorphic unions already routed by their discriminator --
 * removes all four classes at once. All 1 957 requirements arrive under one key,
 * `common:BenchRequirement :: /Id`, regardless of which host embedded them.
 */

/**
 * The bench link itself lives in `value-links.ts` with the other two, so there is
 * a single place a reader can see every domain statement the index makes. This
 * module adds only what is bench-shaped and has no generic counterpart:
 * categories, their nesting, and the reverse "what can I craft here" lookup.
 */
const BENCH_LINK = VALUE_LINKS.find((l) => l.name === "bench")!;
const BENCH_DECLARED = BENCH_LINK.declaredAt[0] as {
  unionAt: { scope: string; pointer: string };
  pointer: string;
};
const BENCH_REFERENCED = BENCH_LINK.referencedAt[0] as { scope: string; pointer: string };

export interface BenchResult {
  readonly benches: number;
  readonly declarations: number;
  readonly categories: number;
  readonly nestedCategories: number;
  readonly requirements: number;
  readonly resolved: number;
  readonly unresolvedIds: readonly string[];
  readonly duplicateIds: readonly string[];
}

/** Candidates of one resolved schema field, with their raw document position. */
/** Drops the last `/Key` from a pointer, giving the object that holds it. */
function parentOf(pointer: string): string {
  const cut = pointer.lastIndexOf("/");
  return cut <= 0 ? "" : pointer.slice(0, cut);
}

export function indexBenches(db: Database): BenchResult {
  // Branch namespaces come from the schema's own union declaration, so a renamed
  // or added bench kind is picked up without touching this file.
  const unionRow = db
    .prepare("SELECT ref_scope FROM schema_fields WHERE asset_type = ? AND json_pointer = ?")
    .get(BENCH_DECLARED.unionAt.scope, BENCH_DECLARED.unionAt.pointer) as
    | Record<string, unknown>
    | undefined;
  const branches = scopes((unionRow?.["ref_scope"] as string | null) ?? null);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM bench_requirement_categories");
    db.exec("DELETE FROM bench_requirements");
    db.exec("DELETE FROM bench_categories");
    db.exec("DELETE FROM bench_declarations");
    db.exec("DELETE FROM benches");

    // --- declarations -------------------------------------------------------
    const insBench = db.prepare(
      "INSERT INTO benches (id, bench_type) VALUES (?,?) ON CONFLICT (id) DO NOTHING",
    );
    const insDecl = db.prepare(
      "INSERT INTO bench_declarations (bench_id, asset_id) VALUES (?,?)" +
        " ON CONFLICT (bench_id, asset_id) DO NOTHING",
    );

    /** '<asset>|<pointer of the bench object>' -> bench id. */
    const benchAt = new Map<string, string>();
    const benchIds = new Set<string>();
    const seenDeclaration = new Map<string, number>();
    let declarations = 0;

    for (const branch of branches) {
      // The branch's own name is the discriminator value plus the family suffix;
      // read the value from the data instead of deriving it, since the data is
      // what the game actually loaded.
      const typeByPointer = new Map<string, string>();
      for (const row of candidateRows(db, branch, "/Type")) {
        typeByPointer.set(`${row.asset_id}|${parentOf(row.json_pointer)}`, row.raw_value);
      }

      for (const row of candidateRows(db, branch, BENCH_DECLARED.pointer)) {
        const at = parentOf(row.json_pointer);
        insBench.run(row.raw_value, typeByPointer.get(`${row.asset_id}|${at}`) ?? null);
        insDecl.run(row.raw_value, row.asset_id);
        benchAt.set(`${row.asset_id}|${at}`, row.raw_value);
        benchIds.add(row.raw_value);
        declarations++;
        seenDeclaration.set(row.raw_value, (seenDeclaration.get(row.raw_value) ?? 0) + 1);
      }
    }

    // --- categories ---------------------------------------------------------
    //
    // Two declared shapes, both handled: object categories ($ref BenchCategory,
    // carrying Id/Name/Icon/ItemCategories) and bare strings, which
    // StructuralCraftingBench uses and where the value IS the id.
    const insCategory = db.prepare(
      `INSERT INTO bench_categories (bench_id, category_id, parent_id, name_key, icon)
       VALUES (?,?,?,?,?) ON CONFLICT (bench_id, category_id) DO UPDATE SET
         parent_id = coalesce(excluded.parent_id, parent_id),
         name_key  = coalesce(excluded.name_key,  name_key),
         icon      = coalesce(excluded.icon,      icon)`,
    );

    /** Resolves which bench a category sits inside, by walking up its pointer. */
    const benchFor = (assetId: number, pointer: string): string | undefined => {
      let at = pointer;
      while (at.length > 0) {
        const found = benchAt.get(`${assetId}|${at}`);
        if (found !== undefined) return found;
        at = parentOf(at);
      }
      return undefined;
    };

    let categories = 0;
    let nested = 0;

    // Bare-string categories: the branch declares /Categories/* as a string.
    for (const branch of branches) {
      for (const row of candidateRows(db, branch, "/Categories/*")) {
        const bench = benchFor(row.asset_id, row.json_pointer);
        if (bench === undefined) continue;
        insCategory.run(bench, row.raw_value, null, null, null);
        categories++;
      }
    }

    // Object categories and their nested ItemCategories. The scope names the
    // shape, so both levels are found without knowing the pointer they sit at.
    for (const [scope, isNested] of [
      ["common:BenchCategory", false],
      ["common:BenchItemCategory", true],
    ] as const) {
      const names = new Map<string, string>();
      const icons = new Map<string, string>();
      for (const row of candidateRows(db, scope, "/Name")) {
        names.set(`${row.asset_id}|${parentOf(row.json_pointer)}`, row.raw_value);
      }
      for (const row of candidateRows(db, scope, "/Icon")) {
        icons.set(`${row.asset_id}|${parentOf(row.json_pointer)}`, row.raw_value);
      }

      for (const row of candidateRows(db, scope, "/Id")) {
        const at = parentOf(row.json_pointer);
        const bench = benchFor(row.asset_id, at);
        if (bench === undefined) continue;
        const key = `${row.asset_id}|${at}`;
        // A nested category's parent is the category object holding its
        // ItemCategories array, two levels up: /Categories/N/ItemCategories/M.
        const parent = isNested
          ? (db
              .prepare(
                `SELECT raw_value FROM candidates
                  WHERE asset_id = ? AND schema_scope = 'common:BenchCategory'
                    AND schema_pointer = '/Id' AND json_pointer = ?`,
              )
              .get(row.asset_id, `${parentOf(parentOf(at))}/Id`) as
              | Record<string, unknown>
              | undefined)
          : undefined;

        insCategory.run(
          bench,
          row.raw_value,
          (parent?.["raw_value"] as string | undefined) ?? null,
          // Stored stripped of its `server.` root so it joins lang_keys directly:
          // 38 of 53 names carry that prefix and none resolve without removing it.
          names.has(key) ? referenceToKey(names.get(key)!) : null,
          icons.get(key) ?? null,
        );
        if (isNested) nested++;
        else categories++;
      }
    }

    // --- requirements -------------------------------------------------------
    //
    // One key covers every host shape: 1 554 arrive from Item via /Recipe and 403
    // from CraftingRecipe directly, and both resolve to this same field.
    const insReq = db.prepare(
      `INSERT INTO bench_requirements (asset_id, json_pointer, bench_id, resolved)
       VALUES (?,?,?,?) ON CONFLICT (asset_id, json_pointer) DO NOTHING`,
    );
    const insReqCat = db.prepare(
      `INSERT INTO bench_requirement_categories (asset_id, json_pointer, category_id)
       VALUES (?,?,?) ON CONFLICT (asset_id, json_pointer, category_id) DO NOTHING`,
    );

    let requirements = 0;
    let resolved = 0;
    const unresolved = new Set<string>();

    const link = BENCH_REFERENCED;
    for (const row of candidateRows(db, link.scope, link.pointer)) {
      const at = parentOf(row.json_pointer);
      const known = benchIds.has(row.raw_value);
      insReq.run(row.asset_id, at, row.raw_value, known ? 1 : 0);
      requirements++;
      if (known) resolved++;
      // Kept rather than dropped: vanilla ships 58 requirements naming the literal
      // id 'TODO', so an unresolved id is a validate_pack finding, not a failure.
      else unresolved.add(row.raw_value);
    }

    for (const row of candidateRows(db, link.scope, "/Categories/*")) {
      insReqCat.run(row.asset_id, parentOf(parentOf(row.json_pointer)), row.raw_value);
    }

    const result: BenchResult = {
      benches: benchIds.size,
      declarations,
      categories,
      nestedCategories: nested,
      requirements,
      resolved,
      unresolvedIds: [...unresolved].sort(),
      duplicateIds: [...seenDeclaration].filter(([, k]) => k > 1).map(([id]) => id).sort(),
    };
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface CraftableAtBench {
  readonly logicalId: string;
  readonly category: string | null;
}

/**
 * What can be crafted at a bench.
 *
 * The reverse lookup the whole model exists for. Categories join on
 * `(bench_id, category_id)` rather than on the category alone: `Decorative` is
 * declared by both `Builders` and `Farmingbench`, `All` by both `Farmingbench` and
 * `Loombench`, and those collisions cover 100 of the 1 364 category matches -- a
 * global lookup would be ambiguous exactly where it is used most.
 */
export function craftableAt(db: Database, benchId: string, limit = 100): CraftableAtBench[] {
  return db
    .prepare(
      `SELECT a.logical_id AS logicalId, rc.category_id AS category
         FROM bench_requirements r
         JOIN assets a ON a.id = r.asset_id
         LEFT JOIN bench_requirement_categories rc
                ON rc.asset_id = r.asset_id AND rc.json_pointer = r.json_pointer
        WHERE r.bench_id = ?
        ORDER BY rc.category_id, a.logical_id
        LIMIT ?`,
    )
    .all(benchId, limit) as unknown as CraftableAtBench[];
}
