import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase } from "../db/open.ts";
import { type AssetLoader, resolveAsset } from "./asset.ts";

/**
 * Fixtures mirror the two markers as they actually appear in the generated
 * schema, which an earlier revision of the resolver read in the wrong places:
 *
 * - `inheritsProperty` is per PROPERTY. It is recorded but NOT used as a gate:
 *   see the unmarked-field test for why the corpus refutes that reading.
 * - `mergesProperties` is per TYPE, written on the schema's root row, and decides
 *   whether values of that type combine field by field or replace wholesale.
 *
 * `/Interactions` is an inherited object whose type does NOT merge, so a child
 * replaces it entirely; `/Container` is an inherited object whose type DOES, so
 * it combines. Getting these two the same way round is the whole point.
 */
function db() {
  const database = openDatabase(":memory:");
  const field = database.prepare(
    "INSERT INTO schema_fields (asset_type, json_pointer, inherits_property, merges_properties, " +
      "ref_scope) VALUES (?,?,?,?,?)",
  );
  // Item itself merges, so its own properties combine per field.
  field.run("Item", "", 0, 1, null);
  field.run("Item", "/Interactions", 1, 0, "InteractionMap");
  field.run("Item", "/Icon", 1, 0, null);
  field.run("Item", "/MaxDurability", 1, 0, null);
  field.run("Item", "/Container", 1, 0, "ContainerConfig");
  field.run("Item", "/Unknown", 1, 0, "Opaque");
  // Unmarked, and inherited anyway -- the Recipe case.
  field.run("Item", "/Recipe", 0, 0, null);

  // A map type that replaces wholesale.
  field.run("InteractionMap", "", 0, 0, null);
  // A config type that merges.
  field.run("ContainerConfig", "", 0, 1, null);
  field.run("ContainerConfig", "/Slots", 1, 0, null);
  field.run("ContainerConfig", "/Locked", 1, 0, null);
  // A type with no merge marker at all.
  field.run("Opaque", "", 0, 0, null);
  return database;
}

function loader(assets: Record<string, unknown>): AssetLoader {
  return async (id) =>
    id in assets
      ? { path: `Server/Item/Items/${id}.json`, type: "Item", document: assets[id] }
      : null;
}

/**
 * INVARIANT: a parent is the asset of that name **of the child's type**.
 *
 * Inheritance is within a type — the index enforces it on the edge side with
 * `a.type = src.type`, and the resolver did not, because the loader was handed
 * the caller's `--type` rather than the type of the asset whose parent it was
 * looking for. `get Eggsac` (a BlockSoundSet) merged in the BlockBoundingBoxes
 * named `Cocoon` and answered with `Boxes` where `SoundEvents` belong; nothing
 * on stderr, because the ambiguity note fires for the queried id, never for an
 * ambiguous parent.
 */
test("a parent is resolved within the child's own type", async () => {
  const database = db();
  const seen: (string | null | undefined)[] = [];
  // Two assets share the name `Shared`; only one is an Item.
  const byType: Record<string, Record<string, unknown>> = {
    Item: { Shared: { Icon: "right.png" } },
    Other: { Shared: { Icon: "wrong.png" } },
  };
  const load: AssetLoader = async (id, type) => {
    seen.push(type);
    if (id === "Child") {
      return { path: "p", type: "Item", document: { Parent: "Shared", MaxDurability: 1 } };
    }
    // With no type the wrong one sorts first, exactly as PICK_ORDER did.
    const table = type === null || type === undefined ? byType["Other"]! : byType[type]!;
    return id in table ? { path: "p", type: type ?? "Other", document: table[id]! } : null;
  };

  const r = await resolveAsset(database, "Child", load);
  assert.equal(seen[1], "Item", "the parent lookup was not told the child's type");
  assert.equal((r!.effective as Record<string, unknown>)["Icon"], "right.png");
  database.close();
});

/**
 * INVARIANT: a map unions its keys with the parent's, whatever its values are.
 *
 * Whether the map's ENTRIES combine is a separate question — decided one level
 * down by the entry type's own `mergesProperties`. Keying "is this a map" on the
 * entries' `ref_scope` conflated the two: a map whose values are arrays has no
 * scope, so it was replaced wholesale and every parent-only key vanished.
 * `Farming.Stages` is `{Default, Harvested}` on the crop template and
 * `{Starting, Harvested}` on every tomato, so `Default` disappeared — while the
 * identically-declared `State.Definitions` merged correctly in the same command.
 */
