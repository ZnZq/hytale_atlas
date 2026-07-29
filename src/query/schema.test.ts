import assert from "node:assert/strict";
import { test } from "node:test";

import { isContainer, looksMangled, normalizeFieldPointer } from "./schema.ts";

/**
 * `describe` labels a field `unused` when nothing in the observed layer joined
 * to it. For a container that is meaningless: an object or array holds no scalar
 * of its own, so it can never appear however heavily the corpus uses it.
 *
 * Printing `unused` on 7 959 container fields was the same failure as
 * `search_schema` reporting that a capability did not exist -- a limit of
 * extraction stated as a fact about the data.
 */

test("containers are recognised in every form the schema writes them", () => {
  for (const t of [
    "object",
    "object|null",
    "array",
    "array|null",
    "anyOf",
    "oneOf",
    "$ref common.json#/definitions/ItemTool",
  ]) {
    assert.equal(isContainer(t), true, t);
  }
});

test("scalars are not containers, so 'unused' still means something for them", () => {
  for (const t of ["string", "string|null", "integer", "number", "boolean", "integer|null"]) {
    assert.equal(isContainer(t), false, t);
  }
});

test("an undeclared field is not assumed to be a container", () => {
  // Observed-only fields have no declared type; calling them containers would
  // hide exactly the rows worth investigating.
  assert.equal(isContainer(null), false);
});

/**
 * `--field` takes a JSON Pointer, which starts with `/` -- and a leading slash is
 * exactly what MSYS rewrites. Under Git Bash, `--field /BlockType` arrives as
 * `C:/Program Files/Git/BlockType`, so the lookup finds nothing and the failure
 * looks like the field does not exist. An agent testing this concluded `--field`
 * was "completely broken" after six attempts, one of them a pointer copied from
 * our own output.
 */

test("a pointer mangled by MSYS is recovered", () => {
  assert.equal(normalizeFieldPointer("C:/Program Files/Git/BlockType"), "/BlockType");
  assert.equal(
    normalizeFieldPointer("C:/Program Files/Git/Tool/Specs"),
    "/Tool/Specs",
  );
});

test("backslash form is recovered too", () => {
  // String.raw, because a plain literal turns \P and \G into P and G, which is
  // how the first version of this test managed to assert the wrong thing.
  assert.equal(
    normalizeFieldPointer(String.raw`C:\Program Files\Git\Recipe\Input`),
    "/Recipe/Input",
  );
});

test("a plain pointer passes through untouched", () => {
  assert.equal(normalizeFieldPointer("/Tool/Speed"), "/Tool/Speed");
});

test("the leading slash is optional, which sidesteps the shell entirely", () => {
  assert.equal(normalizeFieldPointer("Tool/Speed"), "/Tool/Speed");
  assert.equal(normalizeFieldPointer("BlockType"), "/BlockType");
});

test("a trailing slash is trimmed rather than producing an empty segment", () => {
  assert.equal(normalizeFieldPointer("/Tool/"), "/Tool");
});

test("mangling is detected so the user can be told what happened", () => {
  assert.equal(looksMangled("C:/Program Files/Git/BlockType"), true);
  assert.equal(looksMangled("/BlockType"), false);
  assert.equal(looksMangled("BlockType"), false);
});
