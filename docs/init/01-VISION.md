# 01 — Vision

## The problem

A Hytale content creator opens a chat with an AI agent and says: *"I want to make a
sword that sets enemies on fire and drops from cave spiders."*

For the agent to actually help, it needs to know:

- Which asset types are involved, and what their JSON shape is
- Which field expresses "on-fire effect", and what values it accepts
- How the vanilla game already implements something similar
- What "cave spider" is actually called in the files — the user says the display
  name, the files use an identifier
- What else in the corpus references the assets being touched
- Whether the resulting pack is internally consistent

None of this is currently available to an agent. Its options are:

1. Read documentation — incomplete, lags the Early Access build, describes intent
   rather than the shipped format
2. Grep the vanilla `Assets.zip` — hundreds of megabytes, thousands of files, no
   structure to navigate by, catastrophic token cost
3. Guess — produces JSON that looks plausible and silently fails to load

The gap is not knowledge, it is **navigable structure over knowledge that already
exists on the user's disk**.

## What the tool is

A local indexer that ingests:

- The vanilla `Assets.zip`, including its **localization files** — the only
  natural-language content in the corpus, and the bridge between what a user says
  and what the files are called
- Any number of third-party asset packs
- The user's own in-progress pack or plugin
- (Where available) the server JAR, for authoritative schema

...and produces a persistent graph of assets, their fields, and the references
between them — exposed to any MCP-speaking agent through a small set of
task-shaped tools.

It answers four families of question:

| Question | Example |
|---|---|
| **What exists?** | "What asset types are there? What items exist?" |
| **How is X built?** | "Show me how vanilla implements a burning weapon" |
| **What is possible?** | "What fields can an item definition have, including ones vanilla never uses?" · "Can a pickaxe mine 3x3 at all?" |
| **What connects to X?** | "What breaks if I override this block? What does this entity need to load?" |

The fourth is the one nothing else can answer today, and the third is the one that
requires the server JAR.

**The third splits into two answers with very different risk profiles**, and the
distinction is worth making early because it de-risks this document's central bet:

- **The negative answer — "this is not expressible."** Safe, verifiable, and
  immediately valuable. Traced on real data: a gathering tool has no area field, so
  a 3x3 pickaxe cannot be made by editing an item. An agent without schema searches
  the corpus, finds no 3x3 tool, and invents `"BreakRadius": 3`; the game silently
  ignores it. **Absence is invisible to corpus search**, so this answer is
  structurally unavailable to any grep-based approach — and it costs nothing to be
  confident about, because we are reporting what the schema does not contain.
- **The positive answer — "this field exists but vanilla never uses it."** That is
  criterion 6 below, and it remains a bet: such a field may be deprecated,
  engine-internal, or set programmatically.

Half the value of "what is possible" therefore does **not** depend on the bet
landing. Even if `find_undocumented` turns out to be mostly noise, the negative
answer stands on its own.

## Who it is for

**Primary: pack authors.** No-code or low-code creators working with JSON and PNG.
They are the largest audience and the least served, because they have no compiler,
no type system, and no autocomplete. Their project folder typically starts as a
manifest and two empty directories — meaning the tool must deliver full value with
*nothing* in the user's project.

**Secondary: plugin developers.** Already have Gradle, Java 25, an IDE, and the
server JAR on their classpath. They get the richest index but need it least for
Java-side work — their gain is on the asset side of their plugin, and in impact
analysis across a large content set.

**Tertiary: server operators and pack consumers.** Diagnosing why a pack conflicts
with another pack, or what a downloaded pack actually overrides.

## Value proposition

For the agent: **token efficiency and correctness**. Comparable code-graph MCP
servers report roughly 10x reductions in token use and about 2x fewer tool calls
versus file-by-file exploration (see `07-PRIOR-ART.md`).

Those numbers are for *code*, and should be treated as a hypothesis here, not an
inherited result. The argument transfers in one direction and not the other: asset
JSON is more verbose than code, but it is also flatter and more string-keyed, so
plain grep may work *better* on it than on source. What grep cannot do is traverse
relationships or distinguish a field that is legal from one that merely appears
often — and that, rather than raw token count, is the defensible claim.

Measure it rather than assert it. See `09-EVALUATION.md`.

For the human: **a shorter loop between intent and working content**. The measure
of success is that a creator describes what they want and gets JSON that loads on
the first try, grounded in how the game actually does it.

## Non-goals

- **Not a pack generator.** It indexes and explains; it does not scaffold content.
  Generation belongs to the agent, informed by the index.
- **Not a replacement for the in-game Asset Editor.** The editor is the authoring
  surface and is better at it. This is the knowledge layer beside it.
- **Not a runtime bridge.** Controlling a live server is a separate concern, and a
  separate tool already exists for it.
- **Not a redistributor.** See `02-DOMAIN.md` §Legal. The tool ships an extractor;
  it never ships extracted Hytale data.
- **Not a Java API browser.** Community Javadoc and API index projects already
  cover the plugin-authoring surface. This tool reads the JAR only to recover
  *asset schema*, not to document classes.

## Operating constraint — files at rest, plus documented batch modes

**The tool never depends on a live game.** Its inputs are files:

| Source | Supplies |
|---|---|
| `HytaleServer.jar` | Schema, enums, asset-type table, engine behaviour |
| `Assets.zip` | The vanilla corpus and its localization |
| Pack directories and archives | Third-party and user content |
| `patchline.json` | Which installation to read |

No live server. No network session. No world. No in-game command output.

### The one permitted exception, and its price

**Documented batch modes of the server binary that generate a file and exit** are
in scope. The server ships `--generate-asset-schema <dir>`, which produces the
entire schema corpus in ~40 seconds and terminates
(`05-CODEC-EXTRACTION.md`). Shelling out to a vendor tool that exits is a different
act from requiring a running game — nearer to invoking `javac` than to booting a
world.

