import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase } from "../db/open.ts";
import { craftableAt, indexBenches } from "./benches.ts";

/**
 * Fixtures are declared the way the SCHEMA declares them, not the way the corpus
 * happens to nest them: the bench union's branches, `BenchCategory` with its
 * `ItemCategories` children, and requirements arriving from two different hosts.
 *
 * The host paths deliberately differ from each other (`/BlockType/Bench/...` and
 * a bare `/Bench/...`, `/Recipe/BenchRequirement/...` and `/BenchRequirement/...`)
 * because an earlier version keyed off those paths and silently found nothing
 * when they varied.
 */
function db() {
  const database = openDatabase(":memory:");
  database
    .prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')")
    .run();
  for (const t of ["Item", "CraftingRecipe", "BlockType"]) {
    database.prepare("INSERT INTO asset_types (id, source) VALUES (?, 'codec')").run(t);
  }

  // The union declaration is what supplies the branch namespaces.
  database
    .prepare(
      "INSERT INTO schema_fields (asset_type, json_pointer, declared_type, ref_scope) VALUES (?,?,?,?)",
    )
    .run(
      "BlockType",
      "/Bench",
      "anyOf",
      "common:CraftingBench common:StructuralCraftingBench",
    );
  return database;
}

function asset(database: ReturnType<typeof db>, id: number, logical: string, type: string) {
  database
    .prepare("INSERT INTO assets (id, pack_id, logical_id, path, type) VALUES (?,1,?,?,?)")
    .run(id, logical, `Server/${type}/${logical}.json`, type);
}

function candidate(
  database: ReturnType<typeof db>,
  assetId: number,
  pointer: string,
  scope: string,
  schemaPointer: string,
  value: string,
) {
  database
    .prepare(
      "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, schema_scope, raw_value) VALUES (?,?,?,?,?)",
    )
    .run(assetId, pointer, schemaPointer, scope, value);
}

/** A bench declared inside an Item, the way vanilla does it. */
function declareBench(
  database: ReturnType<typeof db>,
  assetId: number,
  host: string,
  branch: string,
  id: string,
  type: string,
) {
  candidate(database, assetId, `${host}/Id`, branch, "/Id", id);
  candidate(database, assetId, `${host}/Type`, branch, "/Type", type);
}

function fixture() {
  const database = db();
  asset(database, 1, "Bench_Alchemy", "Item");
  asset(database, 2, "Potion_Health", "Item");
  asset(database, 3, "Weapon_Bomb", "CraftingRecipe");
  asset(database, 4, "Orphan", "Item");
  asset(database, 5, "Bench_Trough", "Item");

  declareBench(database, 1, "/BlockType/Bench", "common:CraftingBench", "Alchemybench", "Crafting");
  // Same id declared by a second asset -- vanilla does this with Farmingbench.
  declareBench(database, 5, "/Bench", "common:CraftingBench", "Alchemybench", "Crafting");

  // Object category with a nested ItemCategory.
  candidate(database, 1, "/BlockType/Bench/Categories/0/Id", "common:BenchCategory", "/Id", "Alchemy_Potions");
  candidate(database, 1, "/BlockType/Bench/Categories/0/Name", "common:BenchCategory", "/Name", "server.bench.alchemy.potions");
  candidate(database, 1, "/BlockType/Bench/Categories/0/Icon", "common:BenchCategory", "/Icon", "Icons/Potions.png");
  candidate(database, 1, "/BlockType/Bench/Categories/0/ItemCategories/0/Id", "common:BenchItemCategory", "/Id", "Alchemy_Potions_Healing");

  // Bare-string category, the StructuralCraftingBench shape.
  candidate(database, 1, "/BlockType/Bench/Categories/1", "common:StructuralCraftingBench", "/Categories/*", "Alchemy_Bombs");

  // Requirements from two different hosts.
  candidate(database, 2, "/Recipe/BenchRequirement/0/Id", "common:BenchRequirement", "/Id", "Alchemybench");
  candidate(database, 2, "/Recipe/BenchRequirement/0/Categories/0", "common:BenchRequirement", "/Categories/*", "Alchemy_Potions");
  candidate(database, 3, "/BenchRequirement/0/Id", "common:BenchRequirement", "/Id", "Alchemybench");
  candidate(database, 3, "/BenchRequirement/0/Categories/0", "common:BenchRequirement", "/Categories/*", "Alchemy_Bombs");
  candidate(database, 4, "/Recipe/BenchRequirement/0/Id", "common:BenchRequirement", "/Id", "TODO");

  database
    .prepare("INSERT INTO lang_keys (pack_id, locale, key, value) VALUES (1,?,?,?)")
    .run("en-US", "bench.alchemy.potions", "Combat Potions");
  return database;
}