test("a map keeps parent-only keys even when its values do not merge", async () => {
  const database = db();
  // `/Stages` is a map: the schema gives it an entry rule at `/Stages/*`.
  // The entries are arrays, so they cross into no type and cannot merge.
  database
    .prepare(
      "INSERT INTO schema_fields (asset_type, json_pointer, inherits_property, merges_properties, ref_scope) VALUES (?,?,?,?,?)",
    )
    .run("Item", "/Stages", 1, 0, null);
  database
    .prepare(
      "INSERT INTO schema_fields (asset_type, json_pointer, inherits_property, merges_properties, ref_scope) VALUES (?,?,?,?,?)",
    )
    .run("Item", "/Stages/*", 1, 0, null);

  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Stages: { Starting: [1], Harvested: [2] } },
      Base: { Stages: { Default: [9], Harvested: [8] } },
    }),
  );

  const stages = (r!.effective as Record<string, Record<string, unknown>>)["Stages"]!;
  assert.deepEqual(
    Object.keys(stages).sort(),
    ["Default", "Harvested", "Starting"],
    "a parent-only map key was dropped",
  );
  // The child still wins on a shared key: only the KEYS union, not the values.
  assert.deepEqual(stages["Harvested"], [2]);
  assert.deepEqual(stages["Default"], [9]);
  database.close();
});

test("a non-map object with no merging type is still replaced wholesale", async () => {
  // The counterweight to the test above: `/Interactions` has no `/*` entry rule
  // and its type does not merge, so the child replaces it entirely. Widening the
  // map rule must not turn every object into a union.
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Interactions: { Primary: "child" } },
      Base: { Interactions: { Primary: "base", Secondary: "base2" } },
    }),
  );
  assert.deepEqual((r!.effective as Record<string, unknown>)["Interactions"], {
    Primary: "child",
  });
  database.close();
});

test("an asset with no parent resolves to itself", async () => {
  const database = db();
  const r = await resolveAsset(database, "A", loader({ A: { Icon: "a.png" } }));
  assert.deepEqual(r!.effective, { Icon: "a.png" });
  assert.deepEqual(r!.parentChain, []);
  database.close();
});

test("fields absent from the child are inherited when the schema marks them", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Icon: "child.png" },
      Base: { Icon: "base.png", MaxDurability: 250 },
    }),
  );
  assert.deepEqual(r!.effective, {
    Parent: "Base",
    Icon: "child.png",
    MaxDurability: 250,
  });
  assert.deepEqual(r!.parentChain, ["Base"]);
  database.close();
});

test("an unmarked field is still inherited", async () => {
  // This test used to assert the opposite, and asserting it was a mistake.
  //
  // `inheritsProperty` looked like a gate: `Recipe` and `Quality` are unmarked
  // on `Item`, and a child claiming its parent's recipe is a strange thing for
  // an engine to do. But the corpus refutes the gate. `common:FarmingData`
  // marks one of its five properties, so gating dropped `StageSetAfterHarvest`
  // from 14 of the 15 crops inheriting `Template_Crop_Block` -- each of which
  // still carried a `Harvested` stage set that nothing then pointed at. Dead
  // data across fifteen files outweighs an inference from a missing marker.
  //
  // A blind trial believed the tool and wrote it into modding advice: "Quality
  // and Recipe must be re-declared in your own file -- they never come from the
  // parent." That is the cost of stating a rule the data does not support.
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Icon: "child.png" },
      Base: { Icon: "base.png", Recipe: { Output: [{ ItemId: "Base" }] } },
    }),
  );
  assert.deepEqual(r!.effective, {
    Parent: "Base",
    Icon: "child.png",
    Recipe: { Output: [{ ItemId: "Base" }] },
  });
  database.close();
});

