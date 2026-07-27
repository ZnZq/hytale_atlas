import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isUnsetDefault, readJsonFileLenient } from "./json.ts";

/**
 * Runs the tolerant reader over the real generated schemas.
 *
 * The corpus is Hytale-derived and therefore gitignored (`local/`), so this skips
 * on a fresh clone and on CI. Regenerate with:
 *
 * ```
 * java -jar HytaleServer.jar --bare --assets <Assets.zip> \
 *      --generate-asset-schema <dir>
 * ```
 *
 * Re-run it after a patchline update: the shape of the defect is not guaranteed to
 * stay the same, and this is the cheapest place to notice that it changed.
 */

const SCHEMA_DIR = join(process.cwd(), "local", "schema-release", "Schema");
const available = existsSync(SCHEMA_DIR);

test(
  "every generated schema parses, and only the known defect needs repair",
  { skip: available ? false : `no schemas at ${SCHEMA_DIR}` },
  () => {
    const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"));
    assert.ok(files.length > 50, `expected a full schema set, found ${files.length}`);

    const repairedFiles: string[] = [];
    let proseWithNonFiniteWords = 0;

    for (const file of files) {
      const { value, repairs } = readJsonFileLenient<Record<string, unknown>>(
        join(SCHEMA_DIR, file),
      );
      assert.equal(typeof value, "object", `${file} did not parse to an object`);

      if (repairs.length > 0) {
        repairedFiles.push(file);
        // Every non-finite we have seen is a codec default meaning "unset".
        // If this ever fails, the generator started emitting them somewhere new
        // and describe_schema's rendering needs revisiting.
        assert.ok(
          repairs.every(isUnsetDefault),
          `${file}: non-finite outside a default — ${JSON.stringify(repairs)}`,
        );
      }

      // Prose mentioning these words must survive verbatim; corrupting it is the
      // exact failure a regex-based repair would produce.
      const walk = (node: unknown): void => {
        if (typeof node === "string") {
          if (/\b(NaN|Infinity)\b/.test(node)) proseWithNonFiniteWords++;
          return;
        }
        if (node !== null && typeof node === "object") Object.values(node).forEach(walk);
      };
      walk(value);
    }

    assert.deepEqual(
      repairedFiles,
      ["common.json"],
      "the set of files needing repair changed",
    );
    assert.ok(
      proseWithNonFiniteWords > 100,
      `expected the corpus to contain prose mentioning NaN/Infinity, found ${proseWithNonFiniteWords}`,
    );
  },
);
