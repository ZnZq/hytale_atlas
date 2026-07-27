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

**60 cases in eleven tiers.**

| Tier | Cases | Decides |
|---|---|---|
| `lexical-id` | 6 | Control. Config 1 should already pass; failures mean the index is broken, not the design. |
| `lexical-name` | 15 | **The decision point.** Config 1 must fail, config 2 must pass. |
| `lexical-description` | 4 | Whether indexing descriptions earns its keep beyond names. |
| `semantic` | 5 | Headroom embeddings would buy. Failures here are expected, not bugs. |
| `disambiguation` | 3 | Whether ambiguous queries surface both senses instead of silently picking one. |
| `noise-rejection` | 3 | Whether real assets outrank the 244 `Prototype_`/`Debug_`/`Template_`/`Filter_`/`Test_` items. |
| `locale-cyrillic` | 7 | Baseline that Ukrainian and Russian are indexed at all. |
| `locale-cjk` | 5 | Chinese, including **infix** — the noun is usually at the end of a compound. |
| `inflection` | 6 | Full inflected Slavic forms, as users actually type them. |
| `orthography` | 1 | Ukrainian Ґ, which users type as г. |
| `cross-locale` | 5 | One asset reachable through every shipped language. |

### The non-English tiers are not decoration

Each was added because a measurement failed, not because coverage looked thin:

- **`locale-cjk` infix.** `蜘蛛` ("spider") is the trailing half of `洞穴蜘蛛`
  ("cave spider"). `unicode61` treats an ideograph run as one token, so prefix
  indexing reaches leading substrings only — this returned **nothing** until
  `normalizeSearchText()` began segmenting ideographs. `trigram` was tried as an
  alternative and is worse: no match at all for two-character words.
- **`inflection`.** `кірасу` (accusative) is *not* a prefix of `кіраса` — they
  diverge at the final letter — so FTS5 prefix matching cannot reach it. This case
  disproved an earlier claim in the design that prefix indexing "substitutes for
  the stemmer Cyrillic does not have". It does not; progressive suffix trimming
  does.
- **`orthography`.** The corpus spells it `Ґоблінський` (U+0490); users type
  `гоблінський`. These are separate Cyrillic letters, not diacritic variants, so
  `remove_diacritics` leaves them apart.

An English-only set passes all three of those situations without ever exercising
them. That is why the multi-locale tiers exist, and why they should be run
separately rather than folded into an average.

### Coverage note

`en-US` carries 4 320 item and NPC names; the other four locales carry 4 033–4 034.
**287 names are English-only** — roughly 6.6 % of the corpus is unreachable by a
non-English query no matter how good search is. Report that as a ceiling rather
than counting it against the retrieval score.

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

Verified 2026-07-27 against `Server/Languages/<locale>/server.lang` for all five
shipped locales, release patchline. All 77 referenced asset IDs resolve, and every
quoted display string matches its declared locale exactly — checked
programmatically, not by eye.

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