test("a map whose entries cross into a merging type is merged per key", async () => {
  // `common:StateData./Definitions` has no `$ref` of its own; `/Definitions/*`
  // continues into BlockType, which merges. Replacing the map wholesale threw
  // away the template's per-stage detail -- `StageFinal.InteractionHint`, the
  // string that makes a crop's last stage harvestable, was gone from every
  // plant in the game.
  const database = openDatabase(":memory:");
  const field = database.prepare(
    "INSERT INTO schema_fields (asset_type, json_pointer, inherits_property, merges_properties, " +
      "ref_scope) VALUES (?,?,?,?,?)",
  );
  field.run("Holder", "", 0, 1, null);
  field.run("Holder", "/Definitions", 0, 0, null);
  field.run("Holder", "/Definitions/*", 0, 0, "Leaf");
  field.run("Leaf", "", 0, 1, null);
  field.run("Leaf", "/Hint", 0, 0, null);
  field.run("Leaf", "/Model", 0, 0, null);

  const load: AssetLoader = async (id) =>
    id === "Child"
      ? {
          path: "c.json",
          type: "Holder",
          document: { Parent: "Base", Definitions: { Final: { Model: "child.model" } } },
        }
      : id === "Base"
        ? {
            path: "b.json",
            type: "Holder",
            document: { Definitions: { Final: { Hint: "harvest", Model: "base.model" } } },
          }
        : null;

  const r = await resolveAsset(database, "Child", load);
  assert.deepEqual((r!.effective as Record<string, unknown>)["Definitions"], {
    Final: { Hint: "harvest", Model: "child.model" },
  });
  database.close();
});

// The rule that a blanket deep merge would get wrong.
test("an inherited object whose type does not merge is replaced wholesale", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Interactions: { Use: "child" } },
      Base: { Interactions: { Use: "base", Attack: "base-attack" } },
    }),
  );
  // Attack must NOT survive: the child replaced the whole Interactions object.
  assert.deepEqual(r!.effective, { Parent: "Base", Interactions: { Use: "child" } });
  database.close();
});

test("an inherited object whose type merges is combined field by field", async () => {
  // The BlockType case. `Item./BlockType` is marked inheritsProperty inside an
  // `anyOf` branch and points at BlockType, whose root declares
  // mergesProperties -- so a crop keeps the template's Support and BlockEntity
  // while overriding State and Farming. Reading either marker on the property
  // node alone made every plant in the game read as unsupported and inert.
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Container: { Slots: { A: 1 } } },
      Base: { Container: { Slots: { B: 2 }, Locked: true } },
    }),
  );
  assert.deepEqual(r!.effective, {
    Parent: "Base",
    // Slots itself is a plain inherited field, so the child's value replaces it;
    // Locked survives because ContainerConfig merges.
    Container: { Slots: { A: 1 }, Locked: true },
  });
  database.close();
});

test("an object whose type declares no merge replaces rather than merging", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Unknown: { a: 1 } },
      Base: { Unknown: { b: 2 } },
    }),
  );
  // Conservative: inventing a merge would fabricate a value present in neither
  // document.
  assert.deepEqual(r!.effective, { Parent: "Base", Unknown: { a: 1 } });
  database.close();
});

test("a multi-level chain folds oldest ancestor first", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "C",
    loader({
      C: { Parent: "B", Icon: "c.png" },
      B: { Parent: "A", MaxDurability: 99 },
      A: { Icon: "a.png", MaxDurability: 10 },
    }),
  );
  assert.deepEqual(r!.parentChain, ["B", "A"]);
  const eff = r!.effective as Record<string, unknown>;
  assert.equal(eff["Icon"], "c.png");
  assert.equal(eff["MaxDurability"], 99);
  database.close();
});

test("origins say where each field came from", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Icon: "child.png" },
      Base: { Icon: "base.png", MaxDurability: 250 },
    }),
  );
  const byPointer = new Map(r!.origins.map((o) => [o.pointer, o]));
  assert.equal(byPointer.get("/Icon")!.via, "declared");
  assert.equal(byPointer.get("/MaxDurability")!.via, "inherited");
  assert.equal(byPointer.get("/MaxDurability")!.from, "Base");
  database.close();
});

/**
 * INVARIANT: one row per pointer, whatever the chain's length.
 *
 * `origins` was one array shared by every fold, and each fold describes a
 * DIFFERENT intermediate document -- so on a chain of two, every pointer the
 * middle ancestor touched appeared twice with opposite attribution. Measured on
 * the corpus: `Plant_Crop_Tomato_Block_Eternal` returned 205 rows for 120
 * pointers, `/Quality` both `inherited` and `declared`, nothing marking which
 * won.
 *
 * The test above this one could not see it: it builds a Map from the rows, and a
 * Map keeps the last write. That is why this asserts on the ARRAY.
 */
