# Tools

What each command answers, what it accepts, what it must return, and which
indexed data backs it. Companion to `INDEXING.md`, which describes how that data
gets there.

**The contract is the operation, not the command.** Everything lives in
`src/api/operations.ts`; the CLI in `src/cli/commands.ts` renders and computes
nothing, and the MCP server will serialise the same objects. Where a front end
decided something for itself, the two drifted — `benchOp` returned 200 recipes
with no total while the CLI printed 911, and `statsOp` returned a locale *count*
while the CLI had already switched to naming them.

---

## The shape every answer has

```ts
Result<T> = { value: T, caveats: readonly Caveat[] }
Caveat    = { code: CaveatCode, message: string }
```

**Caveats are data, not prose** (`src/api/types.ts`). This is the central design
decision and it is not stylistic: nearly every defect found while testing this
tool against uninformed agents was a *statement*, not a computation. `unused`
meant "extraction never looked", not "the game does not use it". A schema-search
miss was reported as proof when it was evidence. So the sentence travels with the
data, and a front end may restyle a caveat by `code` but may not invent one.

The eleven codes:

| Code | Means |
|---|---|
| `truncated` | more results exist; carries shown and, where knowable, the total |
| `relaxed` | the query had to be loosened; hits may be unrelated |
| `lexical-only` | a miss here is evidence, not proof — the index is lexical |
| `untyped-blind-spot` | 20 202 untyped world/prefab assets contribute no references |
| `pre-inheritance` | counts cover files that declare the field themselves; `get` resolves the chain first |
| `container-no-observations` | only scalar leaves are counted, so absence says nothing for this shape |
| `cardinality-elided` | values exist but exceed the 40-distinct storage ceiling |
| `ambiguous-identifier` | several assets share this identifier |
| `join-incomplete` | the declared/observed join is partial, so absence is weak evidence |
| `names-not-values` | this index stores identifiers and names, not field values |
| `identifier-only` | rows came from a literal identifier lookup, not the search index |

Exit codes: `0` answered, `1` no answer (a miss), `2` misuse or unimplemented.

---

## `status` — what is installed and what is indexed

**In:** nothing. **Out:** install paths, patchline, tier, and index counts.

Backed by `meta`, plus counts over `assets`, `schema_fields`, `edges`,
`lang_keys`, `field_stats`.

Must state **which** locales, never how many — "5 locales" led a reader to infer
the list and conclude Ukrainian was absent — and must attribute them to the
archive, not to the game. Tier means *which sources are available*
(1 = `Assets.zip`, 2 = + the schema generator, 3 = + a project), spelled out
because a bare `Tier: 1 + 2` reads as partial coverage.

Field counts exclude the 996 empty-pointer type rows, so this agrees with
`undocumented`.

---

## `types` — the type list

**In:** `--limit` (200). **Out:** per type — id, asset count, declared-field
count, archive path.

Backed by `asset_types` (102 rows) joined to `assets` and `schema_fields`
(`assetTypesOp`).

`FIELDS 0` is a real answer, not a gap: `Interaction` and `NPCRole` both have
assets and no declared fields. Asset counts must sum to `status`'s typed figure
(14 872).

---

## `search <query>` — find an asset by name

**In:** query, `--type`, `--limit` (20). **Out:** `SearchHit[]` —
`{ logicalId, type, locale, displayName, relaxation }`.

Backed by `assets_fts`, with a fallback to a literal `assets` lookup.

Searches **identifiers and localized names, not field values** — a miss must say
so (`names-not-values`), because a sound-set id returned the set itself and none
of the items referencing it, and the reader inferred the limitation from repeated
empty results instead of being told.

Rules the answer must honour:

- `locale` is where **this query** matched, not the asset's only language, and
  `relaxation > 0` marks a loosened match. Both were printed as bare markers with
  no legend; a reader concluded an item was translated only into Portuguese.
- `--type` must be validated. A bogus type answers "no such type", never "no
  asset is named X" — a scoped miss must not read as a claim about the corpus.
- 497 identifiers have no `assets_fts` row (`.node.json` files that do not parse).
  The fallback finds them and reports `identifier-only`.

---

## `get <id>` — the effective definition

**In:** id, `--type`, `--raw`. **Out:** `ResolvedAsset` —
`{ logicalId, type, path, parentChain, effective, origins, missingParent, truncated }`.

Backed by `assets` for resolution and the archive for the document;
`schema_fields.inherits_property` / `merges_properties` drive the merge.

