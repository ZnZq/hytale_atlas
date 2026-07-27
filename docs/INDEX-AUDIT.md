# Index audit — 2026-07-27

What the index currently holds, what today's probing broke and fixed, and what is
still extractable from `Assets.zip` and `HytaleServer.jar`.

All figures measured against the release patchline
(`Assets.zip` 3.43 GB / 60 148 entries, `HytaleServer.jar` 123 MB).

---

## 1. What we hold now

| | Count |
|---|---|
| Assets | 35 074 (15 113 typed, 4 576 localized) |
| Files (models, textures, audio, UI) | 24 923 |
| Asset types | 102, from the game's own generated schema |
| Schema fields | 14 628, of which 948 carry enums and 849 declare a reference target |
| Shared schema definitions | 1 296 (`common.json`, `other.json`) |
| Localization keys | 50 665 across 5 locales |
| Search rows | 45 449 (one per asset × locale) |
| Candidates | 239 538 (136 691 unresolved, 73 broken-declared) |
| Reference edges | 107 958 — 21 k high, 27 k medium, 59 k low |
| File edges | 33 782 |
| Inheritance edges | 4 575 |
| Localization edges | 5 546 |
| Build time / DB size | ~40 s / ~95 MB |

Commands: `index`, `generate-schema`, `search`, `get`, `eval`, `status`.

---

## 2. Defects found and fixed today

Every one was found by probing with a realistic question, not by reading code.

### 2.1 Non-JSON asset types were skipped entirely — **+2 370 assets**

The walk filtered on `.json`. The schema itself declares three types with other
suffixes, **all containing JSON regardless of the name**:

| Type | Suffix | Files |
|---|---|---|
| `ParticleSpawner` | `.particlespawner` | 1 744 |
| `ParticleSystem` | `.particlesystem` | 598 |
| `InstanceConfig` | `instance.bson` | 28 |

`ParticleSystem` is the declared target of 50 reference fields, so **every
reference to a particle effect resolved to nothing** and was reported as broken.

*Fix:* the walk takes its suffixes from the schema's own `hytale.extension`.

### 2.2 Type resolution ignored the suffix — one type ate another's files

`ParticleSystem` and `ParticleSpawner` share the directory `Server/Particles/` and
differ only by extension. Matching on longest path prefix gave one of them all
2 344 files and the other **zero**, which is what produced the false broken
references above.

*Fix:* `TypeResolver` matches prefix **and** suffix, ordering suffix-qualified
rules first.

### 2.3 The reference target marker existed and was missed — **21 146 high-confidence edges**

An earlier revision concluded the generated schema does not declare reference
targets, and that claim went into the design documents. It was wrong.
**`hytaleAssetRef`** marks 849 fields with the asset type they point at, across 70
targets (`RootInteraction` 323, `Interaction` 198, `SoundEvent` 90,
`ParticleSystem` 50, `Item` 14).

It was missed twice: first by looking at the wrong key (`hytale.type` is a
JSON-type marker; `uiEditorComponent` is mostly numeric widget configuration),
then by reading it from inside the `hytale` block when it is a **sibling** of that
block.

*Fix:* extracted into `schema_fields.reference_target`; used both for confidence
and for target disambiguation.

### 2.4 Name-only resolution created edges to the wrong asset — **15 439 removed**

`Wood` exists simultaneously as a `PhysicalMaterial`, a `BlockSoundSet` and a
`BlockParticleSet`. Matching on identifier alone produced an edge to each.

*Fix:* where a field declares its target type, only an asset **of that type** is
linked. Where the declared type has no such asset, nothing is invented — the
candidate is flagged `dangling = 2`, which is a stronger finding than an ordinary
unresolved string because the schema states what the field means. 73 remain, and
they are real: `BlockSpawnerTable /Entries/*/Name` accounts for 52 of them.

### 2.5 `edges.dst` pointed into three different tables with nothing to say which

`dst` is an asset id for `REFERENCES`/`INHERITS_FROM`, a file id for
`REFERENCES_FILE`, and a **lang key id** for `LOCALIZED_BY`. A query that joins
`assets` on `dst` without filtering `kind` silently matches lang-key row ids
against asset ids and returns confident nonsense — a diagnostic query did exactly
that, reporting a localization key as a high-confidence reference to a
`FlockAsset`.

*Fix:* an explicit `dst_kind` column (`asset` / `file` / `lang_key`).

### 2.6 Candidate explosion — **21.2 M → 239 k, DB 7.5 GB → 95 MB**

