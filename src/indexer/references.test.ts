import assert from "node:assert/strict";
import { test } from "node:test";

import { collectCandidates, toSchemaPointer } from "./references.ts";

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
