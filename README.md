# hytale-atlas

An unofficial, local, read-only index of Hytale's asset corpus, built for people
authoring mods — and for the AI assistants helping them.

It reads the game's own `Assets.zip` (and, optionally, the schema its server can
generate) into a local SQLite database, then answers questions about it: what an
asset actually resolves to after inheritance, which fields a type declares, what
references what, which values really occur, and what a mod pack has changed.

Nothing is uploaded. The index lives only in a per-user cache on your machine.

---

## Install

Requires **Node.js ≥ 22.5.0** and an installed copy of Hytale.

Run it on demand with `npx` — nothing to install:

```bash
npx hytale-atlas status          # what was found, and what the index holds
npx hytale-atlas index           # build the index (~40s, cached per-user)
npx hytale-atlas search pickaxe
```

Or install once for a short command on your `PATH`:

```bash
npm install -g hytale-atlas
hytlas status                    # short alias — hytale-atlas works too
```

`status` works before anything is built, and is the right first command: it
prints where the game was detected, which patchline is active, which capability
tier is available, and — once built — what the index contains.

> The package ships two command names for the same tool: the full `hytale-atlas`
> and the short `hytlas`. `npx` resolves a *package* name, so use
> `npx hytale-atlas`; the `hytlas` alias becomes available after a global
> install. Pin a version anywhere with `hytale-atlas@0.1.0`.

The examples below write `hytale-atlas <command>`. If you did not install
globally, prefix them with `npx `.

---

## The mental model

Four ideas explain nearly every answer this tool gives.

**1. Two schema layers, never merged.**
DECLARED is what the game's own generated JSON Schema permits. OBSERVED is what
assets in the corpus actually do. `describe` prints both, side by side, and never
blends them. A field can be declared and never used; a field can be used and never
declared. Those are different facts and the tool refuses to average them.

**2. Caveats are data, not decoration.**
Every answer carries a list of caveats with stable codes: a list was truncated, a
query was loosened, a count precedes inheritance, an absence is weak evidence.
Read them before concluding anything negative — especially before concluding that
something *cannot* be done. Schema search is lexical: a miss means those words are
absent, not that the capability is.

**3. `get` resolves, `refs` inverts.**
`get` shows what an asset becomes after its parent chain is folded in — what the
engine sees, not what the file says. `refs` shows what points *at* it.

**4. Third-party packs are marked, and never merged.**
If you index mods, their assets sit alongside the game's. Identifiers give no
hint — most packs do not prefix theirs — so the tool marks the owning pack on
every row and value. Where a pack and the game define the same identifier, the
game loads exactly one file, whole; it does not merge them. See **Packs** below.

---

## Commands

Build and inspect:

| Command | Answers |
|---|---|
| `status` | Where is the game, what is indexed, is the index current |
| `index` | Build the corpus index (`--force` to rebuild) |
| `init` \| `setup` | Write a `hytale-atlas.json` here, filled in from detection |

Finding things:

| Command | Answers |
|---|---|
| `search <query>` | Find assets by id or translated name, in any indexed locale |
| `search-lang <query>` | Find a localization key or a translated string, and what uses it |
| `search-schema <query>` | Where does a capability live in the schema |
| `types` | Every asset type, with counts and where its files live |
| `types <Type>` | Every asset of that type — how to enumerate a field's legal values |

Reading one thing:

| Command | Answers |
|---|---|
| `get <id>` | The effective definition, parent chain resolved |
| `refs <id>` | What references this asset, with confidence |
| `describe <Type>` | The schema of a type: declared and observed |
| `describe <Type> --field <ptr>` | One field, with its description, observed values, broken references and declaring assets |
| `undocumented [Type]` | Fields the schema permits that the game never uses |
| `bench [id]` | Crafting benches; with an id, what it crafts |

Two commands are declared but **not implemented** — they exit 2 rather than
pretend: `validate` and `clean`.

Run `hytale-atlas --help` for the full, self-describing list.

### Options worth knowing

