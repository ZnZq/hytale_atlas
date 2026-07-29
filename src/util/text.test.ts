import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  buildMatchExpression,
  buildRelaxedMatchExpressions,
  containsIdeograph,
  expandIdentifiers,
  normalizeSearchText,
  relaxTerm,
} from "./text.ts";

test("Latin text passes through unchanged", () => {
  assert.equal(normalizeSearchText("Adamantite Cuirass"), "Adamantite Cuirass");
});

test("ideographs are segmented into separate tokens", () => {
  assert.equal(normalizeSearchText("洞穴蜘蛛"), "洞 穴 蜘 蛛");
  assert.equal(normalizeSearchText("锻炉"), "锻 炉");
});

test("Ukrainian ghe with upturn folds to plain ghe, both cases", () => {
  assert.equal(normalizeSearchText("Ґоблінський"), "Гоблінський");
  assert.equal(normalizeSearchText("ґанок"), "ганок");
});

test("Cyrillic that is not ghe-with-upturn is untouched", () => {
  assert.equal(normalizeSearchText("Адамантитова кіраса"), "Адамантитова кіраса");
});

test("mixed scripts segment only the ideographs", () => {
  assert.equal(normalizeSearchText("Iron 铁镐 pickaxe"), "Iron 铁 镐 pickaxe");
});

test("containsIdeograph distinguishes scripts", () => {
  assert.ok(containsIdeograph("锻炉"));
  assert.ok(!containsIdeograph("Ковальня"));
});

test("match expressions quote terms and add the prefix operator", () => {
  assert.equal(buildMatchExpression("iron pickaxe"), '"iron"* AND "pickaxe"*');
  assert.equal(buildMatchExpression("iron", { prefix: false }), '"iron"');
});

test("a segmented ideograph run stays a single phrase", () => {
  // Not '"蜘"* AND "蛛"*', which would match any name containing both characters
  // anywhere rather than the word 蜘蛛.
  assert.equal(buildMatchExpression("蜘蛛"), '"蜘 蛛"');
});

test("FTS5 operators typed by a user are neutralised", () => {
  const expr = buildMatchExpression('sword OR NOT "x"')!;
  // OR / NOT become ordinary quoted terms rather than boolean operators.
  assert.equal(expr, '"sword"* AND "OR"* AND "NOT"* AND """x"""*');
  // A term the user quoted survives as a literal: doubling is FTS5's escape, so
  // """x""" is the three-character string  "x"  and not a syntax error.
  assert.ok(expr.includes('"""x"""'), expr);
});

test("a quoted term is still a valid FTS5 expression", () => {
  const db = corpusDb();
  // Would throw if the escaping produced malformed syntax.
  assert.doesNotThrow(() => run(db, buildMatchExpression('say "hi"')!));
  db.close();
});

test("an empty query yields null rather than a match-everything expression", () => {
  assert.equal(buildMatchExpression("   "), null);
  assert.equal(buildMatchExpression(""), null);
});

// ---------------------------------------------------------------------------
// End-to-end against FTS5, using real display names from the five shipped locales.
// ---------------------------------------------------------------------------

const CORPUS: readonly [string, string, string][] = [
  ["Spider_Cave", "zh-CN", "洞穴蜘蛛"],
  ["Spider_Cave", "uk-UA", "Печерний павук"],
  ["Spider_Cave", "en-US", "Cave Spider"],
  ["Bench_Armory", "zh-CN", "锻炉"],
  ["Bench_Armory", "uk-UA", "Ковальня"],
  ["Bench_Armory", "en-US", "Forge"],
  ["Bench_Weapon", "zh-CN", "锻造铁砧"],
  ["Bench_Weapon", "ru-RU", "Наковальня кузнеца"],
  ["Snake_Rattle", "zh-CN", "响尾蛇"],
  ["Deco_Chair_Scrap", "uk-UA", "Ґоблінський трон"],
  ["Armor_Adamantite_Chest", "uk-UA", "Адамантитова кіраса"],
  ["Tool_Pickaxe_Iron", "uk-UA", "Залізне кайло"],
];

function corpusDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE VIRTUAL TABLE f USING fts5(id, locale, name, " +
      "tokenize='unicode61 remove_diacritics 2', prefix='2 3')",
  );
  const ins = db.prepare("INSERT INTO f(id, locale, name) VALUES (?,?,?)");
  for (const [id, locale, name] of CORPUS) ins.run(id, locale, normalizeSearchText(name));
  return db;
}

/** Strict: exactly what the user typed, prefix-matched. No suffix trimming. */
function findStrict(db: DatabaseSync, query: string): string[] {
  const expr = buildMatchExpression(query);
  return expr === null ? [] : run(db, expr);
}

/** What the search layer will actually do: relax progressively until something hits. */
function find(db: DatabaseSync, query: string): string[] {
  for (const expr of buildRelaxedMatchExpressions(query)) {
    const hits = run(db, expr);
    if (hits.length > 0) return hits;
  }
  return [];
}

