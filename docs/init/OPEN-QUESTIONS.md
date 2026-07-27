# OPEN QUESTIONS

Everything here is unverified. Several items are load-bearing for the architecture.

**Working agreement:** when a blocker is hit during implementation, append it here
with enough context to be actionable, and continue with the next unblocked task.
Do not pause to ask. When a question is answered, record the answer inline, mark it
`RESOLVED`, and update the affected design document in the same change.

Questions are ordered by how much of the design depends on them.

---

## Q1 — What exactly is Hytale's "Codec system"? 🔴 BLOCKING

**Why it matters:** `05-CODEC-EXTRACTION.md` assumes DataFixerUpper-style codecs
and chooses runtime reflection on that basis. If codecs are a bespoke abstraction —
or if serialization is annotation-driven or hand-written — the extraction approach
changes completely, and tier 2 may need a different strategy or may be infeasible.

**How to check:** open `HytaleServer.jar`, find
`com.hypixel.hytale.server.core.asset.type.item.config.Item`, and look at how its
codec (or serializer) is declared.

**Specifically determine:**
- Is there a static `Codec` field, or annotations, or a hand-written reader?
- Are field names string literals in `<clinit>`, or something else?
- Is the codec object reflectively walkable once constructed?
- Do defaults and optionality survive into the runtime object?
- Is there a shared base or registry that enumerates all codecs?

**Answer:**

---

## Q2 — Does the client installation include `HytaleServer.jar`? 🔴 HIGH IMPACT

**Why it matters:** singleplayer connects to a local server, so the client plausibly
ships one. If it does, tier 2 is available to **pack authors** — the primary
audience — not just plugin developers. That roughly doubles the tool's value for the
people who need it most and would justify moving Phase 3 earlier
(`08-ROADMAP.md`).

**How to check:** search the client install directory for `HytaleServer.jar` or any
server JAR. Five minutes.

**Also determine:** its path relative to `Assets.zip`, and whether it is the same
artifact as the dedicated-server JAR.

**Answer:**

---

## Q3 — Pack layout: `Common/` + `Server/`, or `assets/<type>/`?

**Why it matters:** the indexer's path-to-asset-type mapping depends on it entirely.

**Conflict:** CurseForge and official docs describe `Common/` (models, textures) and
`Server/` (definitions, translations, particles). A community documentation site
describes plugin-embedded packs as `manifest.json` plus `assets/` with per-type
subdirectories (`blocktype/`, `item/`, `model/`, `soundevent/`, `soundset/`,
`particle/`, `weather/`, `entity/`, `entityeffect/`, `environment/`). See
`02-DOMAIN.md` §Conflicting account.

**Hypotheses:** different nesting levels of the same tree; one is outdated;
standalone and plugin-embedded packs genuinely differ.

**How to check:** open `Assets.zip` and look. Then compare against a plugin JAR
built from a template with `IncludesAssetPack: true`.

**Answer:**

---

## Q4 — What is the actual internal structure of `Assets.zip`?

Needed for pass 1 and for the type discovery strategy.

- Full directory tree, at least two levels deep
- Are asset type directories named the same as the JAR's `asset.type` subpackages?
- One asset per file, or multiple per file?
- Are IDs namespaced in the file (`Hytale:Foo`) or derived from the path?
- How do JSON files reference `.blockymodel` and `.png` — by path, by ID, with or
  without extension?
- What non-JSON file types are present, and in what proportion?
- Actual uncompressed size and file count (drives performance budgets)
- Are there any non-asset entries — indexes, manifests, precomputed data?

**Answer:**

---

## Q5 — How does the engine resolve priority between packs?

**Why it matters:** `is_effective` on `Asset` nodes, and therefore `diff_override`
and `find_conflicts`, depend on getting this right.

Known: `FileIO` provides a multi-root virtual filesystem where mod assets overlay
base assets. A community loader library sorts external packs by filename, but that
is that library's own convention, not necessarily the engine's.

**Determine:** is order defined by load order, manifest, alphabetical, world config,
or something else? Is it configurable? What happens on a genuine conflict — last
wins silently, or is there a warning? Is there a deep-merge, or is override
whole-asset?

The last sub-question matters a lot: whole-asset replacement and field-level merge
produce very different `diff_override` semantics.

**Answer:**

---

## Q6 — Game install paths per operating system

Needed for autodetection (`06-CLI-UX.md`).

Known: launcher → Settings → Open Directory leads to
`<install>/release/package/game/latest`, and user data is at
`%AppData%/Roaming/Hytale/UserData/`.

**Determine:** the install root on Windows (`%LocalAppData%`? `%AppData%`? Program
Files?), on macOS, and on Linux. Whether the launcher records the path somewhere
readable. Whether patchlines produce sibling directories.

**Answer:**

---

## Q7 — Does the Asset Editor write files in a watcher-hostile way?

**Why it matters:** write-race handling in `03-ARCHITECTURE.md`.

**Determine:** does it write in place or temp-then-rename? Does it rewrite whole
directories on save? Does it touch files it did not change? Does it hot-reload from
disk, so external edits are visible in-game?

If it does hot-reload, the loop closes completely: agent writes → index sees →
validates → game picks it up. Worth confirming, since it is a strong selling point.

