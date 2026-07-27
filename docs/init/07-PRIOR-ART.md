# 07 — Prior Art

Research conducted July 2026. Nothing found does this specific job — indexing game
asset archives into a graph served over MCP — but every component has a proven
implementation worth studying.

---

## 1. Code-graph MCP servers

The closest structural analogue, and a validated pattern with published numbers.

### codegraph (Colby McHenry)

Tree-sitter parsing, symbol graph in SQLite with full-text search, MCP server with
nine tools: **search, context, callers, callees, impact, explore, node, files,
status**. Native OS file watchers (FSEvents / inotify / ReadDirectoryChangesW) with
2-second debounce. Reported: 59% fewer tokens, 70% fewer tool calls, 49% faster
across seven real codebases.

- https://www.bighatgroup.com/blog/codegraph-2026-05-26/
- https://agentconn.com/agents/codegraph/

**Take:** the tool naming is close to one-to-one with what this project needs.
`impact` is `trace_refs(direction="in")`. The index being shared across agents (so
switching from Claude Code to another client does not re-trigger exploration) is a
selling point worth replicating.

### codebase-memory-mcp

Has a preprint. Single statically linked C binary, zero runtime dependencies, all
state in one SQLite file, 14 typed MCP tools, background watcher using **adaptive
polling**. Evaluated on 31 repositories: 83% answer quality, 10x fewer tokens, 2.1x
fewer tool calls versus file-by-file exploration.

- https://deusdata.github.io/codebase-memory-mcp/
- https://arxiv.org/html/2603.27277v1

**Take:** adaptive polling instead of native watchers sidesteps inotify limits
entirely. The single-binary decision is the strongest argument for the Go/Rust
alternative in `06-CLI-UX.md`. Read the preprint's evaluation methodology — it is
a template for justifying this tool's value.

### CodeGraphContext

MCP server plus CLI indexing code into a graph database.
https://github.com/CodeGraphContext/CodeGraphContext

**Take:** CLI-and-MCP parity as a design stance.

**Conclusion from this family:** SQLite is the consensus, not a compromise. Two
serious independent projects converged on it. Fixed task-shaped tools beat a
generic query interface.

---

## 2. Game engine asset dependency graphs

The same graph, for assets, refined over more than a decade.

### Unity Dependency Viewer

Resolves GUIDs against project assets to create **hard** dependency links.
Filename matches are treated as **weak** links — explicitly documented as looking
like references but possibly being false positives. Report types: **Broken
Dependencies** (`dep:is:broken`), **Missing Dependencies**, **Unused Assets**.

Critically: **the dependency database does not update automatically when assets
change on disk — you must press Build manually.**

https://github.com/Unity-Technologies/com.unity.search.extensions/wiki/dependency-viewer

**Take:** confidence tiering is standard industry practice, not an invention — the
hard/weak split validates the design in `03-ARCHITECTURE.md`. The three report
types are the right three for `validate_pack`. And the manual-rebuild limitation is
precisely the pain this project's hot/frozen split plus watcher eliminates — a
concrete differentiator to lead with.

### Unreal Reference Viewer

Graph of asset dependencies with a search panel offering **filter by asset type**
and **configurable search depth**, plus a separate Reference Tree.

https://dev.epicgames.com/documentation/en-us/unreal-engine/reference-viewer-in-unreal-engine

**Take:** bounded depth as a first-class parameter, not an afterthought. Both
appear in `trace_refs`.

### Unity Cloud Dependency Viewer

Framed around **assessing the impact of changes before applying them** — modifying
a shader may affect many prefabs, whose parents are affected in turn.

https://docs.unity.com/en-us/cloud/asset-manager/dependency-viewer

**Take:** the framing. "What breaks if I change this" is the user-facing pitch for
inbound traversal.

### Others worth a skim

- https://github.com/AlexeyPerov/Unity-Asset-Inspector — handles "stringly"
  references that do not appear as normal dependency edges. Directly relevant:
  Hytale asset JSON is entirely stringly-typed.
- https://github.com/Begounet/unity-dependency-graph-viewer

---

## 3. Minecraft ecosystem

Structurally the closest domain: JSON-defined content, load-order overrides,
vanilla definitions shipped as a built-in data pack.

- Data packs load by **load order**, viewable and alterable via `/datapack`;
  vanilla features are themselves defined through a built-in data pack.
  https://minecraft.wiki/w/Data_pack
- **Mine code MCP** — an MCP for datapack/mod/texturepack developers providing
  agents with access to wikis, generators, bug fixes, and per-update changelogs.
  Found via https://github.com/topics/datapack

