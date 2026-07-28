import assert from "node:assert/strict";
import { test } from "node:test";

import { VALUE_SEP, joinValues, splitValues } from "./values.ts";

/**
 * Round-trip tests for the value-list encoding.
 *
 * This is the third delimiter bug in the project and the second of this exact
 * shape, so the guard is the round trip itself rather than any one symptom:
 *
 * 1. The discriminator map was keyed with `\0` on the write side and a space on
 *    the read side. All 21 439 lookups missed, in silence.
 * 2. Value lists were joined and split on a space, so `describe
 *    ScriptedBrushAsset --field Description` rendered two sentences as 25 tokens
 *    that read like an enum of legal values.
 * 3. The fix for (2) kept a tolerant space fallback, which could not tell a
 *    ONE-element list -- which has no separator in it by construction -- from
 *    the old encoding, and split it anyway: `seen: the, Crossroads`.
 *
 * Each was found downstream, by someone reading output. A round trip catches the
 * whole class at the point the encoding is defined.
 */

const CASES: readonly (readonly string[])[] = [
  ["Rocks"],
  ["the Crossroads"],
  ["Test Location"],
  ["Rocks", "Woods", "Soils"],
  ["Example: Places water only where there is NOT stone (demonstrates filtering)"],
  [
    "Example: Places water only where there is NOT stone",
    "Example: Replaces water with lava",
  ],
  ["a", "b"],
  ["value, with, commas"],
  ["trailing space "],
  ["  leading space"],
];

test("every value list round-trips through the encoding", () => {
  for (const values of CASES) {
    const encoded = joinValues(values);
    assert.notEqual(encoded, null, `encoded to null: ${JSON.stringify(values)}`);
    assert.deepEqual(
      splitValues(encoded),
      values,
      `did not round-trip: ${JSON.stringify(values)}`,
    );
  }
});

test("a single value containing spaces is one value, not several", () => {
  // The regression the tolerant fallback caused, pinned at the encoding rather
  // than at one command's output.
  assert.deepEqual(splitValues(joinValues(["the Crossroads"])), ["the Crossroads"]);
});

test("an empty list and an empty string are both absence", () => {
  assert.equal(joinValues([]), null);
  assert.equal(splitValues(null), null);
  assert.equal(splitValues(""), null);
  assert.equal(splitValues(undefined), null);
  assert.equal(splitValues(42), null);
});

test("the separator is one that cannot occur in the corpus", () => {
  // ASCII unit separator. Asserted rather than assumed, because the whole class
  // of bug above is a separator that turned out to occur in the data.
  assert.equal(VALUE_SEP, "\u001f");
  assert.equal(VALUE_SEP.length, 1);
  for (const values of CASES) {
    for (const v of values) {
      assert.ok(!v.includes(VALUE_SEP), `fixture would be ambiguous: ${JSON.stringify(v)}`);
    }
  }
});