function run(db: DatabaseSync, expr: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT id FROM f WHERE f MATCH ? ORDER BY rank")
    .all(expr) as { id: string }[];
  return rows.map((r) => r.id);
}

test("Chinese infix search works — the noun is at the end of a compound", () => {
  const db = corpusDb();
  // 蜘蛛 = "spider", the trailing half of 洞穴蜘蛛 = "cave spider".
  // Prefix indexing alone cannot reach this; segmentation is what makes it work.
  assert.deepEqual(find(db, "蜘蛛"), ["Spider_Cave"]);
  assert.deepEqual(find(db, "铁砧"), ["Bench_Weapon"]);
  assert.deepEqual(find(db, "尾蛇"), ["Snake_Rattle"]);
  db.close();
});

test("Chinese leading and whole-word search still works", () => {
  const db = corpusDb();
  assert.deepEqual(find(db, "洞穴"), ["Spider_Cave"]);
  assert.deepEqual(find(db, "锻炉"), ["Bench_Armory"]);
  db.close();
});

test("Ukrainian ghe folding works in both directions", () => {
  const db = corpusDb();
  assert.deepEqual(find(db, "гоблінський"), ["Deco_Chair_Scrap"]);
  assert.deepEqual(find(db, "Ґоблінський"), ["Deco_Chair_Scrap"]);
  db.close();
});

// Documents the limit rather than hiding it: prefix matching needs the QUERY to be
// a prefix of the INDEXED term, so a full inflected form diverging at the last
// letter misses. This is why relaxation exists.
test("prefix matching alone does NOT reach a full inflected form", () => {
  const db = corpusDb();
  assert.deepEqual(findStrict(db, "кірасу"), [], "кірасу is not a prefix of кіраса");
  assert.deepEqual(findStrict(db, "кірас"), ["Armor_Adamantite_Chest"], "the stem does work");
  db.close();
});

test("progressive relaxation reaches inflected Ukrainian and Russian forms", () => {
  const db = corpusDb();
  // Case forms a user would actually type, rather than stems they would not.
  assert.deepEqual(find(db, "кірасу"), ["Armor_Adamantite_Chest"]);   // accusative
  assert.deepEqual(find(db, "ковальню"), ["Bench_Armory"]);           // accusative
  assert.deepEqual(find(db, "павука"), ["Spider_Cave"]);              // genitive
  assert.deepEqual(find(db, "кузнеца"), ["Bench_Weapon"]);            // ru genitive
  assert.deepEqual(find(db, "адамантитової"), ["Armor_Adamantite_Chest"]); // fem. genitive
  db.close();
});

test("relaxation stops before short terms become meaningless", () => {
  // 'Хліб' is four letters; trimming it would match almost anything.
  assert.equal(relaxTerm("хліб", 3), "хліб");
  assert.equal(relaxTerm("кірасу", 1), "кірас");
  assert.equal(relaxTerm("кірасу", 99), "кіра", "never shorter than the floor");
  assert.equal(relaxTerm("锻", 2), "锻", "ideographs are never trimmed");
});

test("relaxation is ordered strictest first and deduplicated", () => {
  const exprs = buildRelaxedMatchExpressions("кірасу");
  assert.equal(exprs[0], '"кірасу"*', "strictest first");
  assert.ok(exprs.length > 1 && exprs.length <= 4);
  assert.equal(new Set(exprs).size, exprs.length, "no duplicates");
  // A short query cannot be relaxed, so it yields a single expression.
  assert.deepEqual(buildRelaxedMatchExpressions("хліб"), ['"хліб"*']);
});

test("one asset is found by any of its locales", () => {
  const db = corpusDb();
  for (const query of ["Cave Spider", "Печерний павук", "洞穴蜘蛛"]) {
    assert.deepEqual(find(db, query), ["Spider_Cave"], `failed for ${query}`);
  }
  db.close();
});

test("identifier expansion keeps the original and adds the split words", () => {
  const out = expandIdentifiers("/Gathering/Breaking/GatherType").split(" ");
  assert.ok(out.includes("GatherType"), "exact identifier is preserved");
  assert.ok(out.includes("Gather") && out.includes("Type"), "camelCase is split");
  assert.ok(out.includes("Gathering") && out.includes("Breaking"));
});

test("identifier expansion splits acronym runs at the right boundary", () => {
  const out = expandIdentifiers("UIElementID").split(" ");
  assert.ok(out.includes("UI"), "leading acronym");
  assert.ok(out.includes("Element"));
  assert.ok(out.includes("ID"), "trailing acronym");
});

test("identifier expansion drops single letters rather than flooding the index", () => {
  // `a` and `b` in `aBc` carry no search value and would match everywhere.
  assert.equal(expandIdentifiers("aBc").split(" ").includes("a"), false);
});