This was a deliberate amendment, not a drift. The original constraint said "no game
process" outright, and adopting the batch mode changes it. Three conditions come
with it:

1. **Disclose before running.** The batch mode **emits telemetry and we cannot
   suppress it** — `TelemetryService` has no CLI switch. It also writes plugin and
   server configs. The user must be told plainly that this step starts the vendor's
   server binary and that the binary phones home. Not in a log line; in the prompt
   that precedes it.
2. **Isolate and clean up.** Fresh temp working directory, deleted afterwards. The
   generator *wipes its output directory* before writing, so pointing it at user
   content would destroy it.
3. **Cache by JAR hash.** Once per game version, never per invocation.

### What remains out of scope

- **A live server as a data source.** `OPEN-QUESTIONS.md` Q9 (`/assets` command
  output) stays demoted: even a favourable answer could not be depended on.
- **Long-running or interactive game processes.** Batch-and-exit only.

### Where a question looks like it needs the game, check twice

Phase 0 filed Q5 and Q7 as "needs a running game"; both turned out to be readable
from the JAR, and the JAR answers were *better*, because they state the rule rather
than one instance of it. Q1 went through three plans before someone read `--help`.
**Suspect the framing before accepting the deferral.**

The one place this constraint bites honestly is **evaluation**: "does the generated
pack load in-game" is the only true ground truth, and it is out of scope for the
tool. `09-EVALUATION.md` addresses the substitute.

## Success criteria

The tool is working if:

1. `npx <tool>` in an **empty pack folder** produces a useful index within a few
   minutes, and within seconds on every subsequent project.
2. An agent asked "how do I make X" retrieves a real vanilla example rather than
   inventing field names.
3. `validate_pack` catches a broken reference that the game would have silently
   ignored.
4. The index reflects a file the user just saved, without an explicit refresh.
5. A query phrased in **plain language** ("flaming sword", "cave spider drops")
   finds the right assets — which requires localization data in the index, not just
   identifiers. See `03-ARCHITECTURE.md` §Localization.
6. It reports fields that exist in the game's schema but appear in **zero** vanilla
   assets, and at least some of them turn out to be genuinely usable.

Criterion 6 is the intended differentiator, and it is also the least certain thing
in this document. A field present in the schema but absent from the corpus may be
deprecated, engine-internal, set programmatically rather than from JSON, or a debug
affordance — none of which help a creator. **Treat "these are undocumented
capabilities" as an untested hypothesis.** Validate it cheaply and early: extract
three such fields, use them in a real pack, and see whether the game honours them.
If it turns out most are noise, the feature is still shippable but must be presented
as "fields the schema permits" with a caveat, and the differentiator claim moves to
criterion 4 (impact analysis), which is safe.

Criteria 1–5 are achievable with confidence. Criterion 6 is the bet.

## Risk register

Revised after Phase 0 verification (2026-07-27). Three of the four High risks
retired; the residual risk in this project is now **product-side and
engineering-side, not feasibility-side**.

| Risk | Severity | Status after Phase 0 |
|---|---|---|
| Pack format changes between EA versions | High | **Unchanged.** Still the governing constraint: never hardcode schema. Two patchlines already coexist on one machine, so cache by content hash |
| **Corpus scale** | **High** → Medium | `Assets.zip` measured at **3.43 GB / 60 148 entries** — an order of magnitude above the original budget. Streaming extraction is mandatory. Downgraded after implementation: enumerating all entries costs ~4 s and decompressing one asset JSON ~0.13 ms, so the archive is navigable; the cost is in how many entries we choose to parse |
| ~~Path → asset type mapping~~ | ~~High~~ → **Low** | **Retired.** The engine ships the table and the resolver: `AssetEditorAssetType{id, path, fileExtension}` plus `AssetTypeRegistry.getAssetTypeHandlerForPath(Path)`. Execution, not a design unknown — but it must be extracted **before** Phase 1's pass 1 (`08-ROADMAP.md` §Prerequisite) |
| Asset inheritance (`Parent`) | Medium 🆕 | Definitions are not self-contained. Affects `get_asset` and field statistics. Merge semantics still open — `OPEN-QUESTIONS.md` Q18 |
| ~~Search fails on natural-language intent~~ | ~~High~~ → **Low** | **Retired.** Explicit `TranslationProperties.Name` references, 99.9 % item coverage, 5 locales. Embeddings not needed. Residual risk is parser correctness (ICU MessageFormat, root-prefix rewrite), not data availability |
| ~~Codec extraction proves infeasible~~ | ~~High~~ → **Low** | **Retired, and inverted.** `Codec<T> extends SchemaConvertable<T>` — schema is a supported API call, delivered with the game's own prose descriptions |
| ~~Legal exposure from JAR processing~~ | ~~Medium~~ → **Low** | **Retired.** EULA v2.2 §3.1 encourages modding, §4.2 preserves interoperability rights, and `toSchema()` does not engage the §4.1(a) decompilation clause at all. Constraints unchanged: local-only, no redistribution, descriptive naming |
| ~~Node dependency excludes no-code authors~~ | ~~Medium~~ → **Low** | Unchanged for Node itself, but the *Java* half is gone: the game bundles a Temurin 25 JRE, so tier 2 needs no user-installed JVM |
| Schema-only fields are mostly noise | Medium | **Still open (Q15)** — but cheaper to test, and extracted `description` text may separate live fields from vestigial ones without an in-game experiment |
| Community finds docs-MCP sufficient | Medium | **Unchanged, and now the largest remaining risk.** Product, not technical. Lead with impact analysis and validation, which documentation cannot provide |