Returns the asset **as the engine sees it**, with the parent chain folded in. The
merge rule is per type, from the schema's own markers: a value whose type
declares `mergesProperties` combines field by field, otherwise the child replaces.
Getting this wrong made every plant in the game read as having no farmland
restriction and nothing to make it grow.

`--raw` prints the JSON on stdout and nothing else; notes go to stderr, so the
output stays machine-readable.

An identifier is **not unique**: 442 of them name more than eight assets. The
ambiguity note must carry the true count (461 for `Entry.node`), never the size
of the sample it prints.

---

## `describe <Type> [--field <pointer>]` — the schema of a type

**In:** type, `--field`, `--limit` (60). **Out:** `DescribeResult` —
`{ union, fields, total, field, repairedFrom }`, each field carrying two layers:

- **declared** — `type`, `optional`, `defaultValue`, `typeConstant`, `enumValues`,
  `title`, `description`, `referenceTarget`, from `schema_fields`
- **observed** — `count`, `assets`, `cardinality`, `values`, `targetTypes`, from
  `field_stats`

The two layers must stay labelled apart: a declared `enum` is the complete legal
set (`legal:`), an inferred one is only what vanilla happens to use (`seen:`).
On a union branch's discriminator the legal set is **one constant**, and printing
the union's full menu there sends the reader into a different schema shape.

Also required of the answer:

- a pure union returns its branches and discriminator, not 213 undeclared rows
- a container reports `container-no-observations` — only scalar leaves are
  counted, so absence proves nothing
- above 40 distinct values only the count is stored (`cardinality-elided`)
- a value link is named where one exists — the only legal-value set JSON Schema
  cannot express (see below)
- a declared reference whose value resolves to nothing is flagged `BROKEN`:
  2 674 occurrences ship in vanilla, including `BlockType./HitboxType`'s own
  default `"Full"`
- a type with assets but no declared fields says exactly that, rather than "no
  such type" — `NPCRole` has 975 assets and zero fields

---

## `refs <id>` — what points at this

**In:** id, `--type`, `--limit` (40). **Out:** `Reference[]` —
`{ logicalId, type, kind, pointer, confidence }` plus a total.

Backed by `edges`, and by `candidates` for the two fallbacks.

One command, three questions, chosen by what the string turns out to be:

1. **an asset** → inbound edges, `INHERITS_FROM` / `REFERENCES` / `LOCALIZED_BY`
2. **a plain value** → where it appears as a field value, with the assets
   named (`valueUsage`, `src/cli/commands.ts:887`)
3. **a file** → the assets referencing it, from the 33 782 `REFERENCES_FILE`
   edges (`fileRefsOp`, `src/cli/commands.ts:927`)

The order is value before file, not the other way round: a string that is both
a stored field value and a filename resolves as a value, and only a name
matching no value at all reaches the file lookup.

Confidence is a claim about evidence and must match its legend: `high` is
schema-declared or engine-resolved inheritance, `medium` is declared but
uncheckable or a name convention, `low` is a bare identifier collision.

Numbers must measure what their label says. The total counts the same projection
the rows do; a file count separates assets from occurrences (38 assets, 148
pointers); a value report separates occurrences from assets and states how many
occurrences could not be attributed to a declared field — 45 319 candidates never
align, so a breakdown can be empty under a non-zero total.

`--type` narrows honestly: it names how many of the shown references are shared
with a same-named asset of another type, because a field that declares no target
cannot choose between four assets called Stone.

---

## `search-schema <words>` — where a capability is declared

**In:** words, `--limit` (20). **Out:** matching fields with type, pointer, title
and description.

Backed by `schema_fts` over field names, titles, descriptions and enum values.

The index is **lexical**, so every answer carries `lexical-only`: a miss is
evidence, not proof, and a capability spelled in other words will not match. When
the query had to be loosened, `relaxed` says by how much. Both matter because
this is the command a reader uses to firm up a negative.

---

## `search-lang <query>` — localization

**In:** query, `--limit` (20). **Out:** `LangEntry[]` —
`{ key, reference, translations, usedBy, usedByTotal }`.

Backed by `lang_keys` (50 645 rows, 5 locales) and `LOCALIZED_BY` edges.

Must return **both** spellings: the stored `key` and the `reference` an asset has
to contain. They differ by the `.lang` file's own stem — `items.X.name` is
written `server.items.X.name` — and printing only the stored form sent modders to
paste a key the game cannot resolve. Any root is accepted on input, so
`wordlists.runes.algas` resolves as readily as the `server.` form.

