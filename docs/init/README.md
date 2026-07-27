# Hytale Asset Index — Design Documentation Set

This directory contains the design specification for a proposed tool that indexes
Hytale asset packs and the vanilla asset corpus into a queryable graph, exposed to
AI agents over MCP.

**Status: pre-implementation, Phase 0 verification complete (2026-07-27).** No code
exists yet. These documents are the input to the design and build process, not a
description of a finished system.

The design has been reconciled against a real Hytale installation — see
`OPEN-QUESTIONS.md` for what was confirmed, what was contradicted, and what remains
open. Start there if you are picking this up cold; it is now the most
information-dense document in the set. `../PHASE-0-PLAN.md` records what was
checked and how.

## Reading order

| File | Purpose |
|---|---|
| `01-VISION.md` | What the tool is for, who uses it, what it must never become |
| `02-DOMAIN.md` | Hytale-specific facts, with confidence levels. **Read before any design work.** |
| `03-ARCHITECTURE.md` | Layers, graph model, indexing algorithm, storage, incremental updates |
| `04-MCP-SURFACE.md` | Tool surface exposed to agents, response discipline |
| `05-CODEC-EXTRACTION.md` | Deriving authoritative schema from the server JAR. Rewritten after Q1 — the codecs expose JSON Schema directly, so this went from the riskiest component to one of the cheapest |
| `06-CLI-UX.md` | `npx` entry point, autodetection, cache layout, degradation tiers |
| `07-PRIOR-ART.md` | Comparable systems worth studying before writing code |
| `08-ROADMAP.md` | Phasing, with explicit "stop and demo" points |
| `09-EVALUATION.md` | How to tell whether the tool actually helps |
| `OPEN-QUESTIONS.md` | **Answers from Phase 0, plus what remains open.** Blockers go here. Now the densest document in the set — read it second, after `01-VISION.md`. |

## Confidence markers

Every factual claim about Hytale in these documents carries one of:

- `[MEASURED]` — established by direct inspection of a real installation on
  2026-07-27; **outranks everything below it**
- `[VERIFIED]` — sourced from official docs or confirmed community documentation; URL given
- `[REPORTED]` — stated by a secondary source (blog, wiki, tool README); plausible but unconfirmed
- `[ASSUMED]` — inferred by analogy or reasoning; **not** established fact
- `[UNKNOWN]` — explicitly open; see `OPEN-QUESTIONS.md`

**Do not treat `[ASSUMED]` or `[REPORTED]` items as settled.** Phase 0 verification
contradicted several of them outright — including one `[VERIFIED]` claim (the user
pack path) and one `[REPORTED]` figure that was off by a factor of ten (archive
size). Where a `[MEASURED]` claim sits beside an older one, the older text is kept
only for provenance.

These documents were compiled from web research in July 2026. Hytale is in Early
Access and its pack format, API, and file layout are explicitly subject to change
between versions. Re-verify anything load-bearing.

## Phase 0 outcome — 2026-07-27

Verified against a real Windows installation (release patchline). Full detail in
`OPEN-QUESTIONS.md`; the headlines:

**Resolved favourably, all three stop-and-reassess conditions cleared:**

- **Q1 — codec extraction is nearly free.** `Codec<T> extends SchemaConvertable<T>`;
  every codec emits JSON Schema on request, complete with the game's own `title`,
  `description` and `enumDescriptions` prose. The three-approach risk analysis in
  `05-CODEC-EXTRACTION.md` was obsolete and that document was rewritten.
- **Q2 — the client ships `HytaleServer.jar` *and* a Temurin 25 JRE.** Tier 2 is
  available to pack authors, the primary audience, with no Java install required.
- **Q14 — localization works and is explicit.** `TranslationProperties.Name`
  references real keys; 99.9 % item coverage across 5 locales. No embeddings needed.
- **Q10 — EULA v2.2 permits this.** Modding is encouraged; calling `toSchema()` does
  not engage the decompilation clause at all.
- **Q16 — `logical_id` is path-derived**, the basename without extension.
- **Q5 — pack priority is an enum**, `PackSource.overrides()`:
  `CLI` > `CLASSPATH` > `MODS` > `RUNTIME`. Not filename order. (Same-category
  tiebreak still open.)
- **Q7 — the Asset Editor writes in place**, `Files.write(…, CREATE, WRITE,
  TRUNCATE_EXISTING)`, and hot-reloads externally modified files.

**A design principle the original documents never stated, added after Q5/Q7:**

**The tool never runs the game.** Everything comes from files at rest —
`HytaleServer.jar`, `Assets.zip`, packs, `patchline.json`. Q5 and Q7 were both
initially deferred as "needs a running game"; both turned out to be statically
readable, and the JAR answers were *better*, because they state the rule rather
than one instance of it. The Asset Editor in particular is a **builtin server
plugin**, not a client feature. `01-VISION.md` §Operating constraint and
`03-ARCHITECTURE.md` §Governing principle now carry this; Q9 was demoted out of
scope. **When a question looks like it needs the game, suspect the framing.**

