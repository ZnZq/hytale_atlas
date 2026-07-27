# 08 — Roadmap

Each phase ends at a point where the tool is genuinely usable. Do not start the
next phase before the current one demonstrably works end to end — this project has
enough moving parts that a half-finished layer cake is very hard to debug.

---

## Phase 0 — Verification ✅ COMPLETE (2026-07-27)

**Delivered:** Q1, Q2, Q3, Q4, Q6, Q10, Q14 and Q16 answered against a real
installation; Q5, Q8, Q11 partially; Q7 deferred with reasons. Two new questions
filed (Q17, Q18). Every contradicted design document was corrected in the same pass.

**None of the three stop-and-reassess conditions fired. All three resolved the
favourable way:**

| Condition | Outcome |
|---|---|
| Codecs not introspectable → tier 2 much harder | **Inverted.** `Codec<T> extends SchemaConvertable<T>` — every codec emits JSON Schema on request, with prose descriptions. Tier 2 got dramatically *easier*. |
| Localization absent → search needs embeddings | **Did not fire.** Explicit `TranslationProperties.Name` references, 99.9 % item coverage, 5 locales. FTS over lang values is sufficient. |
| Policy prohibits JAR analysis → corpus-only forever | **Did not fire.** EULA v2.2 §3.1 encourages modding, §4.2 preserves interoperability rights, and calling `toSchema()` does not engage §4.1(a) at all. |

**What changed as a result:**

- **Phase 3 moved ahead of Phase 2** — see below. Both preconditions the original
  document set for that move (Q1 and Q2 resolving favourably) are met.
- `05-CODEC-EXTRACTION.md` was rewritten; its three-approach risk analysis is
  obsolete.
- **Asset inheritance (`Parent`) was discovered and is now Phase 1 scope** — Q18.
  It was absent from every original document.
- Path → asset type mapping is now the weakest link in pass 1, not schema
  extraction. 39 JAR type subpackages vs 51 archive directories, no clean
  correspondence.

**Still to verify before the phases that need them:** Q5 (pack priority) and Q18
merge semantics before Phase 4; Q7 (editor write behaviour) before Phase 5; Q11
size percentiles before elision thresholds are tuned.

---

## Phase 1 — Corpus index

**Deliverable:** `npx hytale-index` indexes `Assets.zip` and serves
`search_assets`, `list_asset_types`, `get_asset` over MCP.

Scope:
- Streaming ZIP reader with per-entry extraction (do not unpack wholesale) —
  the archive is **3.43 GB / 60 148 entries**, so this is not optional
- SQLite schema (WAL, indexes per `03-ARCHITECTURE.md`) + FTS
- Pass 1 (symbol table) and pass 2 (candidates and resolution)
- **Path → asset type mapping.** Now the weakest link in this phase: a second-level
  directory is not a type, and the JAR's 39 type subpackages do not map cleanly onto
  the archive's 51 directories. Derive from the registry; surface disagreements
  rather than guessing (`OPEN-QUESTIONS.md` Q4)
- **`Parent` inheritance resolution** — new scope, from Q18. `get_asset` must
  return the definition *after* resolving the parent chain; returning the raw file
  would show the agent a partial definition and invite it to conclude fields are
  absent. Also add `INHERITS_FROM` edges
- **Localization parsing and `LOCALIZED_BY` edges** — not deferrable, search depends
  on it. Explicit references via `TranslationProperties`, so these are
  high-confidence. Two traps: the `server.`/`common.` root-prefix rewrite, and
  ICU MessageFormat with multi-line continuations (`02-DOMAIN.md` §Localization)
- FTS over identifiers **and** localized strings
- Global frozen cache keyed by content hash, with a build lockfile
- Minimal MCP server: `search_assets`, `list_asset_types`, `get_asset`,
  `lookup_lang`, `status`
- Cold-start guard (`06-CLI-UX.md`)
- Progress reporting on first run

