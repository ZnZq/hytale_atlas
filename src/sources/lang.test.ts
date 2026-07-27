import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LangCatalog,
  isTranslationReference,
  localeFromPath,
  parseFallbacks,
  parseLang,
  referenceToKey,
} from "./lang.ts";

test("parses plain entries and ignores comments and blanks", () => {
  const m = parseLang(
    ["# === items ===", "", "items.Food_Bread.name = Bread", "# trailing note"].join("\n"),
  );
  assert.equal(m.size, 1);
  assert.equal(m.get("items.Food_Bread.name"), "Bread");
});

test("values keep everything after the first '=', including further '='", () => {
  const m = parseLang("ui.formula = a = b + c");
  assert.equal(m.get("ui.formula"), "a = b + c");
});

// 147 lines in en-US/server.lang continue, in runs of up to 11. A line-at-a-time
// parser drops the bodies silently, because they contain no '='.
test("backslash continuations are joined into one logical entry", () => {
  const m = parseLang(
    [
      "builderTools.pastedBlocks = Pasted {count, plural,\\",
      "    one {1 block}\\",
      "    other {{count, number} blocks}}",
      "builderTools.next = After",
    ].join("\n"),
  );
  assert.equal(m.size, 2, "continuation bodies must not become their own entries");
  assert.ok(m.get("builderTools.pastedBlocks")!.startsWith("Pasted {count, plural,"));
  assert.ok(m.get("builderTools.pastedBlocks")!.includes("other {{count, number} blocks}}"));
  assert.equal(m.get("builderTools.next"), "After");
});

test("a file ending mid-continuation still yields its last entry", () => {
  const m = parseLang("a.b = one\\\n  two\\");
  assert.equal(m.get("a.b"), "one  two");
});

test("ICU braces in a single-line value are left alone", () => {
  const m = parseLang("assetEditor.messages.unknownItem = Unknown Item \"{id}\"");
  assert.equal(m.get("assetEditor.messages.unknownItem"), 'Unknown Item "{id}"');
});

test("a repeated key takes the last definition", () => {
  const m = parseLang("k = first\nk = second");
  assert.equal(m.get("k"), "second");
});

// The trap that made a first scan conclude item localization did not exist:
// references carry a root prefix that the stored key does not.
test("a reference is stripped to the stored key", () => {
  assert.equal(referenceToKey("server.items.Sword_Iron.name"), "items.Sword_Iron.name");
  assert.equal(referenceToKey("common.avatar.capes.name"), "avatar.capes.name");
  assert.equal(referenceToKey("items.Sword_Iron.name"), "items.Sword_Iron.name");
  assert.equal(referenceToKey("nodots"), "nodots");
});

test("translation references are recognised by shape, not by field name", () => {
  assert.ok(isTranslationReference("server.items.Sword_Iron.name"));
  assert.ok(isTranslationReference("server.npcRoles.Spider_Cave.name"));
  assert.ok(!isTranslationReference("Sword_Iron"));
  assert.ok(!isTranslationReference("Icons/ItemsGenerated/Sword_Iron.png"));
  assert.ok(!isTranslationReference("server.items"), "needs at least three segments");
});

test("locale is derived from a lang file path", () => {
  assert.equal(localeFromPath("Server/Languages/en-US/server.lang"), "en-US");
  assert.equal(localeFromPath("Common/Languages/uk-UA/avatarCustomization/capes.lang"), "uk-UA");
  assert.equal(localeFromPath("Server/Languages/fallback.lang"), null);
});

test("fallback.lang parses as ordinary key/value", () => {
  const f = parseFallbacks("en-GB = en-US\nru-UA = ru-RU\n");
  assert.equal(f.get("en-GB"), "en-US");
  assert.equal(f.get("ru-UA"), "ru-RU");
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function catalog() {
  const c = new LangCatalog({
    fallbacks: new Map([
      ["en-GB", "en-US"],
      ["ru-UA", "ru-RU"],
      ["de-AT", "de-DE"], // target locale is not shipped
    ]),
  });
  c.add("en-US", parseLang("items.Bench_Armory.name = Forge"));
  c.add("uk-UA", parseLang("items.Bench_Armory.name = Ковальня"));
  c.add("ru-RU", parseLang("items.Bench_Armory.name = Кузница"));
  c.add("zh-CN", parseLang("items.Bench_Armory.name = 锻炉"));
  return c;
}

test("resolve returns the value and the locale it came from", () => {
  const c = catalog();
  assert.deepEqual(c.resolve("server.items.Bench_Armory.name", "uk-UA"), {
    value: "Ковальня",
    locale: "uk-UA",
  });
});

test("a regional variant resolves through fallback.lang", () => {
  const c = catalog();
  assert.deepEqual(c.resolve("server.items.Bench_Armory.name", "en-GB"), {
    value: "Forge",
    locale: "en-US",
  });
  assert.deepEqual(c.resolve("server.items.Bench_Armory.name", "ru-UA"), {
    value: "Кузница",
    locale: "ru-RU",
  });
});

test("a fallback target that does not ship falls through to the default locale", () => {
  const c = catalog();
  // de-AT -> de-DE, which the corpus does not contain; en-US is the last resort.
  assert.deepEqual(c.resolve("server.items.Bench_Armory.name", "de-AT"), {
    value: "Forge",
    locale: "en-US",
  });
});

test("an unknown key resolves to undefined rather than throwing", () => {
  const c = catalog();
  assert.equal(c.resolve("server.items.Nope.name", "uk-UA"), undefined);
});

test("a cyclic fallback chain terminates", () => {
  const c = new LangCatalog({ fallbacks: new Map([["a", "b"], ["b", "a"]]) });
  c.add("en-US", parseLang("k = v"));
  assert.deepEqual(c.resolve("server.k", "a"), { value: "v", locale: "en-US" });
});

test("resolveAll returns every locale that has the key", () => {
  const c = catalog();
  const all = c.resolveAll("server.items.Bench_Armory.name");
  assert.equal(all.length, 4);
  assert.deepEqual(
    all.map((a) => a.locale).sort(),
    ["en-US", "ru-RU", "uk-UA", "zh-CN"],
  );
});