**Answer:**

---

## Q8 — How are ECS component types registered and discovered?

The hardest part of codec extraction (`05-CODEC-EXTRACTION.md` §Polymorphic
components).

- Is there a central registry mapping component name → class?
- Is registration declarative or imperative?
- Can plugins register components at runtime — and if so, is a static-only
  extraction inherently incomplete?
- Do component blocks in JSON use dynamic keys? (Drives the record-vs-map decision
  in schema inference.)

**Answer:**

---

## Q9 — Is `/assets` output parseable for cross-validation?

`/assets` queries loaded resources and `/packs` lists active content packs. If
either produces structured output, it becomes a way to verify the index against
what the game actually loaded — a strong correctness check.

**Determine:** output format, whether it can be run headless or scripted, whether
it exposes resolved priority (which would answer Q5 empirically).

**Answer:**

---

## Q10 — What do Hytale's policies say about automated JAR analysis? 🔴 PHASE 0

**Why it matters:** distribution and publishing. This is the only question here that
can invalidate the entire project, which is why it belongs in the verification phase
rather than at publication time. Answering it after building would be the wrong
order.

Community projects decline to redistribute Hytale binaries and place EULA
responsibility on the user. The design already assumes local-only extraction and no
bundled game data (`02-DOMAIN.md` §Legal).

**Determine:** whether official server policy or EULA pages restrict automated
analysis or decompilation beyond that; whether "not obfuscated, freely
decompilable" is an official statement or a community observation; whether tools
that read the JAR locally are explicitly permitted.

**Answer:**

---

## Q11 — Practical corpus statistics

Needed to size the implementation. Cheap to gather once Q4 is answered.

- Asset count by type
- Median and p99 asset JSON size (drives elision thresholds)
- Reference density — average outgoing references per asset
- How many distinct string values collide with asset IDs by accident? (Estimates
  the low-confidence noise floor)
- Field count per type, and long-tail distribution

**Answer:**

---

## Q12 — Is `.blockymodel` worth parsing?

Currently treated as an opaque `File` node. If it internally references textures or
animations, parsing it would add real edges to the graph.

**Determine:** is the format documented or reverse-engineered anywhere? Does the
Blockbench plugin reveal its structure? Does it contain texture references?

Low priority — do not block on it.

**Answer:**

---

## Q13 — How stable are asset IDs across patchlines?

If IDs are renamed between versions, `whats_changed` and any future cross-version
diffing need rename detection rather than add/remove pairs. Cannot be answered until
a patch lands. Note it and move on.

**Answer:**

---

## Q14 — How does localization work? 🔴 PHASE 0

**Why it matters:** this determines whether search works at all. Asset identifiers
are machine names (`Sword_Iron`); users search in prose ("flaming sword"). The only
natural-language content in the corpus is in translation files, which makes them the
bridge between intent and identifier. See `03-ARCHITECTURE.md` §Localization.

If localization turns out to be sparse, absent, or structured in a way that cannot
be joined to assets, the tool needs embeddings — a different dependency footprint
and a different storage design. Better to know in Phase 0.

**Determine:**
- File format and location. `Server/` is documented as holding translations, but the
  format is unknown — JSON? key-value? one file per locale?
- How does an asset reference its display name? An explicit field, or a convention
  derived from the asset ID (`item.Sword_Iron.name`)? If conventional, the edge is
  *derived* and should carry lower confidence.
- Which roles exist beyond name — description, flavour text, tooltips?
- How many locales ship, and is English reliably complete?
- What proportion of vanilla assets actually have localization entries? (Determines
  how much of the corpus is reachable by natural-language search.)
- Do lang files support any nesting or interpolation that complicates parsing?

**Answer:**

---

## Q15 — Are schema-only fields actually usable? 🟡 PRODUCT-DEFINING

**Why it matters:** `find_undocumented` is the intended differentiator
(`01-VISION.md` criterion 6), and it rests on an untested assumption — that a field
present in the codec but absent from vanilla is a usable capability.

It might instead be deprecated, engine-internal, populated programmatically rather
than from JSON, or a debug hook. If most are noise, the feature survives but its
framing and its position in the pitch both change.

**How to check:** once tier 2 extraction works, take three schema-only fields, put
them in a real pack, load the game, observe. About an hour.

**Determine:** what proportion appear to have real effect; whether there is a
detectable marker (annotation, naming convention, package) separating live fields
from dead ones — if there is, filter on it and the feature becomes solid.

**Answer:**

---

## Q16 — How is `logical_id` correctly derived?

**Why it matters:** it is the key that groups an asset with the definitions it
overrides. Getting it wrong makes every override relationship in the graph wrong,
and wrong *silently* — nothing will crash, the answers will just be incorrect.

Depends on Q4. Candidates: path-derived (`<type>:<basename>`) or content-derived
(explicit `Id` field, possibly namespaced). The vanilla pack is addressable as
`Hytale:Hytale` in the Asset Editor, suggesting pack-group namespacing exists at some
level.

**Determine:** where identity actually lives; whether it is namespaced; whether two
files at different paths can share an identity; case sensitivity; what the engine
does with a collision inside a single pack.

**Answer:**

---

## Newly discovered blockers

*(append below during implementation)*
