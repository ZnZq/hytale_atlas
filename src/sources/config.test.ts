import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_FILENAME, findConfigFile, readConfig, resolveMods } from "./config.ts";
import { frozenKey } from "../util/paths.ts";

/**
 * The config layer, tested for the failure it exists to prevent.
 *
 * A config that silently does not apply is this project's oldest defect class --
 * an answer that is internally consistent and describes a world the user is not
 * in. So the assertions are mostly about NOISE: a typo must be named, a missing
 * path must be named, and a relative path must not depend on where the tool was
 * invoked from.
 */

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atlas-config-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the config is found by walking up, like package.json", () => {
  const { dir, cleanup } = sandbox();
  try {
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, CONFIG_FILENAME), "{}");
    // Walking up is what makes `npx hytale-atlas` work from a subdirectory of a
    // pack, which is where a modder is when they have a question about the file
    // they are editing.
    assert.equal(findConfigFile(join(dir, "a", "b", "c")), join(dir, CONFIG_FILENAME));
    cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no config anywhere is not an error", () => {
  const { dir, cleanup } = sandbox();
  try {
    assert.equal(findConfigFile(dir), null);
  } finally {
    cleanup();
  }
});

test("an unknown key is reported rather than ignored", () => {
  const { dir, cleanup } = sandbox();
  try {
    const file = join(dir, CONFIG_FILENAME);
    // `assetsZip` is the plausible wrong spelling: it is what the field is called
    // everywhere else in this tool's output. Dropping it in silence would answer
    // questions about the detected install while the user believed otherwise.
    writeFileSync(file, JSON.stringify({ assetsZip: "somewhere" }));
    const config = readConfig(file);
    assert.equal(config.assets, null);
    assert.ok(
      config.problems.some((p) => p.includes("assetsZip")),
      `the typo was swallowed: ${JSON.stringify(config.problems)}`,
    );
  } finally {
    cleanup();
  }
});

test("malformed JSON is a reported problem, not a throw", () => {
  const { dir, cleanup } = sandbox();
  try {
    const file = join(dir, CONFIG_FILENAME);
    writeFileSync(file, "{ not json");
    // `status` is the command whose whole job is explaining why nothing works.
    // It must survive the file that broke everything.
    const config = readConfig(file);
    assert.equal(config.problems.length, 1);
    assert.match(config.problems[0]!, /not valid JSON/);
  } finally {
    cleanup();
  }
});

test("relative paths resolve against the config file, not the cwd", () => {
  const { dir, cleanup } = sandbox();
  try {
    mkdirSync(join(dir, "nested"), { recursive: true });
    const file = join(dir, "nested", CONFIG_FILENAME);
    writeFileSync(file, JSON.stringify({ assets: "../Assets.zip" }));
    // A config committed to a repository has to mean the same thing from every
    // directory, so this can never be resolved against process.cwd().
    assert.equal(readConfig(file).assets, join(dir, "Assets.zip"));
  } finally {
    cleanup();
  }
});

test("mods.dir selects archives, and exclude patterns skip them", () => {
  const { dir, cleanup } = sandbox();
  try {
    const mods = join(dir, "Mods");
    mkdirSync(mods, { recursive: true });
    for (const name of ["A.jar", "B.zip", "BetterMap-1.0.jar", "notes.txt"]) {
      writeFileSync(join(mods, name), "");
    }
    const { packs, problems } = resolveMods({
      dir: mods,
      include: [],
      exclude: ["BetterMap*"],
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(
      packs.map((p) => p.path.split(/[\\/]/).pop()),
      ["A.jar", "B.zip"],
      "a non-archive or an excluded name got through",
    );
  } finally {
    cleanup();
  }
});

test("an explicit include is not vetoed by an exclude pattern", () => {
  const { dir, cleanup } = sandbox();
  try {
    const mods = join(dir, "Mods");
    mkdirSync(mods, { recursive: true });
    writeFileSync(join(mods, "Wanted.jar"), "");
    // Naming a file and pattern-excluding it are both deliberate, and the named
    // one is more specific. Letting a broad pattern cancel it silently would
    // leave the reader with no way to see why their pack is missing.
    const { packs } = resolveMods({
      dir: null,
      include: [join(mods, "Wanted.jar")],
      exclude: ["*"],
    });
    assert.equal(packs.length, 1);
    assert.equal(packs[0]!.from, "include");
  } finally {
    cleanup();
  }
});

test("a mods path that does not exist is named, not dropped", () => {
  const { dir, cleanup } = sandbox();
  try {
    const { packs, problems } = resolveMods({
      dir: join(dir, "NoSuchDir"),
      include: [join(dir, "NoSuchPack.jar")],
      exclude: [],
    });
    assert.equal(packs.length, 0);
    // Otherwise "no mods were indexed" reads as "you have no mods".
    assert.equal(problems.length, 2, `expected both paths named: ${JSON.stringify(problems)}`);
  } finally {
    cleanup();
  }
});

/**
 * INVARIANT: the cache key identifies the whole SET of sources.
 *
 * Keying on Assets.zip alone stops being correct the moment third-party packs
 * join the index -- two different mod sets would land on one cache directory, so
 * adding a mod would silently serve the index built without it. Nothing about
 * that failure looks broken, which is what makes it the worst one available.
 */
test("the cache key covers every source and ignores their order", () => {
  const a = { path: "/x/Assets.zip", size: 10, mtimeMs: 1 };
  const b = { path: "/y/Mod.jar", size: 20, mtimeMs: 2 };

  assert.equal(frozenKey(a, b), frozenKey(b, a), "discovery order changed the key");
  assert.notEqual(frozenKey(a), frozenKey(a, b), "adding a pack did not change the key");
  assert.notEqual(
    frozenKey(a, b),
    frozenKey(a, { ...b, mtimeMs: 3 }),
    "editing a pack did not change the key",
  );
});

test("one source hashes exactly as it did before the key generalised", () => {
  // Deliberate compatibility: existing caches stay valid, so nobody pays for a
  // rebuild that gains them nothing. This pins the digest so a future change to
  // the hashing cannot invalidate every machine's cache by accident.
  assert.equal(
    frozenKey({ path: "/x/Assets.zip", size: 10, mtimeMs: 1 }),
    "f086de5e70540828",
  );
});
