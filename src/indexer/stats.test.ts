import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase } from "../db/open.ts";
import { computeFieldStats } from "./stats.ts";

/**
 * Fixtures mirror the shape measured on `ItemDropList`: `/Container` is a
 * polymorphic union whose branch is chosen by a sibling `Type` in the data, and
 * the generator names the branches `<discriminator><family>`
 * (`SingleItemDropContainer`, `MultipleItemDropContainer`).
 *
 * Getting this wrong is silent rather than loud, which is why it is tested:
 * following the first branch blindly attributed 2 732 real observations to a
 * field the chosen definition does not have, and `describe_schema` presented
 * them as fact.
 */
function db() {
  const database = openDatabase(":memory:");
  database
    .prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')")
    .run();
  for (const t of ["ItemDropList", "common:SingleItemDropContainer", "common:MultipleItemDropContainer"]) {
    database.prepare("INSERT INTO asset_types (id, source) VALUES (?, 'codec')").run(t);
  }

  const field = database.prepare(
    "INSERT INTO schema_fields (asset_type, json_pointer, declared_type, ref_scope) VALUES (?,?,?,?)",
  );
  field.run(
    "ItemDropList",
    "/Container",
    "anyOf",
    "common:SingleItemDropContainer common:MultipleItemDropContainer",
  );
  field.run("common:SingleItemDropContainer", "/Type", "string", null);
  field.run("common:SingleItemDropContainer", "/Item", "object", null);
  field.run("common:SingleItemDropContainer", "/Item/ItemId", "string", null);
  field.run("common:MultipleItemDropContainer", "/Type", "string", null);
  field.run("common:MultipleItemDropContainer", "/Rolls", "integer", null);
  return database;
}

function asset(database: ReturnType<typeof db>, id: number, logical: string) {
  database
    .prepare(
      "INSERT INTO assets (id, pack_id, logical_id, path, type) VALUES (?,1,?,?,'ItemDropList')",
    )
    .run(id, logical, `Server/ItemDropList/${logical}.json`);
}

function candidate(database: ReturnType<typeof db>, assetId: number, pointer: string, value: string) {
  database
    .prepare(
      "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value) VALUES (?,?,?,?)",
    )
    .run(assetId, pointer, pointer.replace(/\/\d+/g, "/*"), value);
}

test("a union branch is chosen by the sibling Type from the data", () => {
  const database = db();
  asset(database, 1, "Drops_Apple");
  candidate(database, 1, "/Container/Type", "Single");
  candidate(database, 1, "/Container/Item/ItemId", "Plant_Fruit_Apple");

  // Two, not one: the counters count pointer crossings, and both the
  // discriminator itself and the field beside it cross `/Container`.
  const r = computeFieldStats(database);
  assert.equal(r.resolvedUnions, 2);
  assert.equal(r.unresolvedUnions, 0);

  const row = database
    .prepare("SELECT schema_scope, schema_pointer FROM candidates WHERE json_pointer LIKE '%ItemId'")
    .get() as Record<string, unknown>;
  assert.equal(row["schema_scope"], "common:SingleItemDropContainer");
  assert.equal(row["schema_pointer"], "/Item/ItemId");
  database.close();
});

test("two instances of the same pointer take different branches", () => {
  const database = db();
  asset(database, 1, "Drops_Single");
  candidate(database, 1, "/Container/Type", "Single");
  candidate(database, 1, "/Container/Item/ItemId", "Plant_Fruit_Apple");
  asset(database, 2, "Drops_Multiple");
  candidate(database, 2, "/Container/Type", "Multiple");
  candidate(database, 2, "/Container/Rolls", "3");

  computeFieldStats(database);
  const scopes = database
    .prepare(
      `SELECT a.logical_id, c.schema_scope FROM candidates c JOIN assets a ON a.id = c.asset_id
        WHERE c.json_pointer NOT LIKE '%/Type' ORDER BY a.logical_id`,
    )
    .all() as Record<string, unknown>[];
  assert.deepEqual(
    scopes.map((s) => [s["logical_id"], s["schema_scope"]]),
    [
      ["Drops_Multiple", "common:MultipleItemDropContainer"],
      ["Drops_Single", "common:SingleItemDropContainer"],
    ],
  );
  database.close();
});