`Server/Prefabs/` produced 20.6 million candidates from 7 812 files (~2 600 strings
each): voxel data, one value per block placed (`Empty` 5.9 M, `Rock_Stone` 2.2 M).
Combined with 2 564 colliding `logical_id`s this yielded 60.8 million edges, 99.9 %
of them low-confidence, and a database **larger than the archive it indexes**.

*Fix:* prefab and worldgen roots stay searchable and typed but contribute no
candidates.

---

## 3. What the index can and cannot answer

Probed with questions a pack author would actually ask.

### Answers well

- **Impact** — "what breaks if I change `Rock_Stone`" → inbound edges with
  confidence tiers.
- **Completeness** — "what does `Tool_Pickaxe_Iron` need" → parent, quality,
  recipe inputs, plus the three files (icon, model, texture).
- **Effective definition** — `get` resolves the parent chain and reports which of
  the nine inherited fields came from where.
- **Unobtainable items** — items with neither recipe nor drop entry.
- **Broken declared references** — 73, with the exact JSON pointer.
- **Schema-only fields** — `Item/Armor` and its subtree exist in the schema and
  appear in no asset: the raw material for `find_undocumented`.
- **Search** — 5 locales, CJK infix, Slavic inflection; 54/59 on the evaluation
  set with every failure confined to the deliberately-unreachable `semantic` tier.
- **Where a capability lives** — `search-schema "tool tier"` →
  `common:CraftingBench/TierLevels`; `"recipe category"` → `Item/Recipe`,
  `ObjectiveAsset/Category`. All 17 400 fields are searchable by identifier or by
  the words a human would use for it.
- **What can be crafted where** — `bench Alchemybench` → 30 items under their
  localized categories.

### Cannot answer yet

| Question | Why |
|---|---|
| ~~"What can I craft at the alchemy bench?"~~ | **Answered** — `hytale-atlas bench Alchemybench` returns 30 items grouped under "Bombs", "Combat Potions", "Misc Potions", "Seeds". See §4b. |
| ~~"What values does `GatherType` accept?"~~ | **Answered** — corpus-inferred enums (pass 3) supply 238 fields the schema declares none for. `describe common:BlockBreakingDropType` lists the 14 observed values, labelled `seen:` rather than `legal:` because inference cannot claim exhaustiveness. Note the type: the field is reached through a `$ref` from `BlockType`, so `describe BlockType` does not show it. |
| ~~"How is field X normally used?"~~ | **Answered** — `describe_schema` has its observed layer: occurrences, distinct assets, cardinality, resolved target types. |
| "Which animation plays for X?" | 6 736 `.blockyanim` files are indexed as opaque files. No type declares them, and nothing parses them. |
| "What does this UI screen contain?" | 135 `.ui` files are a bespoke DSL (`@ColorDefault = #ffffff;`, `$Sounds = "Sounds.ui";`), not JSON. Unparsed. |
| "What does this *interaction* do?" | `RootInteraction./Interactions/*` is a union whose branches are inline objects rather than `$ref`s, so the reader does not see it and 1 689 observations sit unjoined. Blocks right-click behaviour questions — `OPEN-QUESTIONS.md` **Q20**. |
| Anything about worldgen | 20 202 assets remain untyped — `Server/World` and `Server/Prefabs` have no codec-backed type, in the JAR either. |

---

## 4. Still extractable, not yet used

### From `Assets.zip`

1. **`CommonAssetsIndex.hashes`** — 3 MB of `sha256 path` covering the whole
   `Common/` tree. Free per-file content hashes for ~25 k files: exact change
   detection with no reading, and a completeness cross-check. Currently ignored.
2. ~~**`assetTypes.*.title` in `server.lang`** — 48 human-readable type names.~~
   **Measured, and it is nearly empty.** 40 of the 48 values are the identifier
   mechanically de-camel-cased (`AttitudeGroup` → "Attitude Group"), which an agent
   derives for itself; only two add anything (`AmbienceFX` → "Ambience Effects",
   `FluidFX` → "Fluid Effects"). **56 of 102 types have no title at all**, and they
   are the ones that matter — `BlockType`, `CraftingRecipe`, `BiomeAsset`, `Fluid`,
   `ItemQuality`, `PhysicalMaterial`, `RootInteraction`. One key is malformed
   (`assetTypes.ReachLocationMarkerAsset`, no `.title`) and one names a type that
   does not exist (`TickProcedure`). There are zero `assetTypes.*.description`
   keys. The schema's own root `title` is worse: 101 of 102 are byte-identical to
   the type name.
   **Ingest it for the two names it adds if convenient, but it is not a semantic
   layer** — see `OPEN-QUESTIONS.md` **Q21**.
