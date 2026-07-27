# 06 — CLI and UX

## Target interaction

```bash
cd ~/projects/MyFirstPack
npx hytale-index
```

That is the whole onboarding. It must work in a folder containing nothing but
`manifest.json` and two empty directories, because that is exactly what a new pack
is (`02-DOMAIN.md`).

**The empty folder is not a degenerate case — it is the strongest case for the
tool.** With nothing local to learn from, the vanilla corpus and extracted schema
supply 100% of the value. Rule: the project directory is only ever the hot layer,
and nothing may be required of it.

---

## Commands

| Command | Behaviour |
|---|---|
| `npx hytale-index` | Detect, index, report. Idempotent. |
| `npx hytale-index --mcp` | Serve MCP over stdio. **Requires a warm cache** — see below |
| `npx hytale-index status` | Tier, sources, hashes, epoch, coverage |
| `npx hytale-index validate` | Run `validate_pack` from the CLI, exit non-zero on errors |
| `npx hytale-index add-pack <path>` | Add a third-party pack to the frozen layer |
| `npx hytale-index --assets <path> --jar <path>` | Explicit source override |
| `npx hytale-index clean [--all]` | Drop this project's index, or the global cache |

Everything the MCP server does must also be reachable from the CLI. This makes the
system testable without an agent in the loop, which matters more for iteration
speed than almost anything else.

`validate` exiting non-zero makes the tool usable in CI, which is a cheap win.

### Cold start: `--mcp` must not index

The frozen-layer build takes minutes on hundreds of megabytes. An MCP server that
performs it lazily on the first tool call will hang the client past its timeout, and
the agent will report the tool as broken. Worse, the agent may retry, spawning a
second indexing run.

**Rules:**

- `--mcp` with a cold cache **fails fast** with an actionable message
  (`run \`npx hytale-index\` first — initial indexing takes a few minutes`), rather
  than blocking or silently starting work.
- The MCP server starts serving immediately when the cache is warm. Hot-layer
  indexing for the user's own project is fast enough to do at startup.
- `status()` is always answerable, even cold, so an agent can diagnose the state.
- If lazy indexing is ever added, it must stream progress notifications and the
  first call must return a "still indexing, N%" result rather than blocking.

Onboarding therefore has two steps, and the docs must say so plainly: run the CLI
once, then add the MCP entry. Attempting to collapse this into one step is where
this design would break.

---

## Autodetection

### Project type

| Signal | Verdict |
|---|---|
| `manifest.json` + `Common/` and/or `Server/` | Pack |
| `build.gradle[.kts]` + `src/main/resources/manifest.json` | Plugin |
| Both, or `IncludesAssetPack: true` | Plugin with embedded asset pack |
| `manifest.json` only, no recognised subdirs | Pack (fresh) — proceed, do not error |
| Nothing recognised | Index frozen layer only; explain how to point at a project |

The last row matters: a user running the tool in the wrong directory should still
get a usable vanilla index and a clear message, not a failure.

### Vanilla `Assets.zip`

Search in order, first hit wins:

1. `--assets` argument
2. Config file in the project (`.hytale-index.json`)
3. `HYTALE_ASSETS` environment variable
4. Project-local provisioned copies: `run/`, `data/server/`, `data/assets/`
5. Standard install paths per OS (below)

Standard install path, via launcher → Settings → Open Directory:

```
<install>/release/package/game/latest/Assets.zip
```

`[UNKNOWN]` The OS-specific install root. `OPEN-QUESTIONS.md` Q6. Likely
`%LocalAppData%` or `%AppData%` on Windows; macOS and Linux unconfirmed.
User data is separately known to live at `%AppData%/Roaming/Hytale/UserData/`.

### Server JAR

Search in order:

1. `--jar` argument
2. `libs/HytaleServer.jar` — the canonical Gradle template location
3. Project root `./HytaleServer.jar`
4. `run/Server/`, `data/server/Server/`
5. Gradle dependency cache
6. Alongside a discovered `Assets.zip` (the dedicated-server layout puts
   `Assets.zip` and `Server/HytaleServer.jar` adjacent)

Path 6 is the interesting one — see the tier discussion below.

### Exclusions

Never watch, and never treat as project content:

