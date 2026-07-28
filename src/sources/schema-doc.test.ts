import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readGeneratedSchemas } from "./schema-doc.ts";

/**
 * `hytaleAssetRef` is the marker that turns a reference edge from a guess into a
 * declared fact, and an OPTIONAL reference does not carry it on the property --
 * it carries it on the `anyOf` branch holding the `$ref`, beside the `null`
 * branch that makes it optional.
 *
 * Reading only the property node found 545 of 802; the 363 it missed were graded
 * as name collisions. Same shape as `hytale.inheritsProperty`, which had already
 * been fixed for exactly this reason.
 */

function withSchema<T>(files: Record<string, unknown>, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hytale-atlas-schema-"));
  try {
    mkdirSync(join(dir, "Schema"));
    for (const [name, body_] of Object.entries(files)) {
      writeFileSync(join(dir, "Schema", name), JSON.stringify(body_));
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("hytaleAssetRef is read from an anyOf branch, not only from the property", () => {
  const set = withSchema(
    {
      "Item.json": {
        hytale: { path: "Item/Items" },
        type: "object",
        properties: {
          // The shape the generator emits for an optional reference.
          DropList: {
            anyOf: [
              { $ref: "ItemDropList.json#", hytaleAssetRef: "ItemDropList" },
              { type: "null" },
            ],
          },
          // The shape it emits for a required one, already handled.
          SoundEventId: { type: "string", hytaleAssetRef: "SoundEvent" },
        },
      },
      "ItemDropList.json": { hytale: { path: "ItemDropList" }, type: "object", properties: {} },
    },
    readGeneratedSchemas,
  );

  const byPointer = new Map(
    set.fields.filter((f) => f.assetType === "Item").map((f) => [f.pointer, f]),
  );
  assert.equal(byPointer.get("/DropList")?.referenceTarget, "ItemDropList");
  assert.equal(byPointer.get("/SoundEventId")?.referenceTarget, "SoundEvent");
  // The crossing must survive alongside the target: align() needs one, the
  // reference resolver needs the other.
  assert.equal(byPointer.get("/DropList")?.refScope, "ItemDropList");
});

test("a property whose branches declare no target still reports none", () => {
  const set = withSchema(
    {
      "Item.json": {
        hytale: { path: "Item/Items" },
        type: "object",
        properties: {
          Colour: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
    readGeneratedSchemas,
  );
  assert.equal(
    set.fields.find((f) => f.pointer === "/Colour")?.referenceTarget,
    null,
  );
});

/**
 * The corpus is Hytale-derived and gitignored, so this skips on a fresh clone.
 * Bounds rather than exact counts: the figures move with the patchline, and the
 * property under test is "branch-declared targets are seen at all".
 */
const SCHEMA_DIR = join(process.cwd(), "local", "schema-release");
const available = existsSync(join(SCHEMA_DIR, "Schema"));

test(
  "the real schema's branch-declared references are picked up",
  { skip: available ? false : `no schemas at ${SCHEMA_DIR}` },
  () => {
    const set = readGeneratedSchemas(SCHEMA_DIR);
    const withTarget = set.fields.filter((f) => f.referenceTarget !== null);

    // 545 before the branch was read, ~900 after. Anything at or below the old
    // figure means the branch lookup stopped working.
    assert.ok(
      withTarget.length > 700,
      `expected the branch-declared targets to be included, found ${withTarget.length}`,
    );

    // Interaction is the biggest target reachable only through a branch (205
    // properties); before the fix not one of them was declared.
    const targets = new Set(withTarget.map((f) => f.referenceTarget));
    for (const expected of ["Interaction", "RootInteraction", "ItemDropList", "BlockSet"]) {
      assert.ok(targets.has(expected), `no field declares a reference to ${expected}`);
    }
  },
);
