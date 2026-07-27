# 08 — Roadmap

Each phase ends at a point where the tool is genuinely usable. Do not start the
next phase before the current one demonstrably works end to end — this project has
enough moving parts that a half-finished layer cake is very hard to debug.

---

## Phase 0 — Verification (before writing anything substantial)

**Deliverable:** `OPEN-QUESTIONS.md` updated with answers to **Q1–Q7, Q10, and
Q14**. That is all.

This phase is hours, not days, and it prevents building on wrong assumptions.

- **Q1** (codec mechanics) and **Q2** (JAR in client installs) can each reorder the
  rest of the plan.
- **Q10** (legal) is here because it is the only question that can invalidate the
  whole project. Checking it after building is the wrong order.
- **Q14** (localization) is here because search quality depends on it, and search is
  the entry point to every other feature.

Concretely: open a real `Assets.zip`, look at the actual directory layout, a handful
of real asset JSON files, and the localization files; open `HytaleServer.jar` to see
what a codec actually looks like; read Hytale's official policy pages.

**Stop and reassess if:**
- codecs are not introspectable → tier 2 gets much harder, rebalance toward corpus
  inference
- localization is absent or unusable → search needs embeddings, which changes both
  the storage design and the dependency footprint
- policy prohibits automated JAR analysis → the project is corpus-only, permanently

---

## Phase 1 — Corpus index

**Deliverable:** `npx hytale-index` indexes `Assets.zip` and serves
`search_assets`, `list_asset_types`, `get_asset` over MCP.

Scope:
- Streaming ZIP reader with per-entry extraction (do not unpack wholesale)
- SQLite schema (WAL, indexes per `03-ARCHITECTURE.md`) + FTS
- Pass 1 (symbol table) and pass 2 (candidates and resolution)
- **Localization parsing and `LOCALIZED_BY` edges** — not deferrable, search depends
  on it
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

## Phase 2 — Schema and examples

**Deliverable:** `describe_schema`, `find_examples`, `trace_refs`.

Scope:
- Pass 3: field statistics aggregated by `(asset_type, json_pointer)`
- Cardinality pre-pass, then enum capture where cardinality is low
- Record vs map discrimination (see `07-PRIOR-ART.md` §polars-genson)
- Reference edges with confidence tiers
- Bounded-depth traversal via recursive CTEs

**This is where the real value appears.** "How do I make X" becomes answerable with
evidence.

**Test:** ask "how do I make a sword that deals fire damage" and check that the
agent finds a real vanilla example rather than inventing field names.

---

## Phase 3 — Codec extraction

**Deliverable:** tier 2. `find_undocumented`, authoritative `describe_schema`,
schema-aware `validate_pack`.

Scope per `05-CODEC-EXTRACTION.md`: JVM subprocess extractor, hybrid bytecode path
for enums, coverage reporting, hash-keyed schema cache.

**Consider pulling this earlier.** Two arguments: schema converts the resolver from
heuristic to exact for every covered field, improving Phase 2's output quality; and
`find_undocumented` is the single feature no competing approach can offer. If Q1
and Q2 both resolve favourably, doing this before Phase 2 is defensible.

**Test, and treat it as a go/no-go on the feature's framing:** take three fields
that `find_undocumented` reports, put them in a real pack, and run the game. If they
work, the feature is the headline. If most are deprecated or engine-internal, keep
the tool but present it as "fields the schema permits" and move the headline claim
to impact analysis. See `01-VISION.md` criterion 6.

---

## Phase 4 — Multi-pack and overlays

**Deliverable:** `diff_override`, `find_conflicts`, third-party pack ingestion.

Scope:
- Logical-ID grouping and `is_effective` resolution (needs Q5 answered)
- `OVERRIDES` edges
- `add-pack` command
- Manifest dependency graph

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

Phases 1, 2, and 5 form the minimum coherent product for pack authors. Phase 3 is
the differentiator. Phase 4 matters most to server operators and to authors of
large packs.

If time is constrained, ship 1 → 2 → 5 and treat 3 and 4 as follow-ups. If Q2
resolves favourably (the JAR is present in every client install), 3 moves up.