3. **Unused lang sections** — `npcRoles` (558), `benchCategories` (39),
   `itemSets` (41), `objectives` (44), `memories` (43), `interactionHints` (21).
   `benchCategories` in particular is what the crafting question above needs.
4. **`Cosmetics/` root** — 38 entries never walked. No declared type points there,
   so this is likely correct, but it is unverified rather than decided.
5. **`.blockymodel` / `.blockyanim` internals** — 9 561 files held as opaque. If
   models name their textures, parsing them adds real edges (`OPEN-QUESTIONS.md`
   Q12, still open).

Confirmed **not** an issue: every one of the 102 types' `fileMatch` globs points
under `Server/`, so restricting the asset walk to `Server/` loses nothing.

### From `HytaleServer.jar`

1. **`--generate-config-schema`** — the sibling flag we never ran. Server and
   plugin configuration schemas, same cost as the asset one.
2. **Bytecode enums** — the complete legal value set for fields like `GatherType`
   that carry no schema enum. This is the one place the corpus genuinely cannot
   substitute, and it is what `describe_schema` needs to answer "what else can I
   put here".
3. **`--validate-assets --shutdown-after-validate`** — authoritative validation
   (Q17). Still too expensive per invocation to be the default, but a natural
   `validate --deep`.
4. **`AssetReferences`** (Q19) — the engine's own reference graph. Lower priority
   now that `hytaleAssetRef` supplies declared targets statically.

---

## 4b. Implemented since this audit

**Pass 3 (`src/indexer/stats.ts`)** — aggregates candidates into
`field_stats(asset_type, pointer, count, of_total, cardinality, target_types)` and
infers enums for fields the schema declares none for (283 inferred; the schema
declares 948 out of ~87 000 fields).

**Three query tools (`src/query/schema.ts`)** —
`describe_schema` with both layers, `search_schema`, `find_undocumented`, wired as
`describe`, `search-schema`, `undocumented`. `search_schema` ORs its terms where
asset search ANDs them: a user asking "brush width shape area" is describing a
capability from several angles, and ANDing returned nothing for exactly that query.