```
run/  data/  build/  dist/  out/  .gradle/  node_modules/  .git/
```

`run/` is regenerated wholesale by `./gradlew runServer` and will flood the change
queue. It is a legitimate **read** source for the frozen layer; it is never a watch
target.

---

## Degradation tiers

| Tier | Sources | Capability |
|---|---|---|
| **1** | `Assets.zip` only | Corpus graph, inferred schema, examples, impact analysis |
| **2** | `+ HytaleServer.jar` + JVM | Authoritative schema, complete enums, `find_undocumented`, real validation |
| **3** | `+ project files` | Overrides, diffs, live validation, `whats_changed` |

Tiers 1 and 3 are independent of tier 2; a pack author with no Java still gets a
fully working tool, just without schema-level answers.

**Important open question (Q2):** Hytale runs a local server even in singleplayer.
If the client installation therefore ships `HytaleServer.jar`, then tier 2 is
available to pack authors too — and since packs are the primary audience, that
roughly doubles the tool's value for the people who need it most. This is verifiable
in five minutes on any installation. **Check it early; it may reorder the roadmap.**

`status()` must always report the current tier, and tools that require tier 2 must
say so plainly rather than silently returning less.

---

## Cache layout

```
~/.cache/hytale-index/            (XDG / platform equivalent)
  frozen/
    <hash(assets.zip)>/
      corpus.db
      meta.json
    <hash(jar)>/
      schema.json
  projects/
    <hash(project path)>/
      hot.db
      config.json
```

Frozen artifacts are keyed by **content hash**, never by version string —
patchlines mean several game versions can coexist on one machine.

**The global frozen cache is what makes `npx` viable.** First run: minutes. Every
subsequent project on that machine: seconds. Without it the tool feels heavy and
nobody uses it twice.

Invalidation is by hash mismatch. Game updates naturally produce a new key; the old
one can be garbage-collected by age.

---

## Distribution: the honest tradeoff

**The conflict:** pack authors are explicitly a no-code audience — packs are JSON
and PNG, and the Asset Editor removes even that barrier. They may have neither Node
nor a JVM. Plugin developers definitely have Java 25 but would find a Gradle task
more natural than `npx`.

**Precedent for npm in this niche:** the `hytale-generators` package publishes
utilities for generating Hytale server assets — JSON, language entries, textures,
derived colours, recipe definitions — into a `dist/` directory. Node tooling is not
foreign to Hytale pack authors.

### Recommended plan

1. **npx as the primary surface.** CLI plus MCP server in Node/TypeScript. Lowest
   friction, familiar invocation, existing precedent.
2. **JVM subprocess only for tier 2.** Parsing codecs from bytecode in JavaScript is
   painful; shipping a small Java extractor that emits JSON is far simpler. No Java
   → tier 1 with a clear message.
3. **Gradle task later**, ideally coordinated with `com.azuredoom.hytale-tools` so
   plugin developers get an index as part of `setupHytaleDev`. Integrate rather than
   compete.

### The alternative worth weighing

codegraph and codebase-memory-mcp both ship **single static binaries** specifically
to avoid runtime dependencies — codebase-memory as one statically linked C binary
with zero runtime dependencies. A Go or Rust implementation would remove both the
Node and (with a bytecode parser) the JVM dependency.

More expensive up front, and it forfeits `npx` ergonomics and the existing npm
precedent. Worth revisiting if adoption data shows the Node requirement is the
blocker — but do not start there.

---

## First-run experience

The first run is slow (hundreds of megabytes) and this is the moment a user decides
whether to keep the tool. Requirements:

- Progress output with real counts, not a spinner
- Explain *what* is happening: "Indexing vanilla assets (one-time, cached globally)"
- Print the resulting tier and what it does and does not enable
- Print the MCP configuration snippet to paste into their client
- Never block on a missing optional source — degrade, report, continue

Something close to:

```
Detected: pack "MyFirstPack" (empty)
Vanilla assets: <path>  [cached ✓]
Server JAR:     not found — tier 1
  → schema answers unavailable; run with --jar to enable

Indexed 12,847 assets across 43 types, 31,209 references (2,104 low-confidence)
Ready. Add to your MCP client:

  { "hytale-index": { "command": "npx", "args": ["hytale-index", "--mcp"] } }
```