| Option | Effect |
|---|---|
| `--type <Type>` | Identifiers are **not** unique across types. Use this on `get`, `search`, `refs`. |
| `--field <pointer>` | One field of a `describe`. Does not cross a `$ref` — `/Tool` is a crossing into `common:ItemTool`, so ask that type instead. Leading slash optional (some shells rewrite it). |
| `--pack <Name>` | Read one pack's version of an identifier, including one the game does not load. `get` only. |
| `--limit <n>` | Result cap. Every command says so when it truncates. |
| `--raw` | `get` prints the effective JSON and nothing else; qualifications go to stderr. |
| `--assets`, `--jar`, `--patchline`, `--schema` | Explicit source overrides. |

Shared types need their namespace: `describe common:ItemTool`, not `ItemTool`.

---

## Configuration

Entirely optional. With no config file the tool reads the game's own install.

`hytale-atlas.json` — found by walking up from the working directory, like
`package.json`. When present it is the authority. Run `hytale-atlas init` to
generate one.

```json
{
  "assets": "…/Assets.zip",
  "serverJar": "…/HytaleServer.jar",
  "patchline": "release",
  "schema": "./local/schema-release",
  "cacheDir": "./local/index",
  "mods": {
    "dir": "…/Hytale/UserData/Mods",
    "include": ["…/some-pack.zip"],
    "exclude": ["…/broken-pack.zip"]
  },
  "consent": { "runModPlugins": false },
  "port": 43790
}
```

- Relative paths resolve against the **config file**, not the working directory.
- `cacheDir` is where the index lives; omit it for a per-user cache directory.
- An explicit `include` entry is never vetoed by `exclude`.
- Unknown keys and missing paths are reported, not ignored.

`HYTALE_ATLAS_NO_CONFIG=1` disables config discovery entirely, so results never
depend on which mods happen to be installed.

---

## Packs and mods

Point `mods.dir` at a mods folder (or list packs explicitly) and their assets are
indexed alongside the game's. **No pack code is executed** — archives are opened
as zip files and their JSON is read.

Once packs are indexed, three things change:

- Rows and values from a pack are marked with it: `[Multitools]`.
- A `third-party` caveat names the packs an answer touched.
- Where several packs define one identifier, `get` returns **the list of packs
  instead of a document**, and you name one with `--pack`.

That last one is deliberate. A pack replaces the whole file rather than merging
into it, and the engine keeps whichever pack registered *last* — an order this
index cannot observe. Returning one version with a footnote would still be
choosing for you, so it does not choose. In practice: build on the base game's
version, because that is the one every player has.

---

## MCP (for AI assistants)

The atlas speaks MCP over stdio. Because it is published to npm, `npx` fetches and
runs it for you — no absolute paths, no build step. Point your assistant at:

```json
{
  "mcpServers": {
    "hytale-atlas": { "command": "npx", "args": ["-y", "hytale-atlas", "--mcp"] }
  }
}
```

That is the whole configuration for most clients. Pin a version with
`"hytale-atlas@0.1.0"` if you want reproducibility.

### Clients with a command for it

```bash
# Claude Code — project scope writes .mcp.json, shareable via git
claude mcp add hytale-atlas --scope project -- npx -y hytale-atlas --mcp
# or --scope user for every project
```

Other CLIs (Gemini, Copilot, Kiro, Amazon Q) have their own `mcp add` syntax, but
the command and arguments are the same three tokens: `npx -y hytale-atlas --mcp`.
When in doubt, write the JSON below by hand — it is the source of truth.

### Clients you configure by file

There is no universal format. The top-level key differs between clients; the entry
is the same `command`/`args` pair (opencode being the one exception).

