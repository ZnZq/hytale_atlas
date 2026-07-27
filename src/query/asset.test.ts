import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase } from "../db/open.ts";
import { type AssetLoader, resolveAsset } from "./asset.ts";

/**
 * Fixtures mirror the shape measured on `Item`: `/Interactions` is an object
 * marked `inheritsProperty` (replaces wholesale) while `/Container` is an object
 * marked `mergesProperties` (combines). Getting these two the same way round is
 * the whole point of the module.
 */
function db() {
  const database = openDatabase(":memory:");
  const ins = database.prepare(
    "INSERT INTO schema_fields (asset_type, json_pointer, inherits_property, merges_properties) VALUES (?,?,?,?)",
  );
  ins.run("Item", "/Interactions", 1, 0);
  ins.run("Item", "/Icon", 1, 0);
  ins.run("Item", "/Container", 0, 1);
  ins.run("Item", "/Container/Slots", 0, 1);
  return database;
}

function loader(assets: Record<string, unknown>): AssetLoader {
  return async (id) =>
    id in assets
      ? { path: `Server/Item/Items/${id}.json`, type: "Item", document: assets[id] }
      : null;
}

test("an asset with no parent resolves to itself", async () => {
  const database = db();
  const r = await resolveAsset(database, "A", loader({ A: { Icon: "a.png" } }));
  assert.deepEqual(r!.effective, { Icon: "a.png" });
  assert.deepEqual(r!.parentChain, []);
  database.close();
});

test("fields absent from the child are inherited", async () => {
  const database = db();
  const r = await resolveAsset(
    database,
    "Child",
    loader({
      Child: { Parent: "Base", Icon: "child.png" },
      Base: { Icon: "base.png", MaxDurability: 250, Quality: "Common" },
    }),
  );
  assert.deepEqual(r!.effective, {
    Parent: "Base",
    Icon: "child.png",
    MaxDurability: 250,
    Quality: "Common",
  });
  assert.deepEqual(r!.parentChain, ["Base"]);
  database.close();
});

// The rule that a blanket deep merge would get wrong.
test("an object marked inheritsProperty is replaced wholesale", async () => {
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

test("an object marked mergesProperties is combined field by field", async () => {
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
    Container: { Slots: { A: 1, B: 2 }, Locked: true },
  });
  database.close();
});

test("an unmarked field replaces rather than merging", async () => {
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
      B: { Parent: "A", Quality: "Rare" },
      A: { Icon: "a.png", MaxDurability: 10, Quality: "Common" },
    }),
  );
  assert.deepEqual(r!.parentChain, ["B", "A"]);
  const eff = r!.effective as Record<string, unknown>;
  assert.equal(eff["Icon"], "c.png");
  assert.equal(eff["Quality"], "Rare");
  assert.equal(eff["MaxDurability"], 10);
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

test("an untyped asset still resolves, with no merge rules", async () => {
  const database = db();
  const load: AssetLoader = async (id) =>
    id === "P"
      ? { path: "p.json", type: null, document: { Parent: "Q", a: 1 } }
      : id === "Q"
        ? { path: "q.json", type: null, document: { a: 2, b: 3 } }
        : null;
  const r = await resolveAsset(database, "P", load);
  assert.deepEqual(r!.effective, { Parent: "Q", a: 1, b: 3 });
  database.close();
});