test("an absent discriminator leaves the pointer in the parent namespace", () => {
  const database = db();
  asset(database, 1, "Drops_Untyped");
  // No /Container/Type at all: guessing a branch here is how observations get
  // attributed to fields the chosen definition does not declare.
  candidate(database, 1, "/Container/Item/ItemId", "Plant_Fruit_Apple");

  const r = computeFieldStats(database);
  assert.equal(r.resolvedUnions, 0);
  assert.equal(r.unresolvedUnions, 1);

  const row = database
    .prepare("SELECT schema_scope, schema_pointer FROM candidates")
    .get() as Record<string, unknown>;
  assert.equal(row["schema_scope"], "ItemDropList");
  assert.equal(row["schema_pointer"], "/Container/Item/ItemId");
  database.close();
});

/**
 * `target_types` is the observed counterpart of `reference_target`, and it was
 * filled by joining the SOURCE asset's type against `field_stats.asset_type` --
 * which holds the scope this pass has just rebased the pointer into. The two
 * agree only for a field declared at the top level of its own type, so 159 of
 * the 224 fields declaring a reference_target came out empty, the most used ones
 * among them.
 */
test("target_types is keyed on the rebased scope, not the source asset's type", () => {
  const database = db();
  database.prepare("INSERT INTO asset_types (id, source) VALUES ('Item','codec')").run();
  database
    .prepare(
      "INSERT INTO schema_fields (asset_type, json_pointer, declared_type, reference_target) VALUES (?,?,?,?)",
    )
    .run("common:SingleItemDropContainer", "/Item/ItemId2", "string", "Item");

  asset(database, 1, "Drops_Apple");
  database
    .prepare(
      "INSERT INTO assets (id, pack_id, logical_id, path, type) VALUES (2,1,'Plant_Fruit_Apple','Server/Item/Items/Plant_Fruit_Apple.json','Item')",
    )
    .run();
  candidate(database, 1, "/Container/Type", "Single");
  candidate(database, 1, "/Container/Item/ItemId2", "Plant_Fruit_Apple");
  database
    .prepare(
      "INSERT INTO edges (src, dst, dst_kind, kind, json_pointer, confidence) VALUES (1,2,'asset','REFERENCES','/Container/Item/ItemId2','high')",
    )
    .run();

  computeFieldStats(database);

  // The candidate is rebased into common:SingleItemDropContainer, so that is
  // where the observed row -- and its target types -- must land.
  const row = database
    .prepare(
      "SELECT target_types FROM field_stats WHERE asset_type = ? AND json_pointer = ?",
    )
    .get("common:SingleItemDropContainer", "/Item/ItemId2") as Record<string, unknown>;
  assert.equal(row["target_types"], "Item");
  database.close();
});

/**
 * `value_types` was inserted as NULL and never written, which left the observed
 * layer unable to say even whether a field holds a number or a string -- the one
 * thing it can answer for the 418 fields the schema does not describe.
 */
test("value_types records the JSON types actually seen", () => {
  const database = db();
  asset(database, 1, "Drops_Apple");
  candidate(database, 1, "/Container/Type", "Single");
  candidate(database, 1, "/Container/Item/ItemId", "Plant_Fruit_Apple");
  database
    .prepare(
      "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind) VALUES (1,'/Rolls','/Rolls','3','number')",
    )
    .run();

  computeFieldStats(database);
  const row = database
    .prepare("SELECT value_types FROM field_stats WHERE asset_type='ItemDropList' AND json_pointer='/Rolls'")
    .get() as Record<string, unknown>;
  assert.equal(row["value_types"], "number");
  const str = database
    .prepare(
      "SELECT value_types FROM field_stats WHERE asset_type='common:SingleItemDropContainer' AND json_pointer='/Item/ItemId'",
    )
    .get() as Record<string, unknown>;
  assert.equal(str["value_types"], "string");
  database.close();
});

test("a discriminator naming no branch is left alone rather than guessed", () => {
  const database = db();
  asset(database, 1, "Drops_Future");
  candidate(database, 1, "/Container/Type", "Weighted");
  candidate(database, 1, "/Container/Item/ItemId", "Plant_Fruit_Apple");

  const r = computeFieldStats(database);
  assert.equal(r.resolvedUnions, 0);
  assert.equal(r.unresolvedUnions, 2);

  // `Weighted` is not a typo but a plausible future branch. Leaving the pointer
  // in the parent namespace keeps it countable instead of silently filed under
  // whichever branch happened to sort first.
  const row = database
    .prepare("SELECT schema_scope FROM candidates WHERE json_pointer LIKE '%ItemId'")
    .get() as Record<string, unknown>;
  assert.equal(row["schema_scope"], "ItemDropList");
  database.close();
});