**Schema flattening bounds rewritten.** The original `MAX_DEPTH = 8` counted schema
**nodes**, and `$ref`/`anyOf` traversal consumed depth without adding a pointer
segment — so `Item` stopped at `/BlockType/Gathering/Breaking` while the corpus
uses `/BlockType/Gathering/Breaking/GatherType`. Now bounded by pointer depth (8),
node depth (64), emitted fields (12 000/type) and **visited nodes (400 000/type)`.

The visit bound is the one that actually terminates: `seenPointers` suppresses
duplicate emissions, so a walk can visit millions of nodes without the emitted
count moving and a cap on output never fires. Raising pointer depth to 12 produced
138 961 fields, 8 truncated types, and a *worse* join — a warning that inlining is
the wrong model at scale.

### Declared/observed join: 7.8 % → **31.4 %**

The fix was the one this section predicted — stop inlining, resolve `$ref` at
query time — plus two things it did not anticipate.

**`$ref` became an edge, not an inlining.** Each namespace is flattened once and a
crossing is *recorded* as `ref_scope`. Corpus pointers then rebase across it:
`Item` + `/BlockType/Gathering/Breaking/GatherType` → `BlockType` +
`/Gathering/Breaking/GatherType`. The depth question disappears for everything
except genuine recursion.

**Polymorphic unions are resolved from the data.** A field whose `anyOf` offers
several `$ref` branches cannot be rebased from the pointer alone — the branch is
chosen by a sibling `Type` in the asset. Reading it settles **40 388 of 44 187
crossings (91.4 %)**, and the naming is mechanical: `Type: "Fixed"` selects the
branch named `FixedTradeSlot`.

Two rules that look right and are not:

- *Treat every `anyOf` as polymorphic.* `anyOf: [{$ref: X}, {type: "null"}]` is
  the ordinary **optional reference** idiom with one real branch. Refusing to
  rebase those took the join from 20.5 % **down to 8.5 %**. The signal that
  distinguishes them is a second, *different* `$ref` target for the same pointer.
- *Strip the branches' longest common suffix and match the remainder exactly.*
  The common suffix is a character-level accident, not a name boundary: `Single` /
  `Multiple` + `ItemDropContainer` share `leItemDropContainer`, leaving `Sing` and
  `Multip`. Longest-**prefix** matching, shortest name first, is correct in both
  directions.

Current state: **630 of 2 005 observed pointers** join a declared field, across
**247 types** (was 108). The remaining tail is characterised in
`OPEN-QUESTIONS.md` **Q20** — inline (non-`$ref`) union branches in
`RootInteraction`, a 56-branch union with no `Type` in `ScriptedBrushAsset`, and
543 rows of genuine recursion in `common:DensityTerrainAsset` that will never join
at a fixed depth.

### `search_schema` answered "this capability does not exist" about fields that do

Found while checking a claim in this document. `search-schema GatherType` returned
*"nothing in any asset type declares this capability"* — the strongest negative the
tool can give — while `describe common:BlockBreakingDropType` printed that very
field with its 14 observed values.

Two causes, both in how `schema_fts` was populated:

- **Only fields carrying prose were indexed** — 7 464 of 17 400. The comment said a
  pointer was "already searchable through `json_pointer`", but a field with no
  title or description had no row at all, so its pointer was not searchable
  either. Every field is indexed now.
- **Identifiers were never split.** The tokenizer breaks on `/`, so
  `/Gathering/Breaking/GatherType` gave `gathering`, `breaking`, `gathertype` —
  and "gather type", the words a human would use, matched nothing. A `terms`
  column now carries the expanded form (`expandIdentifiers()`), kept separate from
  `json_pointer` because that column is returned verbatim and joins back to
  `schema_fields`.

`search-schema GatherType` now returns both `ItemToolSpec/GatherType` and
`common:BlockBreakingDropType/GatherType` — the first of which is what the 3×3
pickaxe scenario actually needs, and was invisible before. Search over assets is
unchanged at 54/59.

**A negative result from a tool that indexes a subset of its own data is a false
negative dressed as a finding.** `find_undocumented` rests on the same
declared-minus-observed logic and deserves the same scrutiny.

### Benches and categories — implemented, then rewritten schema-driven

`BenchRequirement[].Id` names a **bench**, not an asset: `Builders`,
`Farmingbench`, `Salvagebench` are declared inside items under `BlockType.Bench`,
and nothing joined the two. Five tables now do (`src/indexer/benches.ts`, exposed
as `hytale-atlas bench [id]`).

**The first version hardcoded JSON pointers lifted from the corpus, and every one
of its defects came from guessing a shape instead of reading the declared one.**
All four were found by auditing it, and all four are verified:

| Defect | Measured |
|---|---|
| `ON CONFLICT (id) DO NOTHING` dropped a second declarer | 16 declarations, 15 ids — **`Bench_Trough` appeared nowhere in the index** |
| `bench_type` written NULL always | 0 of 15 populated, though `/Type` is a declared enum and 16 of 16 declarations carry a value |
| A nested `Categories` was invented; `BenchCategory` declares **`ItemCategories`** | `parent_id` null for all 67 rows, and the 12 real nested categories silently dropped — `Armory` showed 2 categories instead of 14 |
| `/Icon` had no handler | 41 values dropped |

The fix was not to patch the regexes but to key off **`schema_scope`/`schema_pointer`** —
the namespace-resolved form pass 3 produces, with polymorphic unions already routed
by their discriminator. Host paths stop mattering: all 1 957 requirements arrive
under one key, `common:BenchRequirement :: /Id`, whether they came from `Item` via
`/Recipe` (1 554) or from `CraftingRecipe` directly (403). Branch namespaces are
read from the schema's own union declaration, so a renamed or added bench kind
needs no code change.

Current: **15 ids from 16 declarations, 67 categories + 12 nested, 1 879 of 1 957
requirements resolved (96.0 %)**, `bench_type` populated for all 15.

- Keyed `(bench_id, category_id)`, never the category alone: `Decorative` is
  declared by both `Builders` and `Farmingbench`, `All` by both `Farmingbench` and
  `Loombench`, and those two collisions cover 100 of the 1 364 category matches
- Category names join `lang_keys` only after their `server.` root is stripped
  (38 of 53 carry it), which is what turns `Alchemy_Potions` into "Combat Potions"
- Undeclared bench ids are kept with `resolved = 0` and **reported by name** at
  index time: `Architects`, `Architectsbench`, `ArmorBench`, `Fieldcraft`,
  `Furniture_Misc`, `TODO`. Vanilla ships all of them, so these are `validate_pack`
  findings rather than parse failures.

### What belongs in the index, and what belongs in the prompt

Prompted by the question "should the atlas know what a bench *is*?". Two
measurements settle it.

**The game does not ship a usable concept vocabulary.** `assetTypes.*.title` —
flagged earlier in this document as a promising unused signal — is 48 lang keys of
which **40 are just the identifier de-camel-cased** (`AttitudeGroup` → "Attitude
Group"). **56 of 102 types have no title at all**, including the ones that would
matter most: `BlockType`, `CraftingRecipe`, `BiomeAsset`, `Fluid`, `ItemQuality`,
`PhysicalMaterial`, `RootInteraction`. There are zero `assetTypes.*.description`
keys, and only 17 of 102 schema files carry a root `description`, of which roughly
6 are informative. The schema's own root `title` is worthless: 101 of 102 are
byte-identical to the type name. **A semantic layer cannot be derived from the
game's own words.**

**A generic detector finds links but cannot decide them.** Value-set containment
over 1 553 qualifying pointers produced 49 candidate pairs at coverage ≥ 0.8, of
which roughly 6 are real — the rest are one 5-value `Attitude` enum reused
everywhere, `Type` discriminator vocabulary shared across unions, and recursive
structures matching themselves at two depths. It also **misses benches**: the
declarations split across four union branches (9 + 4 + 1 + 1 of 15 ids), so no
single site holds the domain, and even their union covers only 0.714 of referenced
values because vanilla ships broken ids. Good for *discovering* links to declare;
wrong as an index-time mechanism.

**The rule:**

> Materialize a **fact about the data** — a join, a value domain, where a string is
> declared. An agent cannot derive these without scanning 35 074 assets.
> Do not materialize a **fact about the world** — "a bench is where you craft",
> "a pickaxe mines". The agent already knows these, and an index that restates them
> goes stale without anyone noticing.

Applied: the bench **join** is indexed; the bench **word** is not.

### Value links — the generalized mechanism

`src/indexer/value-links.ts` holds every domain statement the index makes, as
data. Each is a pointer pair and nothing else; no entry says what a bench *is*.
Field shapes, union branches and namespaces are read from the schema.

| Link | Declared at | Referenced at | Resolved |
|---|---|---|---|
| `bench` | `BlockType./Bench` union → `/Id` | `common:BenchRequirement./Id` | 1 879 / 1 957 |
| `item-subcategory` | `common:SubCategoryDefinition./Id` | `Item./SubCategory` | **775 / 775** |
| `gather-type` | `ItemToolSpec./GatherType` | `common:BlockBreakingDropType./GatherType` | 2 144 / 2 156 |

Each was verified irreducible: `reference_target`, `enum_values` and `description`
are all null on both ends, and the values are not asset ids — the bench id is
`Builders` where the asset is `Bench_Builders`.

Two of the three are new findings, and both pay immediately:

- **`item-subcategory` replaces guesswork with fact.** The field was previously
  served only by name-collision heuristics: **2 042 edges for 775 candidates, every
  one low confidence**. It now resolves 775 of 775 exactly.
- **`gather-type` is directional, not a foreign key** — a tool *provides* a gather
  type, a block *requires* one. That asymmetry is the point: tools provide 14
  values, blocks require 16, so the unresolved side names blocks no tool can
  gather — `Unbreakable` (clearly deliberate), plus `SoftWoods` and `Pickaxe_Tier0`,
  which are not obviously so. This is the join the 3×3 pickaxe scenario needs.

The unresolved side is always kept rather than dropped, with a per-link sentence
saying what it means, because vanilla ships broken references in all three.

## 5. Recommended order

1. ~~**Pass 3 — field statistics.**~~ Done. `describe_schema` has both layers;
   238 enums inferred for fields the schema declares none for.
2. ~~**Bench and category modelling.**~~ Done — see above.
3. **`assetTypes` titles + `CommonAssetsIndex.hashes`.** Both are cheap reads with
   immediate payoff — human-readable types everywhere, and free change detection.
4. **`validate_pack`.** All four inputs now exist: broken declared references,
   missing files, missing localization, schema conformance. Calibrate against
   vanilla, which reports **919 duplicate assets and dangling block references in
   its own corpus** — so a broken reference must be a warning, not an error.
5. **MCP server.** Only after `describe_schema` has both layers; freezing the tool
   surface before then locks in the weaker half.

Deferred deliberately: worldgen typing, `.blockyanim` parsing, `.ui` parsing,
`AssetReferences`.
