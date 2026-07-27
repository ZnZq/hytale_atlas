# 03 — Architecture

## Governing principle

**Never hardcode the schema.** Hytale is in Early Access; any assumption of the
form "field `Model` points at a model asset" will rot within a release cycle. The
schema comes from two places, both derived at index time:

1. The server JAR's codecs — authoritative, complete (see `05-CODEC-EXTRACTION.md`)
2. The vanilla corpus — idiomatic, incomplete, but always available

Everything the tool asserts about structure must trace to one of these.

**Second principle: static sources only.** The tool never runs the game, never
starts a server, and never talks to one. Its whole input surface is
`HytaleServer.jar`, `Assets.zip`, pack directories, and launcher metadata. See
`01-VISION.md` §Operating constraint.

This is load-bearing architecturally, not just a scoping preference. It means the
index is reproducible from files alone, works on a machine where the game has never
been launched, works in CI, and cannot be blocked by a game that will not start.
When a design question looks like it needs runtime observation, **read the JAR** —
that is where the behaviour is defined, and it is authoritative in a way that
observing one session is not.

---

## Two layers

The vanilla archive and the working pack have completely different change
profiles: vanilla changes once per patch, the working pack changes every few
seconds. Treating them the same is the primary performance mistake to avoid.

### Frozen layer

Vanilla `Assets.zip` plus any third-party packs supplied as archives, plus the
extracted codec schema.

- Indexed once, keyed by content hash of the source artifacts
- Stored in a **global** cache, shared across all of the user's projects
- Read-only at query time
- Never re-scanned in response to filesystem events

### Hot layer

The user's own pack or plugin, as a directory tree.

- Rebuilt per-file, incrementally
- Stored per-project
- The only layer a filesystem watcher observes

### The join

The resolver runs against the **union symbol table** of both layers but may only
write into hot. This guarantees that re-indexing a single edited file can never
touch the hundreds of megabytes of frozen data, and that the expensive frozen work
is amortised across every project on the machine.

---

## Graph model

### Nodes

| Node | Meaning |
|---|---|
| `Pack` | A manifest-bearing unit: vanilla, third-party, or the user's own |
| `Asset` | One physical definition, in one pack. Not a logical identity. |
| `File` | A non-JSON resource: `.blockymodel`, `.png`, audio, `.ui` |
| `LangKey` | A localization key and its translated strings. **See §Localization.** |
| `AssetType` | `item`, `blocktype`, `entity`, `particle`, … — discovered, not enumerated |
| `FieldPath` | A JSON pointer observed across the corpus, with aggregate statistics |
| `CodecSchema` / `SchemaField` | Extracted from the JAR — see `05-CODEC-EXTRACTION.md` |

**`Asset` is per-pack, not per-ID.** Two packs defining `Sword_Iron` produce two
`Asset` nodes. The logical identity is a *group*, and exactly one member carries
`is_effective = true` according to load priority. This makes the overlay semantics
a first-class queryable fact rather than a side effect, which is what lets
`diff_override` and conflict detection work at all.

### Deriving `logical_id` — RESOLVED

**`logical_id = <asset_type>:<basename without extension>`. Identity is
path-derived; it is not carried in the file.** (`OPEN-QUESTIONS.md` Q16, verified
2026-07-27.)

Evidence: `Server/Item/Items/Rock/Magma/Rock_Magma_Cooled_Brick_Decorative.json`
contains no `Id` field, and its localization key is
`server.items.Rock_Magma_Cooled_Brick_Decorative.name` — the basename exactly, with
**no path segments**. Organisational nesting is therefore *not* part of identity.
`AssetStore<String, Item, …>` independently keys assets by plain `String`, and
references in real assets are bare basenames (`"Parent": "Rock_Magma_Cooled_Brick"`).

Two cautions:

- **`<asset_type>` is the hard half.** It cannot be taken from directory depth: a
  second-level directory is not a type (`Server/Item` contains 14 unrelated
  third-level groupings), and the JAR's 39 asset-type subpackages do not map
  cleanly onto the archive's 51 directories. Resolve type from the codec registry
  and surface disagreements rather than guessing. See `OPEN-QUESTIONS.md` Q4.