A miss is hedged like every sibling command: it covers the locales this index
holds, and matching is literal.

---

## `bench [id]` — crafting stations

**In:** optional bench id, `--limit` (200). **Out:** without an id, every bench —
`{ id, bench_type, declared_by, cats, reqs }`; with one, its categories and what
it crafts (`{ logicalId, category }`).

Backed by the five bench tables (`INDEXING.md` stage 5).

Two different identifiers exist and confusing them fails silently at runtime: the
**bench id** is what a recipe's `BenchRequirement.Id` must carry, the **asset id**
is what declares it. The answer must name which is which, and point at the right
one when the wrong one is passed.

Report, do not interpret. 6 of the 21 bench ids are referenced and declared by no asset —
including the literal `TODO` and one `BenchCategory` id typo'd into an `Id` slot.
The honest answer is "no bench declares this id", not a story about hand crafting.
`CAT` counts categories the bench **asset** declares; the groups under
`bench <id>` are what the **recipes** name, and the two legitimately differ.

---

## `undocumented [Type]` — fields vanilla never uses

**In:** optional type, `--limit` (40). **Out:** declared fields with no observed
row, plus the declared count.

Backed by `schema_fields` left-joined against `field_stats`.

This is a negative, so it must be qualified: only 2 457 of 17 400 declared fields
are matched by the observed layer, and that **declared-side** ratio is the one to
quote — the observed-side 85 % is the flattering number and does not describe the
risk. The total is stated ("first 40 of 7 405"), because "more exist" is barely
louder than silence.

Container fields are structurally absent from this list; a reader must not take
that as "vanilla uses it".

---

## Value links — the join JSON Schema cannot express

Not a command of its own; surfaced inside `describe`. A **value link** is a
string whose legal values are declared elsewhere in the corpus, so neither `enum`
nor a reference target can carry them.

**Out:** `{ link, role, declared, declaredBy, declaredByTotal, unresolved }`.

Three links, 5 287 rows: `bench`, `item-subcategory`, `gather-type`. The answer
must include `unresolved` — `Pickaxe_Tier0`, `SoftWoods` and `Unbreakable` are
required by blocks and declared by no tool, which is a fact about the game the
tool could not otherwise state.

---

## `eval` — search quality, measured

**In:** `--set` (default `docs/evaluation/search-phrases.json`). **Out:**
recall@5 per tier, plus the failing phrases.

Runs a fixed phrase set through `search` and reports how often the expected
asset lands in the top five, bucketed by what the phrase exercises —
`lexical-id`, `cross-locale`, `inflection`, `semantic`, `noise-rejection` and
others. It is a development instrument, not an answer about the game, and the
one place the tool measures itself: `semantic 0/5` is why a miss from
`search-schema` is reported as evidence rather than proof.

It reads its phrase set from disk rather than the index, so it fails with an
unhelpful `ENOENT` when run outside the repository.

---

## `index`, `generate-schema`

`index` builds the corpus (`INDEXING.md`); `--force` rebuilds.
`generate-schema` runs the game's own generator, which **emits telemetry that
cannot be disabled** — `--disable-sentry` turns off crash reporting, which is a
different thing. Consent is required before anything runs, `--dry-run` prints the
command, and a non-interactive run without `--yes` must refuse.

---

## Not implemented — exit 2 rather than pretend

| | Intended answer | Data already present |
|---|---|---|
| `validate` | does this pack resolve | 2 674 broken declared references (`candidates.dangling = 2`), 119 723 dangling strings, 90 unresolved value-link references (9 distinct values) |
| `clean` | drop the index | — |
| `--mcp` | serve over stdio | the whole `src/api` surface |

Each must give **its own** remediation. `validate` once printed `clean`'s advice —
telling someone asking "is my pack valid" how to delete a cache — and all five
blind trials hit it.

---

## Known gaps

- **No outbound view.** `refs` answers "what points at X"; nothing answers "what
  does X point at, and does it resolve", which is where the broken references
  belong.
- **Values above 40 distinct are not stored**, so `--limit` cannot reveal them;
  `refs <value>` is the only route and it needs a value to start from.
- **`Q22`** — 1 116 `anyOf` fields carry a `ref_scope` and no `reference_target`,
  so some declared references are graded as name collisions.

Recorded with measurements in `docs/init/OPEN-QUESTIONS.md`.
