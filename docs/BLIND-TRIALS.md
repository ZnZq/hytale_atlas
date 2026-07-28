# Blind trials

How to run agents that try to solve a real modding task with the tool and report
what it can and cannot express.

The method exists because of one observation: **almost every defect this tool has
had was a sentence, not a computation.** `unused` meant "extraction never
looked", not "the game does not use it". A schema-search miss was reported as
proof when it was evidence. `bench Builders` printed "200 craftable here" — its
own display limit — while the table one screen earlier said 911.

None of those are visible to the person who wrote them, because the author reads
the sentence as they meant it. They are immediately visible to a reader who knows
nothing and has to act on the answer.

---

## Two reviewers, and when each stops paying

| | Black-box trial | White-box critic |
|---|---|---|
| Sees | only the compiled CLI | source **and** the SQLite index |
| Finds | false and misreadable statements, dead ends, missing capability | data present but unsurfaced, counts measuring the wrong set, api/CLI drift |
| Costs | ~15–20 min, ~120k tokens per agent | ~10–15 min, ~180k tokens |

Run black-box trials first. They tell you whether the tool answers the question a
user actually has. Once several rounds return mostly wording issues, **switch** —
the critic then finds a different class entirely: `search` denying 497 identifiers
that are in `assets` but not in `assets_fts`; `refs` filtering `dst_kind='asset'`
and hiding 33 782 file edges; `statsOp` returning a locale *count* the CLI had
already replaced with names.

Neither replaces the other. The critic cannot tell you that an answer is
unusable; the trial cannot tell you that a number counts the wrong rows.

---

## The loop

1. Wait for **every** agent to report.
2. Verify each finding against the tool. Agents are wrong sometimes — see below.
3. Fix the real ones.
4. Write a test per fix, naming the defect's history in a comment.
5. Rebuild `dist` and re-index if the schema version changed.
6. Freeze a new snapshot and launch the next round.
7. Return to 1.

**Never touch `src/` or `dist/` between step 6 and step 1.** One round was wasted
when an agent hit a half-written build and reported a raw Node crash as a tool
defect. The snapshot below exists to make that impossible, but the rule still
holds for the shared index.

Stop when a round returns no findings *and* reaches the verdict already
established. A changed verdict is a result, not a failure: round 15 overturned
"3×3 is not expressible" by finding `SelectInteraction.HitBlock` and proving it
against `Tool_Sickle_Copper`.

---

## The frozen snapshot

Agents must run a build that cannot change under them.

```bash
rm -rf local/rounds/roundN && mkdir -p local/rounds/roundN/docs/evaluation
cp -r dist local/rounds/roundN/dist
cp package.json local/rounds/roundN/
cp docs/evaluation/search-phrases.json local/rounds/roundN/docs/evaluation/
node local/rounds/roundN/dist/cli/main.js status   # confirm it runs
```

`local/` is gitignored, which matters: no Hytale-derived data may enter the
repository (EULA v2.2 §3.3).

**Tell the agent to run from the snapshot root.** `eval` resolves its phrase
set relative to the working directory, so from anywhere else it dies with a raw
`ENOENT` naming a path under the agent's cwd — verified, exit code 1. It works
from the repository root only because the same file exists there, which makes
the dependency easy to miss when you test it yourself.

**The trap.** The snapshot pins the *code*, not the *index*. The database is
chosen by `SCHEMA_VERSION`, so bumping it makes an old snapshot read an older
database — silently, with no error. Measured on this repository:

```
$ node local/rounds/round17/dist/cli/main.js describe Item --field Consumable
/Consumable   boolean   inherits                 # v15 index, pre-fix
$ node dist/cli/main.js describe Item --field Consumable
/Consumable   boolean   inherits default false   # v16 index
```

An agent given a stale snapshot will faithfully report defects that are already
fixed. Re-freeze after every schema bump, and check the version in `status`
before launching.

---

## The prompt

Every trial prompt needs six things. Dropping any one of them has produced a
useless report at least once.

1. **The tool path and nothing else.** `node C:/.../roundN/dist/cli/main.js`.
2. **A hard read-only rule**: do not read `src/`, do not read `dist/*.js`, do not
   open the game's files, do not search the web, modify nothing. Without this the
   agent reads the source and stops being blind.
