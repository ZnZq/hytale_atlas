# Evaluation fixtures

Written **before** the index exists, so the design cannot be tuned to its own test
(`../init/09-EVALUATION.md`).

| File | Purpose |
|---|---|
| `search-phrases.json` | 36 natural-language phrases with verified expected asset IDs. Drives the Phase 1 search evaluation. |

The canonical end-to-end scenario ("3x3 pickaxe") lives in
`../init/09-EVALUATION.md` §The canonical scenario rather than here — it grades a
whole authoring flow, not a retrieval result.

---

## Why this set is shaped the way it is

The question it answers is narrow and decisive: **does indexing localized strings
actually improve search, or would identifiers alone have done?** `01-VISION.md`
names search quality as the largest identified risk, and
`03-ARCHITECTURE.md` §Localization is built entirely on the claim that identifiers
are insufficient.

That claim is testable, and this set is the test.

### Tiers, and what each one decides

| Tier | Cases | Decides |
|---|---|---|
| `lexical-id` | 6 | Control. Config 1 should already pass; failures mean the index is broken, not the design. |
| `lexical-name` | 15 | **The decision point.** Config 1 must fail, config 2 must pass. |
| `lexical-description` | 4 | Whether indexing descriptions earns its keep beyond names. |
| `semantic` | 5 | Headroom embeddings would buy. Failures here are expected, not bugs. |
| `disambiguation` | 3 | Whether ambiguous queries surface both senses instead of silently picking one. |
| `noise-rejection` | 3 | Whether real assets outrank the 244 `Prototype_`/`Debug_`/`Template_`/`Filter_`/`Test_` items. |

**Report per tier. Never as a single aggregate** — an aggregate is dominated by
`lexical-id`, which passes under every configuration, and would mask total failure
on `lexical-name`.

### The `overlap` field

Three `lexical-name` cases are marked `"overlap": "partial"`: the phrase shares a
token with the identifier, so config 1 can reach the right *family* without
localization and may land the answer in the top 5 by luck. They are weaker evidence.
**Score the 12 clean cases separately; the decision rests on those.**

This distinction was not designed in — it came out of measuring the set against the
corpus after writing it. One case, `"cave spider" → Spider_Cave`, turned out to
share *both* tokens with its identifier and was moved to `lexical-id` entirely. It
is `01-VISION.md`'s own motivating example, and as a localization test it was
worthless: it would have shown configs 1 and 2 as equivalent. That is precisely the
failure `09-EVALUATION.md` warns about, and it survived until the numbers were run.

---

## Ground truth

Verified 2026-07-27 against `Server/Languages/en-US/server.lang`, release
patchline. All 53 referenced asset IDs resolve; all quoted display strings match
exactly.

**Re-verify before trusting a run on a new patchline.** Hytale is in Early Access
and asset IDs may be renamed (`../init/OPEN-QUESTIONS.md` Q13). The check is
mechanical: every `expected_any` / `expected_also` / `must_not_rank_first` entry
must resolve to an `items.<id>.name` or `npcRoles.<id>.name` key, and every
`display` must equal that key's value. Fold this into the harness once the indexer
can read the archive.

---

## Legal note

This file set names ~40 public asset identifiers and quotes short display strings
as test fixtures — the minimum needed to state an expected answer. That is not
redistribution of the corpus under EULA v2.2 §3.3 (`../init/02-DOMAIN.md` §Legal).

**Do not let it grow into an asset listing.** Generated schemas, extracted corpora
and index artifacts belong in `local/`, which is gitignored.