- Pack namespacing (`Hytale:Hytale`) is `Group:Name` from the manifest and
  identifies the **pack**, not the asset. No namespaced *asset* reference was
  observed in vanilla.

Still unverified and worth testing before Phase 4: case sensitivity, and what the
engine does when two files in one pack share a basename.

Implement it as a single documented function with the rule stated in one place, so
that changing it later is a one-line change rather than a hunt.

### Inheritance — `Parent`

**Asset definitions are not self-contained.** Real assets declare
`"Parent": "<other asset id>"`, and the codec layer has `InheritCodec`,
`RawJsonInheritCodec`, and `Schema.hytaleParent` (`InheritSettings`) to match.
See `OPEN-QUESTIONS.md` **Q18**, which is still open on merge semantics.

Three parts of this design are affected, and two of them are in Phase 1:

1. **`get_asset` must resolve the parent chain.** `04-MCP-SURFACE.md` specifies it
   returns the "full effective JSON definition". Returning the raw file would be
   actively misleading — the agent would see a partial definition and conclude
   fields are absent that the game will happily supply.
2. **Pass 3 will undercount** if it aggregates raw files, because inherited fields
   never appear in the child document. Field statistics must be computed over
   *resolved* assets, or explicitly labelled as raw-occurrence counts.
3. **`INHERITS_FROM` is a distinct edge from `OVERRIDES`.** Inheritance is
   intra-corpus, explicit, and by asset ID. Overriding is cross-pack and by
   identity. Conflating them produces wrong impact analysis in both directions.

It likely interacts with Q5 (cross-pack priority): if pack override uses the same
merge machinery, both problems share one implementation.

### Edges

| Edge | From → To | Properties |
|---|---|---|
| `DEFINED_IN` | Asset → Pack | |
| `OVERRIDES` | Asset → Asset | same logical ID, lower priority |
| `INHERITS_FROM` | Asset → Asset | from `Parent`; intra-corpus, explicit. **Not** the same as `OVERRIDES` — see §Inheritance |
| `REFERENCES` | Asset → Asset | `json_pointer`, `confidence` |
| `REFERENCES_FILE` | Asset → File | `json_pointer`, `confidence` |
| `LOCALIZED_BY` | Asset → LangKey | `json_pointer`, `role` (name/description/…) |
| `INSTANCE_OF` | Asset → AssetType | |
| `DEPENDS_ON` | Pack → Pack | from manifest `Dependencies` |
| `VALIDATES` | CodecSchema → AssetType | |

**`json_pointer` on the reference edge is the most important property in the
model.** It is what makes schema inference possible (aggregate pointers across the
corpus), what joins corpus data to extracted codec schema (`SchemaField.pointer`
is the same key), and what lets the agent be told *where* in the JSON a
relationship lives rather than merely that it exists.

### Confidence

Reference detection is heuristic wherever codec schema is unavailable. This is
standard practice, not a compromise: Unity's dependency system resolves GUIDs as
hard dependencies but treats filename matches as *weak* links explicitly flagged
as possible false positives (see `07-PRIOR-ART.md`).

Confidence tiers:

- **High** — the field is covered by extracted schema and typed as a reference.
  Not a heuristic at all. **This tier is narrower than an earlier revision of this
  document claimed.** The generated schema does *not* mark reference targets
  machine-readably: known reference fields emerge as bare
  `{"type": ["string","null"]}`, and `hytale.type` is a JSON-type marker, not a
  pointer to an asset type (`OPEN-QUESTIONS.md` Q17, `05-CODEC-EXTRACTION.md`
  §What it does NOT give us). What *is* available: `hytale.uiEditorComponent`
  (259 fields, naming the editor picker and sometimes a path template), `$ref`
  structure for nested objects, and descriptions that occasionally name the target
  in prose. **Plan for this tier covering a minority of string fields, not most of
  them** — the tiers below carry the weight.
- **Medium** — a fully qualified, namespaced ID string matching a known asset
- **Low** — a bare short string that happens to collide with a known ID
  (`Stone`, `Default`, `None` will generate noise)

Filter by confidence at query time. Do not discard low-confidence edges at index
time — they are needed for the "did I mean this?" case, and the codec schema may
promote them later.

---

## Localization — the natural-language layer

**This is load-bearing, not a detail.** It was nearly omitted from an earlier draft
of this design, and the omission would have broken the tool's primary use case.