3. **A real task in a modder's words** — not "test the search command".
4. **Separate stdout from stderr.** Several notes are deliberately on stderr so
   piped output stays machine-readable. A harness that merges them reported
   `--raw` as emitting notes into JSON; it does not, and I nearly "fixed" a
   non-bug.
5. **What counts as a defect**, enumerated: false statements; true-but-misreadable
   ones, especially anything reading as "this does not exist in the game" when it
   means "my index does not cover this"; commands that contradict each other;
   suggested next commands that do not work — **including pairs that forward to
   each other in a loop**; numbers that do not reconcile, especially a count equal
   to a display limit; and what was needed and unavailable.
6. **A fixed final format**, so rounds are comparable:

```
VERDICT: fully answerable | partly answerable — <what is missing> | not answerable — <why>
DEFECTS: none | <numbered list>
```

Require the exact command and the exact output line for every claim. Say
explicitly: *"none" means you actively tried to break it and could not.*

From round 16 on, add: **report only genuinely real problems** — verify before
claiming, and do not re-report anything already fixed. List the known-fixed items
by name. Report volume dropped and signal rose.

---

## Scenarios

Five, run in parallel, chosen to exercise different joins rather than different
commands.

| Scenario | Exercises |
|---|---|
| A new pickaxe: faster than iron, craftable at a workbench, better on ore | tool specs, recipes, bench ids, the `gather-type` value link |
| A new plant: growth stages, farmland-only, own fruit and seeds | `$ref` crossings, unions with discriminators, **inheritance** |
| A sword that burns on hit, named in every language | interaction chains, `EntityEffect`, localization roots |
| A hammer that breaks 3×3 | a deliberately hard question with no obvious answer |
| A new bench plus its block, sounds, particles, hardness | the four-way id confusion, bench declarations |

**Keep the negative one.** Its value is not the answer but the failure mode: a
tool that lets you conclude "impossible" from a limitation of its own index is
worse than one that says nothing. It is also where a wrong *yes* is easiest —
round 16 correctly landed on "possible, but the volume is player-anchored, never
a grid-aligned 3×3".

Give each scenario one extra adversarial instruction rather than the same
boilerplate: *reproduce every count a second way*; *check every `--help` claim one
by one*; *verify what the tool says about inheritance against the parent it
names*; *is each marker and column explained anywhere*.

---

## Reading the reports

**Verify before fixing.** Three examples from this project:

- `--raw` "pollutes stdout" — an artifact of the reporter's harness merging
  stderr. stdout is clean JSON.
- `describe common:DeployableAoeConfig --field DamageCause` shows another field's
  description — real, but it is **the game's schema** that carries the duplicate
  text. Nothing to fix here; worth recording.
- "849 of 17 400 fields carry `hytaleAssetRef`" in our own docs — neither number
  matched the index. The doc was stale, and chasing it surfaced a real bug
  (`Q22`).

**Watch for a fix that is right in its case and wrong beside it.** Four of the
regressions in this project were exactly that: the separator fix stopped shredding
two sentences and started shredding one value containing a space; the
contradiction filter fixed an overcount and deleted a real edge. Prefer a test on
the *invariant* over a test on the symptom.

**A report that believes the tool is the strongest signal of all.** One agent
wrote into its modding advice: "Quality and Recipe must be re-declared in your own
file — they never come from the parent." That was the tool stating a rule the data
did not support, and it became a false statement in someone else's answer.

---

## What it costs and what it caught

Five agents per round, ~120k tokens each. Rounds 13–16 completed black-box;
round 17 was launched and its five agents all died on a session rate limit,
which is worth planning for — a round is ~600k tokens of subagent traffic in a
few minutes. After that, two white-box critic rounds and two verification
passes.

The class of defect only a blind reader finds:

- `bench Builders` reporting its own limit as the total, contradicting a table one
  screen away — found by four agents independently
- `search X --type Bogus` answering "No asset is named X, in any indexed locale" —
  found by five
- `refs` and `search` forwarding to each other on a miss with no exit — reported
  by four of the five agents in one round
- `get` merging inheritance at the top level only, so every plant read as having
  no farmland restriction and nothing to make it grow

None of these is a crash, a type error or a failing test. Every one of them is a
sentence that is not true.
