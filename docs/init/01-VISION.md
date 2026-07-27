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
| **What is possible?** | "What fields can an item definition have, including ones vanilla never uses?" |
| **What connects to X?** | "What breaks if I override this block? What does this entity need to load?" |

The fourth is the one nothing else can answer today, and the third is the one that
requires the server JAR.

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

| Risk | Severity | Note |
|---|---|---|
| Pack format changes between EA versions | High | Schema must be inferred/extracted, never hardcoded |
| **Search fails on natural-language intent** | **High** | Identifiers are machine names. Mitigated by indexing localization strings — but if lang data is sparse or structured unexpectedly (Q14), reconsider embeddings |
| Codec extraction proves infeasible | High | Degrades to corpus-only inference; tool still useful, criterion 6 lost |
| Schema-only fields are mostly noise | Medium | `find_undocumented` becomes a curiosity rather than a feature. Test early; fall back to impact analysis as the headline |
| Community finds docs-MCP sufficient | Medium | Product risk, not technical. Mitigate by leading with impact analysis, which docs cannot provide |
| Legal exposure from JAR processing | Medium | Local-only extraction, no redistribution, no bundled game data |
| Node dependency excludes no-code pack authors | Medium | See `06-CLI-UX.md` for the single-binary alternative |