### The problem it solves

Asset identifiers are machine names: `Sword_Iron`, `Armor_Bronze_Chest`. Asset JSON
is unlikely to contain prose. A user asking *"how do I make a sword that sets things
on fire"* produces query terms that appear **nowhere** in the identifier space.

Full-text search over IDs works for code-graph tools because function names are
descriptive (`calculateShippingCost`). It does not work here.

The natural-language content of a Hytale corpus lives in exactly one place: the
translation files under `Server/`. Display names, descriptions, and flavour text
are all there. That makes localization data the **join between human intent and
machine identifiers**, and it must be a first-class part of the graph rather than
an opaque file blob.

### Model

- Parse localization files into `LangKey` nodes: key, locale, string value
- Create `LOCALIZED_BY` edges from assets to the keys they reference, recording
  which field the reference came from (`role`)
- Index the **string values** into the FTS table alongside asset IDs
- Where an asset resolves to a display name, carry that name in every summary
  result, so the agent sees `Sword_Iron ("Iron Sword")` rather than a bare ID

### Consequences

1. `search_assets("flaming sword")` matches against real prose and works.
2. Summaries become legible to both agent and human at no extra token cost.
3. `validate_pack` gains a genuinely common real-world check: **an asset with no
   localization entry**, which ships as a raw identifier shown to players. This is
   one of the most frequent beginner mistakes in any modding ecosystem.
4. Reverse lookup becomes possible: "which asset is called *Torch* in game?"

### Verified — Q14 RESOLVED

Measured 2026-07-27. **This section's premise held, and the mechanics are better
than assumed. Embeddings are not needed.**

- **Format:** `.lang`, `key = value`, `#` comments, `# === section ===` headers.
  121 files, five shipped locales (`en-US`, `pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`),
  plus `fallback.lang` mapping ~50 regional variants onto base locales.
- **The reference is explicit**, via a real field:
  `"TranslationProperties": { "Name": "server.items.Sword_Iron.name" }`.
  So `LOCALIZED_BY` is **observed and high-confidence** — the derived,
  lower-confidence fallback contemplated above is unnecessary.
- **Coverage is 99.9 %** for items: 3 637 of 3 641 definitions carry
  `TranslationProperties.Name`. Roles: `name`, `description`, `nameFull`.
- **The payoff is demonstrable.** `items.Armor_Adamantite_Chest.name` resolves to
  *"Adamantite Cuirass"*. The identifier says `Chest`; the player sees *Cuirass*.
  Identifier-only FTS cannot answer a search for "cuirass". This is the design's
  central claim, confirmed on real data rather than argued.

**Implementation traps, both real:**

1. **Root-prefix rewriting.** The reference reads `server.items.<Id>.name`; the key
   stored in the file is `items.<Id>.name`. The `server.` prefix corresponds to the
   `Server/` root the lang file lives under. A literal join returns **zero** matches
   corpus-wide — the first verification scan made exactly this mistake and briefly
   concluded item localization did not exist. Derive and strip the root prefix.
   Assume `Common/Languages/…` behaves symmetrically under `common.`; verify.
