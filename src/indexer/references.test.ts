import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase } from "../db/open.ts";
import { collectCandidates, resolveCandidates, toSchemaPointer } from "./references.ts";

/**
 * Candidate collection decides what the observed layer can ever see.
 *
 * Numbers and booleans were originally skipped on the reasoning that they cannot
 * be references. They cannot -- but skipping them meant all 1 963 non-string
 * scalar fields were absent from `field_stats` and so reported as `unused` by
 * `describe_schema`, a claim about the corpus that was really a claim about
 * extraction. `Item./ItemLevel` was labelled unused while vanilla sets it to 40.
 *
 * These tests pin both halves: non-strings ARE collected, and they carry a kind
 * so edge building can exclude them.
 */

test("string scalars are collected and marked as strings", () => {
  const out = collectCandidates({ ItemId: "Plant_Fruit_Apple" });
  assert.deepEqual(out, [
    {
      pointer: "/ItemId",
      schemaPointer: "/ItemId",
      value: "Plant_Fruit_Apple",
      kind: "string",
    },
  ]);
});

test("numbers and booleans are collected, with their kind", () => {
  const out = collectCandidates({ ItemLevel: 40, Harvest: true, Speed: 1.5 });
  assert.deepEqual(
    out.map((c) => [c.pointer, c.value, c.kind]),
    [
      ["/ItemLevel", "40", "number"],
      ["/Harvest", "true", "boolean"],
      ["/Speed", "1.5", "number"],
    ],
  );
});

test("non-finite numbers are skipped: they mean unset, not observed", () => {
  // parseJsonLenient repairs bare NaN/Infinity into real non-finite numbers, and
  // those are the schema's way of spelling "no default", not a measurement.
  assert.deepEqual(collectCandidates({ A: Number.NaN, B: Number.POSITIVE_INFINITY }), []);
});

test("generic values are collected, not dropped at extraction", () => {
  // They used to be filtered here, which removed them from the OBSERVED layer as
  // well as from reference matching. 'Default' is the stage set every crop starts
  // in and 'All' is a real bench category, so `describe` reported a field used by
  // 103 assets as used by 2. Filtering now happens where it belongs: when
  // matching a value against the symbol table.
  for (const value of ["Default", "All", "None", "false"]) {
    const out = collectCandidates({ Flag: value });
    assert.equal(out.length, 1, `'${value}' was dropped at extraction`);
    assert.equal(out[0]!.kind, "string");
  }
});

test("a boolean is still distinguished from the string spelling it", () => {
  assert.deepEqual(
    collectCandidates({ Flag: false }).map((c) => [c.value, c.kind]),
    [["false", "boolean"]],
  );
  assert.deepEqual(
    collectCandidates({ Flag: "false" }).map((c) => [c.value, c.kind]),
    [["false", "string"]],
  );
});

test("zero is collected rather than treated as empty", () => {
  assert.deepEqual(
    collectCandidates({ Quantity: 0 }).map((c) => [c.value, c.kind]),
    [["0", "number"]],
  );
});

test("array indices are kept in the pointer and collapsed in the schema pointer", () => {
  const out = collectCandidates({ Input: [{ ItemId: "Wood", Quantity: 3 }] });
  assert.deepEqual(
    out.map((c) => [c.pointer, c.schemaPointer, c.kind]),
    [
      ["/Input/0/ItemId", "/Input/*/ItemId", "string"],
      ["/Input/0/Quantity", "/Input/*/Quantity", "number"],
    ],
  );
});

test("node-editor scratch keys are still skipped, whatever their value type", () => {
  const out = collectCandidates({ $NodeId: 12, $NodeEditorMetadata: { x: 1 }, Real: 5 });
  assert.deepEqual(out.map((c) => c.pointer), ["/Real"]);
});

test("schema pointers collapse every array index, not just the first", () => {
  assert.equal(toSchemaPointer("/A/0/B/12/C"), "/A/*/B/*/C");
});

/**
 * The 96-character ceiling is a rule about IDENTIFIERS, and it was applied to
 * every string. 959 of the 1 144 over-long values in the release corpus name a
 * path that is already in `files`, audio above all -- so the file rule never saw
 * them and 403 `.ogg` files ended up with no inbound reference at all.
 */
test("a file path longer than the identifier ceiling is still collected", () => {
  const path =
    "Sounds/Environments/Zone1/Environments/Forest/Day/Autumn/Emitters/Birds/Emit_Bird_Wings_Stereo_01.ogg";
  assert.ok(path.length > 96, "fixture must exceed the identifier ceiling");
  assert.deepEqual(
    collectCandidates({ Track: path }).map((c) => c.value),
    [path],
  );
});

test("the exemption is for paths, not for length: prose and bare words stay out", () => {
  const prose = `${"A sentence about the asset. ".repeat(4)}It ends here.`;
  const noSlash = `${"Very_Long_Identifier_".repeat(6)}End.json`;
  assert.ok(prose.length > 96 && noSlash.length > 96);
  // prose has spaces; noSlash has no directory separator -- nothing in the
  // archive sits directly in Common/, so neither can name a file.
  assert.deepEqual(collectCandidates({ Description: prose }), []);
  assert.deepEqual(collectCandidates({ Name: noSlash }), []);
});

test("a path is not collected without limit either", () => {
  const absurd = `Sounds/${"Nested/".repeat(40)}Thing.ogg`;
  assert.ok(absurd.length > 192);
  assert.deepEqual(collectCandidates({ Track: absurd }), []);
});

