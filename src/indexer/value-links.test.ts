import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase } from "../db/open.ts";
import { VALUE_LINKS, indexValueLinks, whoUses } from "./value-links.ts";

/**
 * These fixtures exercise the mechanism, not the specific links: a union-sited
 * declaration (the bench shape), a plain one (subcategory), and an unresolved
 * reference, which is the case that must survive rather than be dropped.
 */
function db() {
  const database = openDatabase(":memory:");
  database
    .prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')")
    .run();
  for (const t of ["Item", "BlockType", "ItemCategory", "ItemToolSpec"]) {
    database.prepare("INSERT INTO asset_types (id, source) VALUES (?, 'codec')").run(t);
  }
  database
    .prepare(
      "INSERT INTO schema_fields (asset_type, json_pointer, declared_type, ref_scope) VALUES (?,?,?,?)",
    )
    .run("BlockType", "/Bench", "anyOf", "common:CraftingBench common:ProcessingBench");
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

function fixture() {
  const database = db();
  asset(database, 1, "Bench_Alchemy", "Item");
  asset(database, 2, "Bench_Furnace", "Item");
  asset(database, 3, "Potion_Health", "Item");
  asset(database, 4, "Broken_Recipe", "Item");
  asset(database, 5, "Categories_Tool", "ItemCategory");
  asset(database, 6, "Pickaxe_Iron", "Item");

  // Declarations arriving through two different union branches.
  candidate(database, 1, "/BlockType/Bench/Id", "common:CraftingBench", "/Id", "Alchemybench");
  candidate(database, 2, "/BlockType/Bench/Id", "common:ProcessingBench", "/Id", "Furnace");

  candidate(database, 3, "/Recipe/BenchRequirement/0/Id", "common:BenchRequirement", "/Id", "Alchemybench");
  candidate(database, 4, "/BenchRequirement/0/Id", "common:BenchRequirement", "/Id", "Nonexistent");

  candidate(database, 5, "/SubCategories/0/Id", "common:SubCategoryDefinition", "/Id", "BasicTools");
  candidate(database, 6, "/SubCategory", "Item", "/SubCategory", "BasicTools");
  return database;
}

test("a union-sited declaration collects every branch", () => {
  const database = fixture();
  const bench = indexValueLinks(database).find((r) => r.name === "bench")!;
  // One from CraftingBench, one from ProcessingBench.
  assert.equal(bench.declared, 2);
  assert.equal(bench.distinctValues, 2);
  database.close();
});

test("references resolve against declarations from any branch", () => {
  const database = fixture();
  const bench = indexValueLinks(database).find((r) => r.name === "bench")!;
  assert.equal(bench.references, 2);
  assert.equal(bench.resolved, 1);
  assert.deepEqual(bench.unresolvedValues, ["Nonexistent"]);
  database.close();
});

test("an unresolved reference is kept, not dropped", () => {
  const database = fixture();
  indexValueLinks(database);
  const row = database
    .prepare(
      `SELECT a.logical_id, v.value FROM value_links v JOIN assets a ON a.id = v.asset_id
        WHERE v.link = 'bench' AND v.role = 'references' AND v.resolved = 0`,
    )
    .get() as Record<string, unknown>;
  assert.equal(row["logical_id"], "Broken_Recipe");
  assert.equal(row["value"], "Nonexistent");
  database.close();
});

test("a plain declaration site needs no union", () => {
  const database = fixture();
  const sub = indexValueLinks(database).find((r) => r.name === "item-subcategory")!;
  assert.equal(sub.distinctValues, 1);
  assert.equal(sub.references, 1);
  assert.equal(sub.resolved, 1);
  database.close();
});

test("a link with no data present yields zeroes rather than throwing", () => {
  const database = fixture();
  const gather = indexValueLinks(database).find((r) => r.name === "gather-type")!;
  assert.equal(gather.declared, 0);
  assert.equal(gather.references, 0);
  database.close();
});

test("whoUses answers both directions of a link", () => {
  const database = fixture();
  indexValueLinks(database);
  assert.deepEqual(
    whoUses(database, "bench", "Alchemybench", "declares").map((r) => r.logicalId),
    ["Bench_Alchemy"],
  );
  assert.deepEqual(
    whoUses(database, "bench", "Alchemybench", "references").map((r) => r.logicalId),
    ["Potion_Health"],
  );
  database.close();
});

test("reindexing is idempotent", () => {
  const database = fixture();
  const first = indexValueLinks(database);
  const second = indexValueLinks(database);
  assert.deepEqual(second, first);
  database.close();
});

test("every declared link states what an unresolved reference means", () => {
  // The CLI prints this verbatim, so an empty one would produce a bare list of
  // values with no indication of what is wrong with them.
  for (const link of VALUE_LINKS) {
    assert.ok(link.unresolvedMeans.length > 0, `${link.name} has no unresolvedMeans`);
    assert.ok(link.declaredAt.length > 0 && link.referencedAt.length > 0, link.name);
  }
});