2. **The format is not `key=value` line-splitting.** It supports multi-line
   continuation via trailing `\`, and **ICU MessageFormat** with nested plural
   forms (`other {{count, number} blocks}}`). Parse with brace counting, not a
   regex. 810 of 9 971 en-US values contain interpolation.

**Keep this in the first indexing pass**, as originally specified — search quality
depends on it and search is the entry point to everything else.

---

## Indexing: three passes

### Pass 1 — symbol table

Walk every archive and directory. Collect the set of all asset IDs and all file
paths. **Resolve nothing.**

Cheap, and it makes pass 2 a lookup rather than a search.

### Pass 2 — candidate extraction

For each JSON document, walk it recursively. For every string scalar, record a
**candidate**: `(source_asset, json_pointer, raw_value)`.

Attempt to match `raw_value` against the symbol table, applying normalisation:
case, extension, namespace prefix, path separators. A match materialises a
`REFERENCES` edge with the pointer and a confidence tier.

**Non-matches are persisted, not discarded.** The unresolved-candidate table is
the mechanism that makes everything else incremental. See §Incremental below.

### Pass 3 — schema inference (derived)

Aggregate the pointers collected in pass 2 across the whole corpus. For each
`(AssetType, json_pointer)` produce:

- occurrence count and total instances of that type → de facto optionality
- observed value types
- observed target asset types, where the value resolved to a reference
- distinct value cardinality → enum candidacy

The output answers "how is this normally done" with evidence, not assertion.

**Library notes** (see `07-PRIOR-ART.md` for detail):

- GenSON merges schemas across many objects, which is exactly this shape of work,
  but it **never infers enums on its own** — enum capture must be activated per
  node. Plan a cardinality pre-pass to decide where to enable it.
- Distinguishing a fixed-field record from a dynamic-key map is a known hard case
  with tunable thresholds. ECS component blocks are almost certainly dynamic-key
  maps; naive inference will explode every component name into a separate schema
  field. Handle this deliberately.
- Academic framing worth internalising: JSON schema inference traditionally aims
  at a schema *every document must validate against*, whereas RDF-style inference
  aims at *summarising a repository*. This tool needs both, and they are different
  artifacts. `describe_schema` is the summary; `validate_pack` is the constraint.
  **Do not merge them into one representation.**

---

## Storage

Use **SQLite** with an edge table and recursive CTEs for traversal.

The reasoning, and the honest tradeoff: the workload is tens to hundreds of
thousands of nodes, read-mostly after indexing, with queries typically 1–3 hops.
A real graph database buys little here and costs deployment complexity, which is
fatal for a tool whose whole premise is `npx` and go. Both serious comparable
projects (codegraph, codebase-memory-mcp) independently converged on SQLite for
precisely this reason.

If Cypher-style querying becomes genuinely necessary, **Kùzu** is embedded and
columnar and preserves the single-file property. Neo4j is the wrong shape for this
problem.

Schema sketch:

```
packs(id, name, group, version, path, kind, priority, source_hash)
assets(id PK, pack_id, logical_id, type, path, is_effective,
       content_hash, last_changed_epoch)
files(id PK, pack_id, path, kind, content_hash)
lang_keys(id PK, pack_id, key, locale, value)
edges(id PK, src, dst, kind, json_pointer, confidence, role)
candidates(id PK, asset_id, json_pointer, raw_value,
           resolved_edge_id NULL REFERENCES edges(id), dangling BOOL)
field_stats(asset_type, json_pointer, count, value_types, target_types, cardinality)
schema_fields(asset_type, json_pointer, declared_type, optional,
              default_value, enum_values)
