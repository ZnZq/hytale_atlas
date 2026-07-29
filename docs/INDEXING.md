# Indexing

What the indexer reads, what it writes, and what it deliberately skips.

Figures are measured against the vanilla `release` archive (60 148 entries) on
2026-07-28 at `SCHEMA_VERSION = 16`. Re-measure after a patchline change; the
numbers are here to be checked, not trusted.

Entry point: `cmdIndex` in `src/cli/commands.ts:264`. One command, six stages,
one SQLite file under `%LocalAppData%\hytale-atlas\cache\frozen\v16\<key>\`.
The key is `frozenKey(archivePath, archiveStamp)` — content-addressed, so a new
game build indexes into a new file and the old one stays valid.

---

## Sources

| Source | Read by | Required |
|---|---|---|
| `Assets.zip` | `AssetArchive` (`src/sources/archive.ts`) | yes |
| Generated JSON Schema, `local/schema-release/Schema/*.json` | `readGeneratedSchemas` (`src/sources/schema-doc.ts:683`) | no — without it every asset is untyped (tier 1) |

The schema is produced by the game's own generator, which **emits telemetry that
cannot be disabled**; `generate-schema` requires consent before running. Nothing
else in the pipeline launches the game.

---

## Stage 0 — Schema ingest

`ingestSchemas` (`src/indexer/schema.ts:145`), run **first**, because it supplies
the path → type map. An asset indexed without a type cannot later be told apart
from a worldgen prefab.

Each `Schema/*.json` is flattened once into a namespace; `common.json`'s 895
shared definitions become `common:<Name>` scopes. A `$ref` is **recorded as a
crossing (`ref_scope`), never inlined** — inlining multiplied `common.json` at
every referring site and produced 138 961 fields with a *worse* declared/observed
join.

Written to `schema_fields`, one row per (type, JSON pointer):

- `declared_type`, `optional`, `default_value`, `enum_values`, `title`,
  `description`
- `reference_target` — from `hytaleAssetRef`, a **sibling** of the `hytale`
  block, not a member of it, and read on the property node **and inside its
  `anyOf` branches**: an optional reference is spelled
  `anyOf: [{$ref, hytaleAssetRef}, {null}]`, so 363 of the 802 markers sit on a
  branch. Reading only the property node found 545 and graded the other 363 as
  name collisions (`assetRefOf`, `src/sources/schema-doc.ts`)
- `ref_scope` — the type a `$ref` crosses into; space-joined when the crossing is
  a union
- `discriminator_property` / `discriminator_values` — from
  `hytaleSchemaTypeField`, positionally aligned with the `anyOf` branches
- `inherits_property` — `hytale.inheritsProperty`, read on the property node
  **and inside its `anyOf` branches** (`inheritsFlag`, `src/sources/schema-doc.ts`)
- `merges_properties` — `hytale.mergesProperties`, a **type-level** marker, stored
  on the row whose `json_pointer` is `''`

The empty pointer is the **type row**, not a field: 996 of them. Every count of
"fields" excludes it (`declaredCount`, `src/api/operations.ts`).

Also written: `asset_types` (102 rows: id, schema path, file extension) and
`schema_fts` for prose search.

**Skipped:** editor scratch keys (`$Title`, `$NodeId`, `$Position`, …);
traversal stops at `MAX_POINTER_DEPTH = 8` nodes (`src/sources/schema-doc.ts:126`),
which is a guard on *node* depth, since `$ref`/`anyOf` hops consume depth without
adding a pointer segment.

Result: **17 400 fields + 996 type rows across 102 types.**

---

## Stage 1 — Corpus walk

`buildSearchIndex` (`src/indexer/corpus.ts:179`). One pass over the archive.

**Assets.** An entry is an asset when its suffix is one the schema declares
(`assetSuffixes`, `src/indexer/schema.ts:122`) *and* it sits under a configured
root — `["Server/"]` by default (`corpus.ts:185`). `Common/` and `Cosmetics/`
are therefore **not** indexed as assets.

The type comes from the path, via `TypeResolver` (`src/indexer/schema.ts:31`),
longest-prefix-first. A file in the wrong directory is typed wrongly and nothing
detects it — that is how two deprecated food files typed as `EntityEffect`
surfaced `/Match` and `/Next` as `EntityEffect` capabilities.

**Files.** An entry becomes a `files` row when its suffix is neither `.lang`
nor one of the asset suffixes (`corpus.ts:222-227`), with a coarse `kind`
(`fileKind`, `corpus.ts:87`): 24 923 rows, 24 804 of them under `Common/`.

Note the rule is about the **suffix**, not about being an asset, and the two
tests do not tile: a `.json` outside the asset roots is neither. 29 files under
`Cosmetics/` and `manifest.json` fall through both and appear in no table.

**Candidates.** `collectCandidates` (`src/indexer/references.ts:91`) walks each
parsed document and records every scalar leaf:

- strings, trimmed, `1..96` characters (`MAX_CANDIDATE_LENGTH`) — raised to 192
  for a value shaped like a path (a slash, a dot, no spaces), because the ceiling
  is a rule about *identifiers* and a file path is not one: 959 of the 1 144
  over-long strings named a path already sitting in `files`, and every one was a
  file edge that was never made
- numbers and booleans, with `value_kind` — collecting strings only had left
  1 963 numeric and boolean fields absent from the observed layer *by
  construction*, so 16 770 of 17 400 fields read as "unused"
- non-finite numbers are dropped: they are the repaired sentinel meaning *unset*
- keys beginning with `$` are skipped on this side too, or they produce
  observed-only rows that can never join

Each candidate stores both `json_pointer` (with real indices) and
`schema_pointer` (indices and map keys collapsed to `*`, `toSchemaPointer`,
`references.ts:36`).

**Skipped for candidates:** `Server/Prefabs/` and `Server/World/`
(`DEFAULT_CANDIDATE_EXCLUSIONS`, `corpus.ts:69`). These 20 202 assets stay
indexed and searchable but **contribute no edges** — voxel data whose strings are
coordinates and palette indices. `refs` states this in every answer.

**Localization.** A string is a translation reference when it carries a known
root (`server.`/`common.`) **or** the catalog holds a key by that name and it has
at least two dots — the same question `LOCALIZED_BY` asks in SQL. Demanding the
root here while the SQL join stripped it left the nine `npcRoles.Test_Motion_*`
roles with a localization edge and an identifier-only search row: the index knew
their names and search could not find them by one.

`.lang` files are parsed by `parseLang` (`src/sources/lang.ts:71`)
and stored in `lang_keys` with a `root` column — the file's own stem, which is
the prefix an asset must write (`server.items.X.name` for a key stored as
`items.X.name`). Without it the tool printed keys that do not resolve.

**Search rows.** `assets_fts` gets one row per locale in which the asset's
translation references actually resolve, and the identifier is folded into the
searchable name (`corpus.ts:311-320`). An asset that declares no translation
reference at all gets one identifier-only row instead.

**A document that fails to `JSON.parse` gets neither** — the loop `continue`s
before both the candidate walk and the FTS write (`corpus.ts:262-265`). That is
the whole of the 497 identifiers absent from `assets_fts`: 478 are `.node.json`
worldgen files, which hold several bare documents concatenated and are not
valid JSON. Sampled 40 of the 497 — all 40 fail to parse. They exist in
`assets` and nowhere else, which is why `searchAssetsOp` falls back to a
literal `assets` lookup and says so.

The in-code comment calling these "still indexed by id, just not localized" is
true of the first half and misleading about the second: they are not
searchable, and they contribute no edges.

Result: **35 074 assets (14 872 typed), 24 923 files, 480 074 candidates,
45 449 FTS rows, 50 645 lang keys.**

---

## Stage 2 — Edge resolution

`resolveCandidates` (`src/indexer/references.ts:185`). Deletes and rebuilds every
edge, then fills `edges` with one indexed join per kind. No second walk over the
archive.

| Kind | Rule | Confidence |
|---|---|---|
| `INHERITS_FROM` | `json_pointer = '/Parent'`, target of the **same known type** (`=`, not `IS`: `IS` made two untyped assets "the same type") | `high` |
| `LOCALIZED_BY` | value has ≥ 2 dots and, after stripping a `server.`/`common.` root, matches a key — joined **against `en-US` only**, so one edge per key rather than per locale | `high` |
| `REFERENCES_FILE` | `'Common/' \|\| value` matches a `files.path` — resolved **only against the `Common/` root** | `high` |
| `REFERENCES` (declared) | the field declares `reference_target` and the target is of that type | `high` |
| `REFERENCES` (convention) | pointer matches `GLOB '*Id'`, `'*/Set'`, `'*/Model'`, `'*/BlockType'`, `'*/BlockTypes/*'`, `'*/BlockSets/*'` | `medium` |
| `REFERENCES` (collision) | value merely matches an identifier | `low` |

`GLOB`, not `LIKE`: SQLite's `LIKE` folds ASCII case, so `'%Id'` also matched
`/Solid`, `/Fluid`, `/TransformFluid`, `/SpreadFluid` and promoted 5 292 edges to
`medium` under a legend claiming a naming convention.

The same-type constraint on inheritance matters: matching on identifier alone
pointed 845 of 4 575 inheritance edges at the wrong type, all labelled `high`.

The `Common/` prefix on the file rule is load-bearing and undocumented in the
code: all 34 739 file edges point into `Common/`, and **zero** reach the 109
files under `Server/` or the 9 under `Cosmetics/`. 4 819 files have no inbound
edge at all. A stored value is a `Common/`-relative path, which is why `refs`
matches on the basename as well.

**Skipped:** `NOISE_VALUES` — `""`, `none`, `default`, `null`, `true`, `false`,
`any`, `all` (`references.ts:54`) — filtered at **edge time, not extraction
time**. Filtering earlier destroyed real values: `Default` is every crop's
starting stage set and `All` is a real bench category. Every site builds its
exclusion list from that one set through `notNoise(column)`; the two dangling
passes each carried a hand-written copy that agreed only by inspection.

`candidates.dangling` is also set here: `1` for an identifier-shaped string
matching nothing (80 340). **Matching nothing means producing no edge**, not
"naming no asset and no lang key": testing only those two tables marked all
33 782 resolved file references dangling, plus every localization reference
spelled with its `server.` root, since the `LOCALIZED_BY` join strips that prefix
and the dangling test did not. 39 320 of the 119 723 rows once reported here had
a visible edge saying what they matched.

Result: **163 011 edges** — 118 993 `REFERENCES`, 34 739 `REFERENCES_FILE`,
5 546 `LOCALIZED_BY`, 3 733 `INHERITS_FROM`.

---

## Stage 3 — Field statistics and alignment

`computeFieldStats` (`src/indexer/stats.ts:420`). The pass that makes `describe`
possible, and the only one whose job is a *join*.

Aggregates candidates into `field_stats`, grouped by the **aligned**
`(schema_scope, schema_pointer)` and skipping every candidate whose scope is
still `NULL` (`stats.ts:438-451`). That exclusion is large and worth stating:
45 319 of 480 074 candidates never align, 44 938 of them `NPCRole` — a type
with 975 assets and no declared fields. Nothing about them reaches `describe`.

Columns: `count` (occurrences), `of_total` (distinct assets), `cardinality`
(distinct values), `target_types` (filled from the edges pass 2 built) and
`value_types` — the JSON types seen at the pointer, `string` / `number` /
`boolean`. On the release corpus every field is single-typed (1 499 string,
1 016 number, 360 boolean); the column earns its place on the 418 fields the
schema does not describe, where it is the only statement of what they hold.

`target_types` is keyed on `candidates.schema_scope` — the scope **this pass**
assigns — not on the source asset's own type. The two agree only for a field
declared at the top level of its type, so joining on `assets.type` left the
column empty by construction for 159 of the 224 fields that declare a
`reference_target`, the most used ones among them (`BlockType./HitboxType`,
`common:ItemDrop./ItemId`). Same trap as the two rules below.

**Alignment** is the hard part: a corpus pointer such as
`Item + /BlockType/Gathering/Breaking/GatherType` must be rebased onto
`BlockType + /Gathering/Breaking/GatherType`, because `$ref` was recorded as a
crossing rather than inlined. `align` (`stats.ts:275`) walks the pointer, and at
each crossing:

- a single-target `$ref` rebases directly
- a **polymorphic union** cannot be rebased from the pointer alone — the branch
  is chosen by the discriminator the schema declares and the data carries
  (`selectBranch`, `stats.ts:84`)
- a **root-level union** (`Interaction` is 102 branches with no fields of its
  own) gets a hop before matching
- 152 of 1 341 `Interaction` assets declare only `/Parent`; their discriminator
  is inherited, followed up to 8 hops (`discriminatorFor`, `stats.ts:262`)

Then, still in this pass:

- **observed values, in two stores with different rules** (`stats.ts:484-522`).
  `field_stats.observed_values` takes any field with `1..40` distinct values —
  no occurrence minimum — which is what lets `describe` say anything about an
  UNDECLARED field. `schema_fields.observed_values` is the inferred enum for a
  DECLARED field and is stricter: `1..40` distinct **and** `≥ 8` occurrences
  **and** the schema declares no `enum` of its own. Both are rendered `seen:`
  and never `legal:`. Above 40 distinct, only the count is kept.
- **promotions** — `medium → high` when the declared target type matches the
  destination; `low → medium` when the field declares any target
- **nested `/Parent` → `INHERITS_FROM/high`** — an inline object can declare a
  parent too, and only the top-level one was recognised
- **broken declared references** — `dangling = 2`, 2 773 occurrences: the field
  declares a target type and the value names no asset of it. `Item./Categories/*`
  names 38 ids that do not exist, 2 175 times; `BlockType./HitboxType`'s own
  **default**, `"Full"`, names no `BlockBoundingBoxes`, 256 times. 2 548 of the
  2 773 name no asset at all; the other 225 name one of the wrong type.

Both of the last two must run **here, not in stage 2** — they join on
`schema_scope`, which this pass assigns. Placed in stage 2 they match nothing, in
silence.

Value lists (`enum_values`, `observed_values`, `target_types`) are joined with
`VALUE_SEP` — U+001F, the ASCII unit separator (`src/db/values.ts`) — never a
space. Values contain spaces, and a space separator rendered two sentences as
25 comma-separated tokens that read like an enum of legal values.

Result: **2 875 observed fields, 2 457 of them joined to a declared field (85 %).**
Measured against the *declared* side the coverage is 2 457 of 17 400 (13 %) —
which is the honest denominator when the question is "does vanilla use this
field", and the one `undocumented` quotes.

---

## Stage 4 — Value links

`indexValueLinks` (`src/indexer/value-links.ts:130`). A **value link** is a string
whose legal values are declared elsewhere in the corpus. JSON Schema has no
vocabulary for this, so neither `enum` nor a reference target can express it.

Three are declared (`VALUE_LINKS`, `value-links.ts:59`), each stating only
pointers — no domain vocabulary:

| Link | Declared at | Referenced at |
|---|---|---|
| `bench` | `BlockType./Bench` union → `/Id` | `common:BenchRequirement./Id` |
| `item-subcategory` | `common:SubCategoryDefinition./Id` | `Item./SubCategory` |
| `gather-type` | `ItemToolSpec./GatherType` | `common:BlockBreakingDropType./GatherType` |

`resolved = 0` marks a referenced value nothing declares — kept, not dropped:
`Pickaxe_Tier0`, `SoftWoods` and `Unbreakable` are required by blocks and
declared by no tool.

Result: **5 287 rows.**

---

## Stage 5 — Benches

`indexBenches` (`src/indexer/benches.ts:83`). Schema-driven: keys off
`schema_scope`/`schema_pointer` and resolves branches from the union's own
`ref_scope`, so no bench pointer is hardcoded.

Five tables — `benches`, `bench_declarations`, `bench_categories`,
`bench_requirements`, `bench_requirement_categories`. Declarations are a separate
table because one bench id can be declared by two assets: `Farmingbench` is
declared by both `Bench_Farming` and `Bench_Trough`, and holding the asset on
`benches` directly made `ON CONFLICT DO NOTHING` discard one of them silently.

Six referenced bench ids are declared by no asset — `TODO` among them, shipped by
vanilla. Reported as "no bench declares this id", not interpreted.

---

## What is not indexed

| | Why |
|---|---|
| `Common/`, `Cosmetics/` roots | outside the default asset roots |
| Candidates under `Server/Prefabs/`, `Server/World/` | voxel data; 20 202 assets stay searchable, contribute no edges |
| `.blockyanim`, `.blockymodel`, `.ui`, textures | recorded as `files` rows and reference targets; contents unparsed |
| `$`-prefixed keys | node-editor scratch, on both schema and corpus sides |
| Field values above 40 distinct | count only, so `--limit` cannot lift it |
| Strings over 96 characters, or over 192 when path-shaped | not candidates |
| `CommonAssetsIndex.hashes` | unused |

---

## Known gaps

- **`NPCRole`** — 975 assets, zero declared fields; all 44 938 of its candidates
  are unaligned. Commands say so rather than calling the type nonexistent.
- **No outbound view** — `refs` answers "what points at X"; nothing yet answers
  "what does X point at, and does it resolve", which is where the 2 773 broken
  references belong alongside `validate`.
- **`MAX_POINTER_DEPTH = 8`** — the schema walk stops there, so 62 observed
  pointers deeper than eight segments have no declared counterpart and appear
  in `describe` with an observed layer only. Raising it is not free: the comment
  on the constant records that at 20 the flatten did not finish in ten minutes.
- **A `dangling = 2` candidate may also carry a `REFERENCES` edge** — 169 do.
  The field declares type X, no X has that name, and a same-named asset of
  another type produced a heuristic edge. Both statements are true; `validate`
  needs to present them together rather than let them read as a contradiction.
- **1 309 values begin with `*`** — 37 of them flagged broken. Only 49 name an
  asset once the prefix is dropped, so the `*` is not a plain decoration.
  Reported as-is; the tool does not know what the game means by it.

Both are recorded with measurements in `docs/init/OPEN-QUESTIONS.md`. `Q22` is
closed: the marker was being read on the property node only, and 363 of 802
`hytaleAssetRef` declarations sit inside an `anyOf` branch.
