# 09 — Evaluation

Added after review: the original document set had no way to tell whether the tool
works. Phase-level smoke tests answer "does it run", not "does it help".

Without this, there is no way to distinguish an index that genuinely improves agent
performance from one that produces plausible-looking output while the agent quietly
succeeds or fails for unrelated reasons.

---

## The claim under test

*An agent with this index answers Hytale content questions more accurately and with
fewer tokens than the same agent with filesystem access alone.*

Both halves matter, and accuracy matters more. An index that halves token use while
producing subtly wrong JSON is worse than no index.

Note that the baseline is **not** helpless: an agent with `grep` over an unpacked
`Assets.zip` can do a lot. Asset JSON is flat and string-keyed, so grep may perform
better here than it does on source code. Beating that baseline is the actual bar,
and it should not be assumed. See `01-VISION.md` §Value proposition.

---

## Method

Two arms, same agent, same prompts:

- **Baseline** — unpacked `Assets.zip` on disk, standard file tools, no index
- **Treatment** — the MCP index, no direct filesystem access to the corpus

Comparable work is a useful template here: codebase-memory-mcp evaluated across 31
repositories reporting answer quality, token counts, and tool-call counts
(`07-PRIOR-ART.md`). The same three axes apply.

---

## Metrics

**A note on the operating constraint.** `01-VISION.md` forbids the *tool* from
requiring a running game. That constraint does not extend to *evaluation* — running
the game to grade output is legitimate research, done by a person, once. But it
does mean the primary correctness metric cannot be automated or run in CI, so a
static proxy is needed for day-to-day work. Both are listed below; do not let the
proxy quietly replace the ground truth.

| Metric | How | Why |
|---|---|---|
| **Correctness** (ground truth) | Generated pack loads in-game without error | The only metric that fully matters. Manual, occasional, not automatable |
| **Correctness** (static proxy) | Generated pack passes the engine's own validators, run from the JAR | Automatable and CI-able. Only as good as `OPEN-QUESTIONS.md` Q17 turns out to be — if engine validators can be invoked without a server, this proxy is very close to ground truth; if not, it degrades to schema conformance |
| **Field accuracy** | Proportion of emitted fields present in the real schema | Catches invented fields, the characteristic failure |
| **Grounding** | Did it cite a real vanilla example? | Distinguishes retrieval from confabulation |
| **Tokens** | Total context consumed to answer | The efficiency claim |
| **Tool calls** | Count to first correct answer | Proxy for navigability |
| **Recall** | Did it find the relevant asset at all? | Directly tests search — see §Search |

---

## Task set

Aim for ~20 tasks. Write them **before** building, so the design is not tuned to
its own test. Cover each question family from `01-VISION.md`:

**Lookup** — "What is the ID of the item shown as *Iron Sword*?" · "Which asset
types exist?" · "What does the vanilla torch definition contain?"

**Idiom** — "How does vanilla make an item that deals fire damage?" · "How is a
loot table attached to a mob?" · "How does a block specify what tool breaks it?"

**Schema** — "What fields can an item have?" · "What values does the rarity field
accept?" · "Is this field required?"

**Impact** — "What breaks if I override this block?" · "What must my pack include
for this entity to load?" · "Which assets reference this model?"

**Authoring** — "Make a sword that sets enemies on fire and drops from cave
spiders" · "Add a block that drops three of a custom item" (end-to-end, graded by
whether it loads)

**Diagnosis** — given a deliberately broken pack: "Why doesn't this load?"

---

## Search evaluation (separate, and do it first)

Search quality is the single largest identified risk (`01-VISION.md` §Risk
register), and it can be tested before any MCP work exists.

Build a set of ~30 pairs of *natural-language phrase* → *expected asset ID*, drawn
from how a real creator would speak: "cave spider", "iron pickaxe", "flaming sword",
"the blue flowers", "torch".

Then measure recall@5 under three configurations:

1. FTS over identifiers only
2. FTS over identifiers **plus localized strings**
3. Plus embeddings, if 2 proves insufficient

**This experiment is cheap and decisive.** If configuration 2 does not clear a
useful bar, the design needs semantic search and the roadmap changes. Run it in
Phase 1, not later.

**Phase 0 established that the data configuration 2 needs exists**
(`OPEN-QUESTIONS.md` Q14): explicit `TranslationProperties.Name` references, 99.9 %
item coverage, 5 locales. It did **not** establish that configuration 2 *performs*.
Those are different claims and only the first is settled — still run the
experiment.

Draw the phrase set from display names that **diverge from their identifiers**, not
just ones that match. `items.Armor_Adamantite_Chest.name` = *"Adamantite Cuirass"*
is the case that separates configurations 1 and 2; a phrase set full of items whose
name is a spaced-out version of their ID will show the two configurations as
falsely equivalent.

Add a fourth configuration once Phase 2 lands: **identifiers + localized strings +
extracted schema `description` prose**. The codec ships human-readable field
documentation, which is more natural-language content to match against, and it is
free once extraction exists.

---

## Regression testing

Independent of agent evaluation, and cheaper to run:

- **Golden index** — index a fixed small pack, snapshot node and edge counts, assert
  stability across changes
- **Incremental equivalence** — full reindex and incremental reindex of the same
  state must produce identical graphs. This is the property most likely to break
  silently, and the candidate-promotion and dangling-demotion logic
  (`03-ARCHITECTURE.md`) is where it will break.
- **Resolver precision** — hand-label reference edges in a small sample; track
  false-positive rate by confidence tier. The `Stone` / `Default` / `None` collision
  problem needs a number attached to it, not a shrug.
- **Schema coverage** — proportion of asset types with an extracted codec; report in
  `status()`

---

## When to run what

Phase numbering follows `08-ROADMAP.md` as revised after Phase 0 — codec extraction
is now Phase 2 and schema statistics Phase 3.

| Phase | Evaluation |
|---|---|
| 1 | Search evaluation (§Search). Golden index. |
| 2 | Schema tasks. Plus the schema-only-fields experiment from `05-CODEC-EXTRACTION.md`. |
| 3 | Lookup + idiom tasks, both arms |
| 4 | Impact + diagnosis tasks |
| 5 | Incremental equivalence under live editing |

---

## Honest reporting

If the index does not beat grep on some task family, say so in the README. A tool
that is precise about where it helps earns more trust than one claiming uniform
improvement — and it directs effort at the parts that are actually weak.

Record baseline numbers before optimising anything. Retrofitting a baseline after
the fact is not possible.