meta(key, value)  -- global epoch, source hashes, tool version, patchline
```

**Epoch semantics.** There is exactly one monotonic counter, in `meta`. Bump it on
every drained change batch. `assets.last_changed_epoch` records the global epoch at
which that asset last changed — it is a *stamp*, not a second counter. This is what
lets `whats_changed(since)` be a single indexed range scan rather than a diff.

**FTS.** Index asset IDs, type names, and — critically — the **localized string
values** from `lang_keys`. See §Localization. FTS over identifiers alone will not
serve natural-language queries.

Indexes needed: `edges(src, kind)`, `edges(dst, kind)`,
`candidates(raw_value)` (drives candidate promotion on asset add),
`assets(logical_id)`, `assets(last_changed_epoch)`.

---

## Incremental updates

### The watcher does not parse

The filesystem watcher does exactly one thing: push the dirty path onto a queue
and bump an epoch counter. No parsing in the callback.

Parsing happens **lazily, at the start of MCP request handling**: drain the queue
before answering. This has two properties worth the design cost:

- The index is by construction current as of the moment of the response. There is
  no window in which an agent reads stale data.
- Debouncing becomes unnecessary. Fifty rapid saves collapse into one drain.

The alternative — background indexing with a debounce, as codegraph does with a
2-second window — is simpler but gives a weaker guarantee. Prefer lazy drain.

`[NOTE]` codebase-memory-mcp uses adaptive polling rather than native watchers,
which sidesteps inotify watch limits on Linux entirely. For the hot layer (a few
hundred files) polling is entirely adequate and removes a class of
platform-specific failure. Consider polling first, native watchers as an
optimisation.

### Per-file reindex

When one file changes:

1. Delete the `Asset` node and **all its outgoing** edges and candidates
2. Re-parse; update the symbol table
3. Re-run this asset's candidates against the symbol table

And the step that is easy to forget:

4. **A symbol-table change affects other assets' edges.**
   - Asset **added** → scan the unresolved-candidate table for entries matching
     the new ID and materialise those edges. Something referenced an asset that
     did not exist yet; the reference is now live.
   - Asset **removed or renamed** → do **not** delete incoming edges. **Demote**
     them back to candidates and mark them dangling.

This is where persisting unresolved candidates pays off. Without that table, step
4 requires a full corpus walk and there is no incremental path at all. With it,
step 4 is one indexed lookup.

### Racing the agent — now with evidence

An agent writes a JSON file and calls `validate_pack` in the same turn. The file
may be half-written.

**Q7 is resolved, statically, from the JAR** (`OPEN-QUESTIONS.md` Q7). The Asset
Editor's `StandardDataSource.updateAsset(Path, byte[], EditorClient)` writes with:

```java
Files.write(path, bytes, CREATE, WRITE, TRUNCATE_EXISTING)
```

**In place. No temp-then-rename, no `ATOMIC_MOVE` anywhere in the class.**

Both halves of that matter, and they pull in opposite directions:

- **Good:** no `.tmp` churn, no rename storms, one saved asset produces exactly one
  changed file. The watcher stays simple.
- **Bad:** `TRUNCATE_EXISTING` followed by a write means there is a **real window in
  which the file exists and is empty or partial**. The mitigation below is therefore
  necessary, not defensive paranoia.

`Files.move` does appear in the class, but only in `moveAsset`/`moveDirectory` —
renames surface to a watcher as delete + create pairs and should be treated as
such.

Mitigation:

- On parse failure, do not immediately mark the asset broken. Check mtime/size
  stability and retry once after ~100 ms. **A zero-length JSON file is the expected
  transient, not a corruption.**
- Ignore `*.tmp`, `*.swp`, `*~`, and dotfiles by mask.
- Exclude build output directories (`run/`, `data/`, `build/`, `dist/`,
  `node_modules/`) from the watcher entirely. `run/` in particular is regenerated
  wholesale on every `./gradlew runServer` and will flood the queue. It remains a
  useful *read* source for the frozen layer; it is never a watch target.

### Packs supplied as ZIP

No visibility into archive internals for change detection. Watch the archive's
mtime and re-index it wholly. Acceptable for a small working pack; for large
third-party packs, treat them as frozen.

---

## Epoch

Every tool response carries the current `epoch`. If an agent holds a `get_asset`
result from epoch 41 and the current response says 47, it knows its cached
understanding may be stale — without needing a separate call to find out.

`whats_changed(since_epoch)` turns this into an actionable diff. See
`04-MCP-SURFACE.md`.

---

## Concurrency

Not optional to think about: a user may run two Claude Code sessions on one project,
or an MCP server and a CLI `validate` simultaneously. Both will open the same SQLite
files.

- Enable **WAL mode**. Concurrent readers alongside one writer is exactly the
  workload.
- The **frozen** cache is read-only after build and needs no coordination. Guard the
  *build* with a lockfile so two cold starts do not index the same archive twice —
  the second should wait and reuse, not duplicate hundreds of megabytes of work.
- The **hot** layer has one logical writer: the drain. Serialise drains with a
  process-level mutex plus a SQLite transaction. A second process finding the lock
  held should wait briefly, then proceed to read — a slightly stale read beats
  blocking a tool call.
- `busy_timeout` set to a few seconds so transient contention retries instead of
  erroring.

---

## Component boundaries

```
┌─────────────────────────────────────────────┐
│ MCP server  (tool surface, response shaping)│
├─────────────────────────────────────────────┤
│ Query layer (SQL + CTEs, result elision)    │
├─────────────────────────────────────────────┤
│ Index core  (passes 1–3, incremental)       │
├──────────────┬──────────────────────────────┤
│ Sources      │ Watcher / drain queue        │
│ zip / dir /  │                              │
│ jar-extract  │                              │
└──────────────┴──────────────────────────────┘
```

Keep the MCP server thin. Everything it does should be expressible as a CLI
command too — this makes the whole system testable without an agent in the loop,
which matters enormously for iteration speed.
