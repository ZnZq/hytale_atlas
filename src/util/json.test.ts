import assert from "node:assert/strict";
import { test } from "node:test";

import { isUnsetDefault, parseJsonLenient } from "./json.ts";

test("valid JSON passes through untouched", () => {
  const { value, repairs } = parseJsonLenient<{ a: number }>('{"a":1}');
  assert.deepEqual(value, { a: 1 });
  assert.equal(repairs.length, 0);
});

test("bare NaN becomes null and is reported with a pointer", () => {
  const { value, repairs } = parseJsonLenient<{ Normal: { default: { X: null } } }>(
    '{"Normal":{"default":{"X":NaN,"Y":NaN,"Z":NaN}}}',
  );
  assert.deepEqual(value, { Normal: { default: { X: null, Y: null, Z: null } } });
  assert.equal(repairs.length, 3);
  assert.deepEqual(repairs[0], { pointer: "/Normal/default/X", token: "NaN" });
  assert.ok(repairs.every(isUnsetDefault));
});

test("Infinity and -Infinity are handled", () => {
  const { value, repairs } = parseJsonLenient<{ max: null; min: null }>(
    '{"max":Infinity,"min":-Infinity}',
  );
  assert.deepEqual(value, { max: null, min: null });
  assert.deepEqual(repairs.map((r) => r.token).sort(), ["-Infinity", "Infinity"]);
});

// The whole reason this module exists rather than a regex: 640 occurrences of
// these words live inside description prose in the real corpus.
test("occurrences inside string literals are preserved", () => {
  const { value, repairs } = parseJsonLenient<{ description: string; d: null }>(
    '{"description":"the value NaN, or Infinity, means unset","d":NaN}',
  );
  assert.equal(value.description, "the value NaN, or Infinity, means unset");
  assert.equal(value.d, null);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]!.pointer, "/d");
});

test("escaped quotes do not confuse the string tracker", () => {
  const { value, repairs } = parseJsonLenient<{ s: string; n: null }>(
    '{"s":"a \\"quoted NaN\\" inside","n":NaN}',
  );
  assert.equal(value.s, 'a "quoted NaN" inside');
  assert.equal(repairs.length, 1);
});

test("a trailing backslash before the closing quote is handled", () => {
  const { value } = parseJsonLenient<{ s: string; n: number }>(
    '{"s":"ends with a backslash \\\\","n":1}',
  );
  assert.equal(value.s, "ends with a backslash \\");
  assert.equal(value.n, 1);
});

test("identifier-prefixed tokens are not mistaken for literals", () => {
  // A bare `NaNo` is not valid JSON, so this must throw rather than silently
  // repairing a prefix of it.
  assert.throws(() => parseJsonLenient('{"a":NaNo}'), SyntaxError);
});

test("keys named NaN are untouched", () => {
  const { value, repairs } = parseJsonLenient<Record<string, number>>('{"NaN":1}');
  assert.deepEqual(value, { NaN: 1 });
  assert.equal(repairs.length, 0);
});

test("pointer segments with / and ~ are escaped per RFC 6901", () => {
  const { repairs } = parseJsonLenient('{"a/b":NaN,"c~d":NaN}');
  assert.deepEqual(
    repairs.map((r) => r.pointer).sort(),
    ["/a~1b", "/c~0d"],
  );
});

test("arrays report indexed pointers", () => {
  const { value, repairs } = parseJsonLenient<{ xs: (number | null)[] }>(
    '{"xs":[1,NaN,3]}',
  );
  assert.deepEqual(value.xs, [1, null, 3]);
  assert.equal(repairs[0]!.pointer, "/xs/1");
});

test("genuinely malformed input still throws, with the source named", () => {
  assert.throws(
    () => parseJsonLenient("{not json at all", "common.json"),
    (err: Error) => err instanceof SyntaxError && err.message.includes("common.json"),
  );
});

test("malformed input containing NaN reports the second failure, not the first", () => {
  assert.throws(
    () => parseJsonLenient('{"a":NaN,,}', "broken.json"),
    (err: Error) => err.message.includes("still invalid after repairing"),
  );
});