**Already useful.** An agent that can search and read vanilla assets is meaningfully
better than one that cannot.

*Note:* `get_asset` reports what a definition overrode, but with only the vanilla
pack indexed there are no overrides. That reporting stays inert until Phase 4; do
not build the grouping logic here beyond storing `logical_id`.

**Test:** the search evaluation in `09-EVALUATION.md` §Search — recall@5 over ~30
natural-language phrases, comparing identifier-only FTS against identifier + lang.
**This is the decision point for whether embeddings are needed.** Plus: ask an agent
to find how a specific vanilla item is defined; it should take two or three calls.

---

## Phase 2 — Codec extraction *(was Phase 3; promoted)*

**Deliverable:** tier 2. Authoritative `describe_schema`, `find_undocumented`,
schema-aware `validate_pack`.

**Why it moved.** The original document said to pull this earlier if Q1 and Q2 both
resolved favourably. They did, emphatically:

- Q1 — `Codec<T> extends SchemaConvertable<T>`. Extraction is *calling an API*, not
  a research project. This phase went from the riskiest work in the plan to among
  the cheapest.
- Q2 — the client ships both the JAR and a Temurin 25 runtime, so tier 2 reaches
  pack authors, the primary audience.

And the ordering argument is stronger than it looked. Real asset references are
**bare unnamespaced strings** (`"Set": "Rock_Magma_Cooled"`, `"Parent": "…"`) —
precisely the low-confidence collision case. Running extraction *before* schema
inference means Phase 3 resolves those against declared types instead of guessing,
so its statistics are built on correct edges rather than needing rework.

Scope per `05-CODEC-EXTRACTION.md`:
- Pre-compiled JVM extractor run as a sandboxed subprocess, preferring the game's
  bundled JRE
- Enumerate types via `JsonAssetWithMap` implementors, cross-checked against the
  `asset.type` package convention
- `toSchema(SchemaContext)` → serialise via `Schema.CODEC`
- Keep the verbatim schema document *and* a flattened field list
- Coverage reporting, including types that fail to initialise
- Hash-keyed schema cache
- **Capture `title` / `description` / `enumDescriptions`** — the game documents its
  own schema, and that prose is both user-facing output and FTS input
- Investigate `Schema.hytaleParent` / `InheritSettings` while here; it is the
  authoritative description of the Q18 inheritance semantics Phase 1 had to infer

**Test, and treat it as a go/no-go on the feature's framing.** Take a sample of
fields `find_undocumented` reports and grade them **statically first**, in this
order (`OPEN-QUESTIONS.md` Q15):

1. their own `description` / `markdownDescription` — deprecation notes usually say so
2. whether a validator is attached (`AssetKeyValidator.updateSchema`) — the engine
   validating a field means the engine reads it
3. whether the field crosses into `com.hypixel.hytale.protocol`
4. whether anything outside the codec calls its getter

If those four separate live fields from vestigial ones cleanly, the question is
settled without ever launching anything, and the tool can filter on the marker.

Only if they do not, fall back to the ground-truth experiment — three fields in a
real pack, load the game, observe. That is **one-off product research by a person**,
not something the tool may depend on (`01-VISION.md` §Operating constraint).

If the fields work, the feature is the headline. If most are deprecated or
engine-internal, keep the tool but present it as "fields the schema permits" and
move the headline claim to impact analysis. See `01-VISION.md` criterion 6.

---

## Phase 3 — Schema statistics and examples *(was Phase 2)*

**Deliverable:** `describe_schema` with both layers, `find_examples`, `trace_refs`.

Scope:
- Pass 3: field statistics aggregated by `(asset_type, json_pointer)`, computed
  over **inheritance-resolved** assets — raw files undercount, because inherited
  fields never appear in the child document (Q18)
- Cardinality pre-pass, then enum capture where cardinality is low. Note this is
  now only needed for fields the codec schema does **not** cover; declared enums
  arrive complete and with descriptions