**Contradicted by reality:**

- `Assets.zip` is **3.43 GB / 60 148 entries**, not "several hundred megabytes"
- User packs are **not** reliably at `UserData/Packs/` — that path did not exist
- The documented `manifest.json` field list is both incomplete and over-specified
- Codecs are **not** DataFixerUpper-style

**Newly discovered, and consequential:**

- **Q18 — assets inherit via `Parent`.** Definitions are not self-contained. This
  changes `get_asset` and field statistics, and was absent from every original
  document.
- **Q17 — the engine ships its own validators**, potentially reusable, which would
  make `validate_pack` authoritative rather than approximate. Better still,
  `AssetKeyValidator.updateSchema()` means **reference-typed fields mark themselves
  in the extracted schema** — the high-confidence resolver tier, by construction.
- **Q19 — the engine may already maintain a reference graph** (`AssetReferences`,
  typed by asset class and key). If reachable, large parts of pass 2 become
  verification rather than inference.
- **Path → asset type mapping is now the weakest link**: 39 JAR type subpackages vs
  51 archive directories, with no clean correspondence.

**Roadmap change:** Phase 3 (codec extraction) was promoted ahead of Phase 2
(schema statistics), on the trigger the roadmap itself specified. The extraction
*program* moves earlier still — Phase 1 consumes two of its three artifacts.

---

## Scope boundary — added after Phase 0

Phase 0 kept finding useful things in the JAR, and the natural drift was to reach
for all of them. **`05-CODEC-EXTRACTION.md` §Scope boundary now fixes the line:**

> **Read data, do not invoke behaviour.**

Extraction produces exactly three artifacts — the asset type table, the codec
schema per type, and reference-typed field markers (the third arrives free inside
the second). Executing the engine's validators (**Q17**) and reading its internal
reference graph (**Q19**) are *filed, not scheduled*: both require populated asset
stores, which couples us to how the game initialises rather than to what it
declares.

The corollary is easy to miss: **learning a rule from the JAR does not create a
dependency on it.** Pack priority (Q5) and Asset Editor write semantics (Q7) were
read statically and written down. We implement them ourselves. That is knowledge,
not coupling.

## A worked example that shaped the design

Tracing one real request — *"make a pickaxe that mines 3x3 and add its recipe to my
new workbench, in the tools category"* — against real data produced three changes:

- **A new tool, `search_schema`** (`04-MCP-SURFACE.md`). Four of the five
  sub-questions are answerable from the corpus. The fifth — *can a tool have an
  area of effect at all?* — is not, because **absence is invisible to a search over
  what exists**. `ItemTool` has no area field; area lives in `buildertool`. Without
  schema search an agent invents `"BreakRadius": 3` and the game silently ignores it.
- **A canonical evaluation scenario** (`09-EVALUATION.md`) with ground truth
  verified from the JAR and corpus, gradeable without launching the game.
- **A sharper framing of the project's bet** (`01-VISION.md`): the *negative*
  answer — "this is not expressible" — is safe and verifiable, and stands even if
  `find_undocumented` proves to be mostly noise.

---

## Revision note

These documents were revised after a critical review pass. The substantive changes:

- **Localization is now a first-class part of the graph** (`03-ARCHITECTURE.md`
  §Localization). The original design indexed only identifiers, which would have
  broken natural-language search — the tool's primary entry point. This was the
  most serious defect found.
- **Q10 (legal) and Q14 (localization) moved into Phase 0.** Both can invalidate
  work done before they are answered.
- **`find_undocumented` reframed as a hypothesis**, not a proven differentiator.
  New Q15 defines the experiment that settles it.
- **`09-EVALUATION.md` added.** There was previously no way to tell whether the
  index helps an agent, and the token-savings claim was extrapolated from
  code-graph tools rather than measured.
- **Cold-start behaviour specified** for the MCP server (`06-CLI-UX.md`), which
  would otherwise have hung clients past their timeout on first use.
- **Concurrency addressed** (`03-ARCHITECTURE.md`), previously absent entirely.
- Schema fixes: edge primary key, epoch semantics, `logical_id` derivation made
  explicit as an open question rather than assumed.

Items marked 🔴 in `OPEN-QUESTIONS.md` gate real design decisions. Do not build past
them on assumption.

## Working agreements

- **Do not touch version control.** No `git init`, `git add`, `git commit`, branch
  creation, or any other VCS operation. The repository owner manages git manually.
- **Do not pause mid-run to ask questions.** If a blocker appears, append it to
  `OPEN-QUESTIONS.md` with enough context to be actionable, and continue with the
  next unblocked task.
- **Prefer verification over assumption.** If a `[ASSUMED]` fact can be checked by
  reading a local file, check it and update the document.
- When a document is contradicted by reality, **edit the document** as part of the
  same change. Stale specs are worse than no specs.
