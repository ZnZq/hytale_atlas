# Phase 0 — Verification Plan

## ✅ COMPLETE — 2026-07-27

| Task | Result |
|---|---|
| **T1** record verified environment | Done. Q2, Q6 resolved; `02-DOMAIN.md`, `06-CLI-UX.md`, `08-ROADMAP.md` corrected |
| **T2** archive structure & identity | Done. Q3, Q4, Q16 resolved; Q11 partial. **Q18 (`Parent` inheritance) discovered** |
| **T3** localization 🔴 | Done. **Q14 resolved favourably** — explicit references, 99.9 % item coverage, no embeddings needed |
| **T4** codec mechanics 🔴 | Done. **Q1 resolved, and inverted** — `Codec<T> extends SchemaConvertable<T>`. **Q17 (engine validators) discovered** |
| **T5** legal 🔴 | Done. **Q10 resolved** — EULA v2.2 permits this; `toSchema()` avoids the decompilation clause entirely |
| **T6** Q5 / Q7 best effort | **Both resolved from the JAR.** Q5 — `PackSource.overrides()` decoded. Q7 — `StandardDataSource` writes in place. **Q19 (engine reference graph) discovered** |
| **T7** reconcile documents | Done. 10 of 11 design documents edited |

**Not one of the three stop-and-reassess conditions fired.** All three resolved the
favourable way. See `init/README.md` §Phase 0 outcome for the summary and
`init/OPEN-QUESTIONS.md` for full detail.

### Correction: "needs a running game" was the wrong frame

Q5 and Q7 were initially deferred as requiring observation of a live game. That was
wrong twice over, and the correction produced a design principle the documents had
never stated:

- **The Asset Editor is a builtin *server* plugin** inside `HytaleServer.jar`
  (`com.hypixel.hytale.builtin.asseteditor`). Its write path is as statically
  readable as anything else.
- **Pack priority is an enum with an `overrides()` method**, not emergent
  behaviour. The JAR states the rule; observing one session would only have shown
  one instance of it.

**`01-VISION.md` §Operating constraint** now records this as a hard constraint: the
tool operates on `HytaleServer.jar`, `Assets.zip`, packs and launcher metadata, and
never runs the game. `03-ARCHITECTURE.md` carries it as a governing principle.
`OPEN-QUESTIONS.md` **Q9** (in-game `/assets` command) was demoted out of scope
accordingly. The rule that follows: **when a question looks like it needs the game,
suspect the framing before accepting the deferral.**

**Carried forward:** Q5 same-category tiebreak and Q18 merge semantics (before
Phase 4), Q11 size percentiles (before elision tuning), Q15 (the product-defining
bet), Q17 and Q19 (alongside Phase 2). Path → asset type mapping replaced codec
extraction as the riskiest remaining piece of Phase 1.

**No code was written and version control was not touched**, per the working
agreements below.

---

## Original plan

**Goal:** answer the blocking questions in `init/OPEN-QUESTIONS.md` against a real
Hytale installation, and bring the design documents into agreement with reality.
No implementation code. Per `init/08-ROADMAP.md`, Phase 0 is hours, not days.

**Deliverable:** `init/OPEN-QUESTIONS.md` with Q1–Q7, Q10, Q14 answered and marked
`RESOLVED`, plus every design document that those answers contradict corrected in
the same pass.

**Working agreements** (from `init/README.md`, in force for this plan):

- Do not touch version control. No `git` operations of any kind.
- Do not pause to ask questions. Append blockers to `OPEN-QUESTIONS.md` and
  continue with the next unblocked task.
- Prefer verification over assumption.
- When a document is contradicted by reality, edit the document as part of the
  same change.

---

## Verified environment

Confirmed present on this machine before planning:

| Fact | Value |
|---|---|
| Install root | `%AppData%\Roaming\Hytale\install\<patchline>\package\game\latest\` |
| Patchlines present | `release`, `pre-release` (sibling directories) |
| Active patchline | `release` — recorded in `%AppData%\Roaming\Hytale\patchline.json` |
| `Assets.zip` (release) | 3 428 472 949 bytes, 60 148 entries |
| `HytaleServer.jar` (release) | 123 347 829 bytes, at `…\game\latest\Server\` |
| Bundled JRE | Temurin 25.0.2+10, at `…\package\jre\latest\` |
| Third-party pack fixture | `UserData\Saves\qqq\mods\Airijko_EndlessLevelingCore\` |

Two consequences already established: **Q2 resolves favourably** (tier 2 is
available to pack authors, not just plugin developers — and the JVM it needs ships
with the game), and `Assets.zip` is **~10× larger** than `02-DOMAIN.md` reports.

---

## Task list

### T1 — Record what is already verified

Write the answers established above into `OPEN-QUESTIONS.md` for **Q2** and **Q6**,
and the partial answers for **Q3** and **Q4**. Mark resolved items `RESOLVED`.

Correct the documents they contradict:

- `02-DOMAIN.md` — archive size (`[REPORTED]` several hundred MB → measured 3.4 GB);
  add the confirmed Windows install path; note the bundled JRE.
- `06-CLI-UX.md` — Q6 autodetection becomes "read `patchline.json`", not a path
  guess; the tier-2 "no Java → tier 1" caveat weakens substantially.
- `08-ROADMAP.md` — record that the Q2 precondition for pulling Phase 3 earlier
  is now met.

### T2 — Q4/Q16, deeper: archive structure and asset identity

Read from `Assets.zip` **without unpacking it**, per `02-DOMAIN.md`:

- Root `manifest.json` — what the vanilla pack declares about itself.
- `CommonAssetsIndex.hashes` — format and content. If the game already ships an
  ID→hash index, pass 1 may be largely free. Explicitly asked by Q4.
- A sample of real asset JSON across several type directories (`Server/Item`,
  `Server/Entity`, `Server/Drops`, `Server/Particles`, `Common/Blocks`).
- **Q16:** is identity carried in the file (an `Id`/`Name` field, namespaced or
  not) or derived from the path? This decides `logical_id` derivation, and getting
  it wrong corrupts every override relationship silently.
- How JSON references `.blockymodel` and `.png` — by path, by ID, with or without
  extension. Drives the pass-2 normalisation rules.
- File-type distribution and size percentiles (feeds **Q11**, and the elision
  thresholds in `04-MCP-SURFACE.md`).
- Whether the PascalCase directory names (`Server/Item`) line up with the JAR's
  lowercase `asset.type.<name>` subpackages. A mismatch is itself information.

### T3 — Q14: localization 🔴

The Phase 0 item that decides whether search works at all.

Locate the translation files under `Server/`, then determine: file format and
layout, how many locales ship, how an asset references its display name (explicit
field vs. convention derived from the asset ID), which roles exist beyond name,
what proportion of vanilla assets have entries, and whether nesting or
interpolation complicates parsing.

**Decision this gates:** if localization is absent, sparse, or cannot be joined to
assets, search needs embeddings — a different dependency footprint and a different
storage design (`03-ARCHITECTURE.md` §Localization, `09-EVALUATION.md` §Search).

### T4 — Q1: codec mechanics 🔴 BLOCKING

The single most important assumption in the document set. `05-CODEC-EXTRACTION.md`
assumes DataFixerUpper-style codecs and picks runtime reflection on that basis.

Extract `HytaleServer.jar` to the scratchpad (never into the repository — see
Legal, below) and inspect `com.hypixel.hytale.server.core.asset.type.item.config.Item`:

- Is there a static `Codec` field, an annotation-driven serializer, or a
  hand-written reader?
- Are field names string literals in `<clinit>`, or something else?
- Do defaults and optionality survive into the runtime object?
- Is there a shared base or registry enumerating all codecs?

Tooling preference: `javap` from the bundled JDK/JRE if present; otherwise a
bytecode read of the constant pool and `<clinit>`. Decompilation is a last resort
and its output is not vendored.

Also enumerate the subpackages of `…core.asset.type` to see whether asset types
can be discovered rather than hardcoded, and cross-check that list against the
directory names in `Assets.zip`.

**Opportunistic:** if the registry structure is visible while doing this, capture
it for **Q8** (ECS component registration). Do not block on it.

### T5 — Q10: legal 🔴

The only question that can invalidate the project, which is why it belongs here
and not at publication time.

Read `%AppData%\Roaming\Hytale\eula.txt` and the official Hytale policy pages.
Determine whether automated local JAR analysis is restricted beyond the
already-assumed no-redistribution constraint, and whether "not obfuscated, freely
decompilable" is an official statement or a community observation.

### T6 — Q5, Q7: best effort, do not block

- **Q5** (pack priority resolution) — attempt from the JAR's `FileIO` / pack
  loading code while T4 already has it open. If it needs a running game, record
  what is known and defer.
- **Q7** (Asset Editor write behaviour) — needs the game running and a save
  observed. Almost certainly defers past Phase 0; record it as such rather than
  leaving it silently open.

### T7 — Reconcile the document set

Apply every correction the preceding tasks produced, then re-read the set for
consistency. Any question that could not be answered gets an explicit note saying
what was attempted and what it would take, so the next pass does not re-derive it.

---

## Legal boundary — applies to every task above

From `02-DOMAIN.md` §Legal and `05-CODEC-EXTRACTION.md`:

- Extraction runs locally, against this machine's own installation.
- **No Hytale-derived data enters the repository** — no extracted schema dumps, no
  asset listings, no decompiled source, no corpus samples beyond the short
  illustrative fragments needed to state a finding.
- All working extraction goes to the session scratchpad, not into `C:\ZnZ\hytale_atlas`.

---

## Stop-and-reassess conditions

Named in `08-ROADMAP.md`, and still the right triggers:

| Finding | Consequence |
|---|---|
| Codecs are not introspectable | Tier 2 gets much harder; rebalance toward corpus inference |
| Localization absent or unjoinable | Search needs embeddings; storage design and dependencies change |
| Policy prohibits automated JAR analysis | Project is corpus-only, permanently |

---

## Explicitly not in this phase

No SQLite schema, no indexer, no MCP server, no CLI. Phase 1 starts only once the
questions above are answered.
