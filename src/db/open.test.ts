import assert from "node:assert/strict";
import { test } from "node:test";

import { bumpEpoch, currentEpoch, getMeta, migrate, openDatabase, setMeta } from "./open.ts";
import { SCHEMA_VERSION } from "./schema.ts";

function fresh() {
  return openDatabase(":memory:");
}

test("a fresh database is created at the current schema version", () => {
  const db = fresh();
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  db.close();
});

test("migrate is idempotent", () => {
  const db = fresh();
  migrate(db);
  migrate(db);
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  db.close();
});

test("a database from a newer schema refuses to open rather than corrupting", () => {
  const db = fresh();
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrate(db), /newer version of hytale-atlas/);
  db.close();
});

test("every documented table exists", () => {
  const db = fresh();
  const names = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
  for (const t of [
    "meta", "packs", "asset_types", "assets", "files", "lang_keys",
    "edges", "candidates", "schema_fields", "schema_defs", "field_stats",
    "assets_fts", "schema_fts",
  ]) {
    assert.ok(names.has(t), `missing table ${t}`);
  }
  db.close();
});

test("epoch starts at zero and increments monotonically", () => {
  const db = fresh();
  assert.equal(currentEpoch(db), 0);
  assert.equal(bumpEpoch(db), 1);
  assert.equal(bumpEpoch(db), 2);
  assert.equal(currentEpoch(db), 2);
  db.close();
});

test("meta round-trips and overwrites in place", () => {
  const db = fresh();
  assert.equal(getMeta(db, "patchline"), null);
  setMeta(db, "patchline", "release");
  assert.equal(getMeta(db, "patchline"), "release");
  setMeta(db, "patchline", "pre-release");
  assert.equal(getMeta(db, "patchline"), "pre-release");
  db.close();
});

test("foreign keys are enforced", () => {
  const db = fresh();
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO assets (pack_id, logical_id, path) VALUES (?,?,?)")
        .run(999, "item:Nope", "Server/Item/Nope.json"),
    /FOREIGN KEY/i,
  );
  db.close();
});

test("deleting a pack cascades to its assets", () => {
  const db = fresh();
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','/x','vanilla')").run();
  db.prepare(
    "INSERT INTO assets (pack_id, logical_id, path) VALUES (1,'item:Sword','Server/Item/Sword.json')",
  ).run();
  db.prepare("DELETE FROM packs WHERE id = 1").run();
  const n = db.prepare("SELECT count(*) AS n FROM assets").get() as { n: number };
  assert.equal(n.n, 0);
  db.close();
});

// The reason localization is in the graph at all: the identifier says Chest, the
// player sees Cuirass, and a search for "cuirass" must still find it.
test("FTS finds an asset by its localized name, not its identifier", () => {
  const db = fresh();
  db.prepare(
    "INSERT INTO assets_fts (logical_id, type, display_name, description) VALUES (?,?,?,?)",
  ).run("item:Armor_Adamantite_Chest", "item", "Adamantite Cuirass", "");
  db.prepare(
    "INSERT INTO assets_fts (logical_id, type, display_name, description) VALUES (?,?,?,?)",
  ).run("item:Bench_Armory", "item", "Forge", "");

  const hits = db
    .prepare("SELECT logical_id FROM assets_fts WHERE assets_fts MATCH ? ORDER BY rank")
    .all("cuirass") as { logical_id: string }[];
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.logical_id, "item:Armor_Adamantite_Chest");

  // 'forge' appears in no identifier anywhere in the corpus.
  const forge = db
    .prepare("SELECT logical_id FROM assets_fts WHERE assets_fts MATCH ? ORDER BY rank")
    .all("forge") as { logical_id: string }[];
  assert.equal(forge[0]!.logical_id, "item:Bench_Armory");
  db.close();
});

test("schema FTS answers 'where does this capability live'", () => {
  const db = fresh();
  const ins = db.prepare(
    "INSERT INTO schema_fts (asset_type, json_pointer, title, description, enum_values) VALUES (?,?,?,?,?)",
  );
  ins.run("buildertool", "/Width", "Width", "Width of the brush area.", "");
  ins.run("item", "/Tool/Specs", "Specs", "Gathering power per material class.", "");

  const hits = db
    .prepare("SELECT asset_type, json_pointer FROM schema_fts WHERE schema_fts MATCH ? ORDER BY rank")
    .all("brush area") as { asset_type: string; json_pointer: string }[];
  assert.equal(hits[0]!.asset_type, "buildertool");
  assert.equal(hits[0]!.json_pointer, "/Width");
  db.close();
});

test("edges model inheritance separately from overriding", () => {
  const db = fresh();
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','/x','vanilla')").run();
  const ins = db.prepare("INSERT INTO assets (id, pack_id, logical_id, path) VALUES (?,1,?,?)");
  ins.run(10, "item:Tool_Pickaxe_Iron", "a.json");
  ins.run(11, "item:Tool_Pickaxe_Crude", "b.json");
  db.prepare(
    "INSERT INTO edges (src, dst, kind, json_pointer, confidence) VALUES (?,?,?,?,?)",
  ).run(10, 11, "INHERITS_FROM", "/Parent", "high");

  const kinds = db.prepare("SELECT kind FROM edges WHERE src = 10").all() as { kind: string }[];
  assert.deepEqual(kinds.map((k) => k.kind), ["INHERITS_FROM"]);
  db.close();
});

// Recursive CTE traversal is how trace_refs works; prove the shape is queryable
// before anything depends on it.
test("a parent chain is walkable with a recursive CTE", () => {
  const db = fresh();
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','/x','vanilla')").run();
  const ins = db.prepare("INSERT INTO assets (id, pack_id, logical_id, path) VALUES (?,1,?,?)");
  ins.run(1, "item:A", "a.json");
  ins.run(2, "item:B", "b.json");
  ins.run(3, "item:C", "c.json");
  const edge = db.prepare("INSERT INTO edges (src, dst, kind) VALUES (?,?,'INHERITS_FROM')");
  edge.run(1, 2);
  edge.run(2, 3);

  const chain = db
    .prepare(
      `WITH RECURSIVE chain(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.dst, chain.depth + 1
         FROM edges e JOIN chain ON e.src = chain.id
         WHERE e.kind = 'INHERITS_FROM' AND chain.depth < 16
       )
       SELECT a.logical_id FROM chain JOIN assets a ON a.id = chain.id ORDER BY chain.depth`,
    )
    .all(1) as { logical_id: string }[];
  assert.deepEqual(chain.map((c) => c.logical_id), ["item:A", "item:B", "item:C"]);
  db.close();
});