- Record vs map discrimination (see `07-PRIOR-ART.md` §polars-genson) — likewise
  reduced in scope, since `toSchema()` distinguishes an `ObjectSchema` with fixed
  properties from a dynamic map
- Reference edges promoted to high confidence wherever schema declares a reference
  type; confidence tiers retained for the remainder
- Bounded-depth traversal via recursive CTEs

**This is where the real value appears.** "How do I make X" becomes answerable with
evidence — now evidence from two independent sources that can be shown side by side.

**Test:** ask "how do I make a sword that deals fire damage" and check that the
agent finds a real vanilla example rather than inventing field names.

---

## Phase 4 — Multi-pack and overlays

**Deliverable:** `diff_override`, `find_conflicts`, third-party pack ingestion.

Scope:
- Logical-ID grouping and `is_effective` resolution (needs **Q5** answered).
  `logical_id` derivation itself is settled — Q16
- `OVERRIDES` edges, kept **distinct from `INHERITS_FROM`** (Q18). Inheritance is
  intra-corpus and explicit; overriding is cross-pack and identity-based.
  Conflating them produces wrong impact analysis in both directions
- Manifest dependency graph — including **`LoadBefore`**, an ordering field found
  in a real pack manifest and absent from the documented schema (`02-DOMAIN.md`).
  Treat manifests as open-ended: validate known fields, preserve unknown ones
- `add-pack` command

**Test:** install two packs that touch the same asset; `find_conflicts` identifies
the collision and names the winner.

---

## Phase 5 — Live indexing

**Deliverable:** tier 3. Hot layer, watcher, `whats_changed`, `validate_pack`,
epoch propagation.

Scope:
- Hot/frozen split with union symbol table
- Change queue with lazy drain at request time
- Per-file reindex including candidate promotion and dangling demotion
- Write-race mitigation (stability check, single retry, tmp-file masks)
- Exclusion list for build directories
- `whats_changed` and epoch in every response
- Concurrency: drain serialisation, `busy_timeout`, multi-session safety
  (`03-ARCHITECTURE.md` §Concurrency)
- **Incremental equivalence test** — full reindex and incremental reindex of the
  same state must produce identical graphs. This is the property most likely to
  break silently.

Leave this until last deliberately: it is the most intricate part, and it is
worthless without everything above it working.

**Test:** edit a file by hand mid-session; the next tool call reflects it, and
`whats_changed` reports it accurately including a newly broken reference.

---

## Phase 6 — Polish and distribution

- `status()` with tier and coverage
- CI-friendly `validate` exit codes
- Config file support
- Documentation and MCP setup snippets
- Gradle integration, ideally with `com.azuredoom.hytale-tools`
- Publish to npm

---

## Explicitly deferred

- Graph visualisation — useful for humans, irrelevant to agents
- `run_query` escape hatch — only with evidence the fixed surface is inadequate
- Write tools — keeping the index read-only avoids a whole consistency problem class
- Cross-version diffing ("what changed in this patch") — attractive, but wait for
  a real patch to test against
- Single-binary rewrite — only if Node proves to be an adoption blocker

---

## Sequencing note

Updated after Phase 0. Order is now **1 → 2 (codec) → 3 (statistics) → 5 → 4**.

Phases 1, 3, and 5 form the minimum coherent product for pack authors. Phase 2 is
the differentiator, and is no longer expensive enough to defer — it is now cheaper
than the statistics work it feeds, and it makes that work more accurate. Phase 4
matters most to server operators and to authors of large packs.

If time is constrained, ship 1 → 2 → 3 → 5 and treat 4 as a follow-up. Do **not**
drop Phase 2 to save time; it is now among the cheapest phases and it carries the
only capability nothing else in the ecosystem offers.

Phase 4 remains last of the value phases because it depends on two still-open
questions (Q5 pack priority, Q18 merge semantics) that Phase 2's extraction may
answer for free — `Schema.hytaleParent` describes the inheritance settings
authoritatively.
