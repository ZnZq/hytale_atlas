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

**Windows install root — verified, and machine-readable.** Do not guess it:

```
%AppData%\Roaming\Hytale\patchline.json
    {"patchline":"release","user_data":"…\\AppData\\Roaming\\Hytale\\UserData"}

%AppData%\Roaming\Hytale\install\<patchline>\package\game\latest\Assets.zip
%AppData%\Roaming\Hytale\install\<patchline>\package\game\latest\Server\HytaleServer.jar
%AppData%\Roaming\Hytale\install\<patchline>\package\jre\latest\    (Temurin 25)
```

**Read `patchline.json` and resolve from it.** It names the active patchline *and*
the UserData root, which makes step 5 deterministic on Windows rather than a probe.
Fall back to scanning `install\*\package\game\latest\` if the file is missing or
malformed — patchlines are sibling directories, and more than one is commonly
installed (`release` and `pre-release` were both present on the verification
machine).

macOS and Linux roots remain unverified (`OPEN-QUESTIONS.md` Q6).

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

Tiers 1 and 3 are independent of tier 2.

**Q2 is resolved, and tier 2 is the normal case rather than the privileged one.**
The client installation ships `HytaleServer.jar` adjacent to `Assets.zip`, **and
bundles its own Temurin 25 JRE**:

```
install\<patchline>\package\game\latest\Server\HytaleServer.jar   123 MB
install\<patchline>\package\jre\latest\                           Temurin 25.0.2+10
```

So a no-code pack author with no Java installation still reaches tier 2 — both the
schema source and the runtime to read it are already on their disk. Since packs are
the primary audience, this roughly doubles the tool's value for the people who need
it most, and it is why Phase 3 moved earlier in `08-ROADMAP.md`.

Two implementation consequences:

- **Ship the extractor pre-compiled.** The bundled runtime is a JRE — `java.exe`
  is present, `javac`/`javap` are not. It can run our extractor; it cannot build it.
- **Prefer the bundled JRE over any system Java.** It is guaranteed
  version-matched to the JAR being read. Fall back to `JAVA_HOME`/`PATH` only if
  the bundled runtime is absent.

Tier 2 should now degrade only when the game is not installed locally at all — for
example when the user points `--assets` at a copied archive. Say so plainly in that
case rather than silently returning less.

`status()` must always report the current tier.

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

The first run is slow — **`Assets.zip` measures 3.43 GB across 60 148 entries**, an
order of magnitude beyond the "hundreds of megabytes" this document originally
assumed — and this is the moment a user decides whether to keep the tool.

Two measurements make the budget less alarming than the size suggests: the central
directory read costs **~4 s** for all 60 148 entries, and decompressing one asset
JSON costs **~0.13 ms**. So enumerating the corpus is cheap and random access is
very cheap; the cost is in how many entries you choose to parse.

Report progress against entries processed, and consider deferring the bulk of
content parsing for directories the user is unlikely to query first —
`Server/World` and `Server/Prefabs` alone are a third of the archive.

Requirements:

- Progress output with real counts, not a spinner
- Explain *what* is happening: "Indexing vanilla assets (one-time, cached globally)"
- Print the resulting tier and what it does and does not enable
- Print the MCP configuration snippet to paste into their client
- Never block on a missing optional source — degrade, report, continue

Something close to:

```
Detected: pack "MyFirstPack" (empty)
Patchline:      release
Vanilla assets: …\game\latest\Assets.zip          3.43 GB, 60,148 entries [cached ✓]
Server JAR:     …\game\latest\Server\HytaleServer.jar          — tier 2
Java runtime:   bundled Temurin 25.0.2 (game install)

Indexed 12,847 assets across 39 types, 31,209 references (2,104 low-confidence)
Schema: 39/39 types from codec  ·  Localization: 5 locales, 99.9% of items
Ready. Add to your MCP client:

  { "hytale-index": { "command": "npx", "args": ["hytale-index", "--mcp"] } }
```