/**
 * `dangling = 1` is the population `validate` reports as "named something and
 * matched nothing". Testing only `assets` and `lang_keys` marked every resolved
 * FILE reference dangling -- all 33 782 -- and every localization reference
 * spelled with its `server.` root, because the LOCALIZED_BY join strips that
 * prefix and this test did not.
 */
test("a candidate that resolved to a file is not reported as dangling", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')").run();
  db.prepare(
    "INSERT INTO assets (id, pack_id, logical_id, path) VALUES (1,1,'Ambience_Savannah','Server/Audio/AmbienceFX/Ambience_Savannah.json')",
  ).run();
  db.prepare("INSERT INTO files (id, pack_id, path, kind) VALUES (1,1,'Common/Sounds/Savannah_LOOP.ogg','audio')").run();
  const candidate = db.prepare(
    "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind) VALUES (1,?,?,?,'string')",
  );
  candidate.run("/Track", "/Track", "Sounds/Savannah_LOOP.ogg");
  candidate.run("/Nowhere", "/Nowhere", "Sounds/Absent_LOOP.ogg");

  const result = resolveCandidates(db);
  assert.equal(result.fileReferences, 1);

  const rows = db
    .prepare("SELECT json_pointer, dangling FROM candidates ORDER BY json_pointer")
    .all() as unknown as { json_pointer: string; dangling: number }[];
  assert.deepEqual(
    rows.map((r) => [r.json_pointer, r.dangling]),
    [
      ["/Nowhere", 1], // names no file: genuinely dangling
      ["/Track", 0], // has a REFERENCES_FILE edge saying what it matched
    ],
  );
  assert.equal(result.dangling, 1);
  db.close();
});

/**
 * `IS` treats NULL as comparable, so two assets of unknown type satisfied "the
 * same type" and inherited from each other at `high` -- the tier that means the
 * relationship was read, not guessed.
 */
test("two untyped assets do not inherit from each other", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')").run();
  // Same logical_id, no type on either: nothing is known about their kinds.
  db.prepare("INSERT INTO assets (id, pack_id, logical_id, path) VALUES (1,1,'Entry.node','Server/A/Entry.node.json')").run();
  db.prepare("INSERT INTO assets (id, pack_id, logical_id, path) VALUES (2,1,'Entry.node','Server/B/Entry.node.json')").run();
  db.prepare(
    "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind) VALUES (1,'/Parent','/Parent','Entry.node','string')",
  ).run();

  const result = resolveCandidates(db);
  assert.equal(result.inherits, 0);
  db.close();
});

test("two assets of the same known type still inherit", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')").run();
  db.prepare("INSERT INTO asset_types (id, source) VALUES ('BlockSoundSet','codec')").run();
  db.prepare("INSERT INTO assets (id, pack_id, logical_id, path, type) VALUES (1,1,'Stone_Cobble','Server/S/Stone_Cobble.json','BlockSoundSet')").run();
  db.prepare("INSERT INTO assets (id, pack_id, logical_id, path, type) VALUES (2,1,'Stone','Server/S/Stone.json','BlockSoundSet')").run();
  db.prepare(
    "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind) VALUES (1,'/Parent','/Parent','Stone','string')",
  ).run();

  assert.equal(resolveCandidates(db).inherits, 1);
  db.close();
});

/**
 * A reference is `<root>.<key>`, for EVERY root -- not just server. and common.
 *
 * The fixture here used to set root='items' on a key stored as 'items.apple.name'
 * and then reference it as 'server.items.apple.name'. That combination cannot
 * occur: `root` is the .lang file's stem, so a key inside server.lang has
 * root='server', and one inside items.lang has root='items' with the stem NOT
 * repeated in the key. It passed only because the rule it pinned ignored `root`
 * entirely and stripped a hardcoded pair of prefixes -- which is exactly the
 * defect a blind trial later found: this corpus holds 36 roots, and references
 * under the other 34 produced no edge at all, so `search-lang` reported keys
 * declared in an asset's TranslationProperties as "used by nothing indexed".
 *
 * Both shapes are pinned now, from the two roots that actually dominate the
 * corpus: server (54,516 keys) and items (5,522).
 */
test("a localization reference resolves through its key's own root", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO packs (id, name, path, kind) VALUES (1,'Hytale','Assets.zip','vanilla')").run();
  db.prepare(
    "INSERT INTO assets (id, pack_id, logical_id, path) VALUES (1,1,'Item_Apple','Server/Item/Items/Item_Apple.json')",
  ).run();
  db.prepare(
    "INSERT INTO assets (id, pack_id, logical_id, path) VALUES (2,1,'Modded_Hat','Server/Item/Items/Modded_Hat.json')",
  ).run();
  // Vanilla: server.lang, so the stem is the root and the key keeps its own path.
  db.prepare(
    "INSERT INTO lang_keys (pack_id, key, locale, value, root) VALUES (1,'items.apple.name','en-US','Apple','server')",
  ).run();
  // A pack: items.lang, so the root IS 'items' and the key does not repeat it.
  db.prepare(
    "INSERT INTO lang_keys (pack_id, key, locale, value, root) VALUES (1,'Modded_Hat.name','en-US','Hat','items')",
  ).run();
  db.prepare(
    "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind) VALUES (1,'/Name','/Name','server.items.apple.name','string')",
  ).run();
  db.prepare(
    "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind) VALUES (2,'/Name','/Name','items.Modded_Hat.name','string')",
  ).run();

  const result = resolveCandidates(db);
  assert.equal(result.localizedBy, 2, "one of the two roots produced no edge");
  assert.equal(result.dangling, 0);
  db.close();
});