test("a longer chain does not duplicate origins, and attribution reaches past the parent", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Middle", Icon: "child.png" },
      Middle: { Parent: "Root", MaxDurability: 250 },
      Root: { Icon: "root.png", MaxDurability: 100, Recipe: { Input: [] } },
    }),
  );
  assert.deepEqual(r!.parentChain, ["Middle", "Root"]);

  const pointers = r!.origins.map((o) => o.pointer);
  assert.equal(
    pointers.length,
    new Set(pointers).size,
    `a pointer is attributed twice: ${pointers.join(", ")}`,
  );

  const at = (p: string) => r!.origins.find((o) => o.pointer === p)!;
  // Declared by the asset itself, and it wins -- the value proves which row is real.
  assert.equal(at("/Icon").via, "declared");
  assert.equal((r!.effective as Record<string, unknown>)["Icon"], "child.png");
  // Handed over by the parent, which declared it.
  assert.equal(at("/MaxDurability").from, "Middle");
  // Handed over by the parent, which did NOT declare it. Naming the middle here
  // would send a modder to a file that does not contain the field.
  assert.equal(at("/Recipe").from, "Root");
  database.close();
});

test("a missing parent is reported, not thrown", async () => {
  const database = db();
  const r = await resolveAsset(database, "Child", loader({ Child: { Parent: "Gone" } }));
  assert.equal(r!.missingParent, "Gone");
  assert.deepEqual(r!.parentChain, []);
  database.close();
});

test("a cyclic parent chain terminates and is flagged", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "A",
    loader({ A: { Parent: "B", x: 1 }, B: { Parent: "A", y: 2 } }),
  );
  assert.ok(r!.truncated);
  assert.deepEqual(r!.parentChain, ["B"]);
  database.close();
});

test("an unknown asset resolves to null", async () => {
  const database = db();
  assert.equal(await resolveAsset(database, "Nope", loader({})), null);
  database.close();
});

test("an untyped asset keeps only what it declares", async () => {
  // 20 202 of 35 074 assets are untyped -- world and prefab content with no
  // codec-backed type. With no schema there is no marker saying which fields
  // inherit, and guessing would be inventing engine behaviour.
  const database = db();
  const load: AssetLoader = async (id) =>
    id === "P"
      ? { path: "p.json", type: null, document: { Parent: "Q", a: 1 } }
      : id === "Q"
        ? { path: "q.json", type: null, document: { a: 2, b: 3 } }
        : null;
  const r = await resolveAsset(database, "P", load);
  assert.deepEqual(r!.effective, { Parent: "Q", a: 1 });
  database.close();
});

test("a union-typed asset resolves its branch before applying rules", async () => {
  // `Interaction` is 102 branches and no fields of its own, so looking a pointer
  // up in it found nothing and every field read as not-inherited.
  // `Explode_Generic_Blocks` came back as an asset named for block damage with
  // no block damage in it.
  const database = openDatabase(":memory:");
  const field = database.prepare(
    "INSERT INTO schema_fields (asset_type, json_pointer, inherits_property, merges_properties, " +
      "ref_scope, discriminator_property, discriminator_values) VALUES (?,?,?,?,?,?,?)",
  );
  field.run("Interaction", "", 0, 0, "ExplodeBranch OtherBranch", "Type", "Explode Other");
  field.run("ExplodeBranch", "", 0, 1, null, null, null);
  field.run("ExplodeBranch", "/Config", 1, 0, "Config", null, null);
  field.run("Config", "", 0, 1, null, null, null);
  field.run("Config", "/DamageBlocks", 1, 0, null, null, null);
  field.run("Config", "/DamageEntities", 1, 0, null, null, null);

  const load: AssetLoader = async (id) =>
    id === "Child"
      ? {
          path: "c.json",
          type: "Interaction",
          document: { Type: "Explode", Parent: "Base", Config: { DamageEntities: false } },
        }
      : id === "Base"
        ? {
            path: "b.json",
            type: "Interaction",
            document: { Type: "Explode", Config: { DamageBlocks: true, DamageEntities: true } },
          }
        : null;

  const r = await resolveAsset(database, "Child", load);
  const config = (r!.effective as Record<string, unknown>)["Config"];
  assert.deepEqual(config, { DamageBlocks: true, DamageEntities: false });
  database.close();
});