test("branch namespaces come from the schema union, not from a hardcoded list", () => {
  const database = fixture();
  const r = indexBenches(database);
  assert.equal(r.benches, 1);
  const row = database.prepare("SELECT id, bench_type FROM benches").get() as Record<string, unknown>;
  assert.equal(row["id"], "Alchemybench");
  // Read from the data's discriminator rather than left null.
  assert.equal(row["bench_type"], "Crafting");
  database.close();
});

test("a bench declared twice keeps BOTH assets instead of dropping one", () => {
  const database = fixture();
  const r = indexBenches(database);
  assert.equal(r.declarations, 2);
  assert.deepEqual(r.duplicateIds, ["Alchemybench"]);
  const who = database
    .prepare(
      `SELECT a.logical_id FROM bench_declarations d JOIN assets a ON a.id = d.asset_id
        ORDER BY a.logical_id`,
    )
    .all() as Record<string, unknown>[];
  assert.deepEqual(who.map((x) => x["logical_id"]), ["Bench_Alchemy", "Bench_Trough"]);
  database.close();
});

test("requirements resolve regardless of which host embedded them", () => {
  const database = fixture();
  const r = indexBenches(database);
  assert.equal(r.requirements, 3);
  assert.equal(r.resolved, 2);
  assert.deepEqual(r.unresolvedIds, ["TODO"]);
  database.close();
});

test("an undeclared bench id is kept so validate_pack can report it", () => {
  const database = fixture();
  indexBenches(database);
  const kept = database
    .prepare("SELECT count(*) AS n FROM bench_requirements WHERE resolved = 0")
    .get() as Record<string, unknown>;
  assert.equal(kept["n"], 1);
  database.close();
});

test("both declared category shapes are read: object and bare string", () => {
  const database = fixture();
  const r = indexBenches(database);
  assert.equal(r.categories, 2);
  const ids = database
    .prepare("SELECT category_id FROM bench_categories WHERE parent_id IS NULL ORDER BY category_id")
    .all() as Record<string, unknown>[];
  assert.deepEqual(ids.map((x) => x["category_id"]), ["Alchemy_Bombs", "Alchemy_Potions"]);
  database.close();
});

test("nesting comes from ItemCategories and populates parent_id", () => {
  const database = fixture();
  const r = indexBenches(database);
  assert.equal(r.nestedCategories, 1);
  const row = database
    .prepare("SELECT category_id, parent_id FROM bench_categories WHERE parent_id IS NOT NULL")
    .get() as Record<string, unknown>;
  assert.equal(row["category_id"], "Alchemy_Potions_Healing");
  assert.equal(row["parent_id"], "Alchemy_Potions");
  database.close();
});

test("category name and icon are both captured, with the lang root stripped", () => {
  const database = fixture();
  indexBenches(database);
  const row = database
    .prepare(
      `SELECT c.name_key, c.icon, l.value FROM bench_categories c
         LEFT JOIN lang_keys l ON l.key = c.name_key
        WHERE c.category_id = 'Alchemy_Potions'`,
    )
    .get() as Record<string, unknown>;
  assert.equal(row["name_key"], "bench.alchemy.potions");
  assert.equal(row["icon"], "Icons/Potions.png");
  assert.equal(row["value"], "Combat Potions");
  database.close();
});

test("craftableAt groups items by the category they were filed under", () => {
  const database = fixture();
  indexBenches(database);
  const rows = craftableAt(database, "Alchemybench").map((r) => [r.logicalId, r.category]);
  assert.deepEqual(rows, [
    ["Weapon_Bomb", "Alchemy_Bombs"],
    ["Potion_Health", "Alchemy_Potions"],
  ]);
  database.close();
});

test("reindexing is idempotent rather than accumulating duplicates", () => {
  const database = fixture();
  const first = indexBenches(database);
  const second = indexBenches(database);
  assert.deepEqual(second, first);
  database.close();
});