**Take, and it is a two-edged one:** even in an ecosystem orders of magnitude
larger than Hytale's, the available MCP serves *documentation*, not a graph of
actual vanilla data. Either the niche is genuinely open, or the community finds
docs plus grep sufficient. Worth treating as a real product risk rather than
assuming the former. Mitigation: lead with impact analysis and validation, which
documentation fundamentally cannot provide.

---

## 4. Schema inference

### GenSON

Built specifically to describe the common structure of large numbers of JSON
objects, and able to merge schemas from any number of objects. **It never infers
enums on its own** — enum capture is activated per node, after which that node
records every value it encounters instead of inferring a type.

- https://pypi.org/project/genson/
- https://github.com/wolverdude/GenSON

**Take:** the merge semantics are the right model. The enum limitation means a
cardinality pre-pass is required to decide where to enable enum capture — this is
half the value of `describe_schema` for tier 1 users.

### polars-genson

Exposes `map_threshold` and `map_max_required_keys` to distinguish **Records**
(fixed fields) from **Maps** (dynamic key-value pairs).

https://pypi.org/project/polars-genson/

**Take:** this is a problem this project will hit immediately. ECS component blocks
are almost certainly dynamic-key maps; naive inference will turn every component
name into a schema field and produce garbage. Handle deliberately.

### Academic framing

A survey notes that JSON and XML schema inference typically aims to produce a
schema **every document must conform to**, whereas RDF-style inference aims at
**summarising a repository's contents** rather than constraining it.

https://arxiv.org/pdf/2605.23105 · https://arxiv.org/pdf/2012.08105

**Take:** `describe_schema` is the summary; `validate_pack` is the constraint.
Different artifacts, different representations. Do not collapse them.

ABSTRA (referenced in that survey) builds a graph across data models and partitions
it into **recurring structural patterns** — a formalisation of "find the idiom",
which is what makes `find_examples` valuable.

---

## 5. Hytale-specific tooling

### Hytale protocol documentation project

Automatically extracts, decompiles, and documents all packets, enums, and data
structures from server JAR files using Vineflower, with version tracking and
generated wiki output. Found via https://github.com/topics/hytale-api

**Take:** a working JAR-to-structured-data pipeline for this exact game. Study its
version tracking and cross-version diffing.

### Hytale Depot

Generates an API index from the current `HytaleServer.jar` with an automated
class-file parser; signatures and class counts are regenerated from the JAR rather
than hand-written.
https://hytaledepot.net/en/dev-docs/assets-config

**Take:** automated class-file parsing is proven practical here. Scope differs —
they document the Java API, this project needs asset schema.

### mbround18/hytale-modding-template

Unzips `data/server/Assets.zip` into `data/assets` and unpacks the server JAR into
`data/unpacked` via introspection, as a Gradle setup task.
https://github.com/mbround18/hytale-modding-template

**Take:** the community already does this by hand. This tool automates it and adds
the index on top.

### com.azuredoom.hytale-tools

Gradle plugin handling manifest generation, validation, local server runs, IDE
source setup, and optional hosted Javadoc injection. `./gradlew setupHytaleDev`.
https://github.com/HytaleModding/plugin-template

**Take:** integration target. Plugin developers should get an index through the
workflow they already use.

### hytale-generators (npm)

Utilities for generating Hytale server assets — JSON, language entries, textures,
derived colours, recipe definitions — into a `dist/` directory. Published ~3 months
before this research.

**Take:** npm precedent exists in this niche. It is a *generator*; this is an
*index*. Potentially complementary — a generator that consults the index would
produce far better output.

### sanasol/hytale-auth-server

Contains `extractAsset(assetPath)`, pulling individual entries from `Assets.zip`
without unpacking the whole archive, with lazy loading and an in-memory cache.
https://github.com/sanasol/hytale-auth-server

**Take:** a concrete reference implementation for reading the archive efficiently.

### Existing Hytale MCP servers

- **Hytale MCP** (metrakit, CurseForge) — MCP access to a *live server* for
  building, administration, and prototyping. Runtime, not assets. Complementary.
- **craftserve hytale-docs MCP** — unofficial modding documentation over MCP:
  `claude mcp add craftserve-hytale-docs --transport http https://hytale-docs-mcp.craftserve.com/~mcp`
  Documentation, not actual asset content.

**Take:** neither overlaps. Both are evidence the community accepts MCP tooling.

---

## Summary of the gap

| Component | Proven donor implementation |
|---|---|
| Graph + MCP + SQLite | codegraph, codebase-memory-mcp |
| Asset dependency semantics | Unity, Unreal reference viewers |
| Overlay / load-order model | Minecraft data packs |
| Schema inference | GenSON, polars-genson |
| JAR extraction | Hytale protocol docs, Hytale Depot |
| Archive reading | sanasol/hytale-auth-server |

Nothing combines them. The technical risk is low — every piece has been built
before. The risk is product-side: whether the Hytale community wants this or finds
documentation sufficient.