**`mcpServers`** — Claude Code (`.mcp.json`, `~/.claude.json`), Cursor
(`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Gemini
CLI (`~/.gemini/settings.json`), Cline and Roo Code, Claude Desktop:

```json
{
  "mcpServers": {
    "hytale-atlas": { "command": "npx", "args": ["-y", "hytale-atlas", "--mcp"] }
  }
}
```

**`servers`** — VS Code workspace, `.vscode/mcp.json`:

```json
{
  "servers": {
    "hytale-atlas": { "command": "npx", "args": ["-y", "hytale-atlas", "--mcp"] }
  }
}
```

**`context_servers`** — Zed, in its `settings.json`:

```json
{
  "context_servers": {
    "hytale-atlas": { "command": "npx", "args": ["-y", "hytale-atlas", "--mcp"], "env": {} }
  }
}
```

**`mcp`** — opencode, `opencode.json`. Note the command is **one array**, not a
command plus arguments:

```json
{
  "mcp": {
    "hytale-atlas": {
      "type": "local",
      "command": ["npx", "-y", "hytale-atlas", "--mcp"],
      "enabled": true
    }
  }
}
```

**TOML** — Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.hytale-atlas]
command = "npx"
args = ["-y", "hytale-atlas", "--mcp"]
```

Continue, Goose and Hermes use YAML; see their own docs for the exact key.

### As an HTTP server

Some clients take a URL rather than a command. For those:

```bash
hytale-atlas serve                # http://127.0.0.1:43790/mcp
hytale-atlas serve --port 45001
```

The port comes from `--port`, then `"port"` in `hytale-atlas.json`, then the
built-in **43790**. That default is derived from the package name rather than
picked: round numbers like 8080 collide precisely because everyone reaches for
them. The 40000–47999 band also sits below the range Windows hands out for
outgoing connections (49152+), so a listener there will not fight the OS.

**It binds loopback, and that is the entire security model.** A stdio server is
reachable only by the process that spawned it; the moment this listens on a
socket, anything that can reach the socket can ask it questions. There is no
authentication because there is nothing to authenticate against — so the answer
is not to be reachable. DNS-rebinding protection is on, which is what stops a web
page from resolving a hostname it controls to `127.0.0.1` and talking to your
index; a request arriving with an unexpected `Host` gets a 403.

### What it serves

Serves the same answers as structured data over stdio, with caveats attached.
Ten read-only tools: `status`, `types`, `search`, `get`, `describe`, `refs`,
`search_schema`, `search_lang`, `bench`, `undocumented`.

`index` and `generate-schema` are **deliberately not exposed** — one writes, the
other executes a binary that sends telemetry. Neither belongs behind a tool call
an assistant can make on its own.

The server resolves its index at startup and will build one if it is missing,
incomplete or out of date. If you change the config or rebuild the index while a
client is connected, reconnect.

---

## Schemas, telemetry and consent

`get` and `search` need only `Assets.zip`. The DECLARED schema layer needs the
schema the game's own server can generate:

```bash
hytale-atlas generate-schema
```

This **starts the game server binary**, which **sends telemetry that cannot be
disabled**. The command discloses this and asks before doing anything; `--yes`
accepts the disclosure without prompting.

If mod `.jar` files are in play, generating their schemas requires the server to
**load and execute that third-party code** with your account's privileges. That
is a second, separate consent, and `--yes` does *not* cover it — only an
interactive yes or `consent.runModPlugins: true` in the config does. The bundled
runtime is Java 25, where the in-process SecurityManager has been removed, so
there is no sandbox inside the JVM. If you do not trust every jar, run it in a
container or a throwaway account.

Reading mod *assets* needs none of this — that path never executes anything.

---

## What it cannot tell you

Stated plainly, because a confident tool that hides its edges is worse than a
quiet one:

- **Schema search is lexical.** A miss is evidence, not proof.
- **Untyped world and prefab assets** are indexed and searchable but contribute
  no references, so a reference list can be incomplete by design.
- **Which pack wins** when several define one identifier depends on load order,
  which is not visible in the archives.
- **Runtime behaviour.** This indexes data assets, not the plugin API. What a
  custom interaction type actually *does* lives in someone's Java.

---

## Legal

Unofficial and unaffiliated. It reads a local, legitimately installed copy of the
game and derives an index from it, kept in a per-user cache — no Hytale-derived
data is uploaded anywhere. Hytale's EULA governs what you may do with what you
extract; indexing your own install for your own authoring is the use this was
built for.

---

Building from source, running the test suite, or cutting a release?
See [DEV.md](DEV.md).
