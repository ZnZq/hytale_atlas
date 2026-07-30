# hytale-atlas

An unofficial, local, read-only index of Hytale's asset corpus, built for people
authoring mods — and for the AI assistants helping them.

It reads the game's own `Assets.zip` (and, optionally, the schema its server can
generate) into a local SQLite database, then answers questions about it: what an
asset actually resolves to after inheritance, which fields a type declares, what
references what, which values really occur, and what a mod pack has changed.

Nothing is uploaded. Nothing about the game is stored in this repository.

---

## Quick start

Requires **Node.js ≥ 22.5.0** and an installed copy of Hytale.

```bash
npm install
npm run build

node dist/cli/main.js status     # what was found, and what the index holds
node dist/cli/main.js index      # build it (~40s, cached per-user)
node dist/cli/main.js search pickaxe
```

`status` works before anything is built, and is the right first command: it
prints where the game was detected, which patchline is active, which capability
tier is available, and — once built — what the index contains.

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
`package.json`. When present it is the authority. Run `init` to generate one.

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
  "consent": { "runModPlugins": false }
}
```

- Relative paths resolve against the **config file**, not the working directory.
- `cacheDir` is where the index lives; omit it for a per-user cache directory.
- An explicit `include` entry is never vetoed by `exclude`.
- Unknown keys and missing paths are reported, not ignored.

`HYTALE_ATLAS_NO_CONFIG=1` disables config discovery entirely. The test suite
sets it, so results never depend on which mods a developer happens to have.

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

The server itself is one command:

```bash
node /ABSOLUTE/PATH/TO/hytale-atlas/dist/cli/main.js --mcp
```

Use an **absolute** path to both `node` and `main.js`. A client starts the server
from its own working directory with its own `PATH`, so a bare `node` or a relative
path produces a config that works on the machine that wrote it and nowhere else.
`node -e "console.log(process.execPath)"` prints the path to your `node`.

Below, `<NODE>` is that path and `<ATLAS>` is this repository's
`dist/cli/main.js`. To skip the substituting, this prints every line below with
your own paths already in place:

```bash
node dist/cli/main.js mcp-install         # clients detected here
node dist/cli/main.js mcp-install --all   # every client it knows
```

It only prints. Registering the server is your call, in your own config.

### Clients with a command for it

```bash
# Claude Code -- project scope writes .mcp.json, shareable via git
claude mcp add hytale-atlas --scope project -- <NODE> <ATLAS> --mcp
# or --scope user for every project

# Gemini CLI
gemini mcp add hytale-atlas -s user <NODE> <ATLAS> --mcp

# VS Code / GitHub Copilot (writes your user profile)
code --add-mcp "{\"name\":\"hytale-atlas\",\"command\":\"<NODE>\",\"args\":[\"<ATLAS>\",\"--mcp\"]}"

# Kiro
kiro-cli mcp add --name hytale-atlas --command <NODE> --args <ATLAS> --args --mcp

# Amazon Q Developer
qchat mcp add --name hytale-atlas --command <NODE> --args <ATLAS>,--mcp
```

`opencode mcp add` and GitHub Copilot CLI's `/mcp add` exist but take no
arguments — they prompt. Configure those by file, below.

### Clients you configure by file

There is no universal format. Four shapes are in use, and the differences are
not cosmetic — the top-level key, the entry fields, and whether the command is a
string or an array all differ.

**`mcpServers`** — Claude Code (`.mcp.json`, `~/.claude.json`), Cursor
(`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Gemini
CLI (`~/.gemini/settings.json`), Cline and Roo Code (their VS Code
`globalStorage` settings), Claude Desktop:

```json
{
  "mcpServers": {
    "hytale-atlas": { "command": "<NODE>", "args": ["<ATLAS>", "--mcp"] }
  }
}
```

**`servers`** — VS Code workspace, `.vscode/mcp.json`:

```json
{
  "servers": {
    "hytale-atlas": { "command": "<NODE>", "args": ["<ATLAS>", "--mcp"] }
  }
}
```

**`context_servers`** — Zed, in its `settings.json`:

```json
{
  "context_servers": {
    "hytale-atlas": { "command": "<NODE>", "args": ["<ATLAS>", "--mcp"], "env": {} }
  }
}
```

**`mcp`** — opencode, `opencode.json`. Note the command is **one array**, not a
command plus arguments; splitting it the way the shapes above do produces a
config the schema accepts and the client cannot launch:

```json
{
  "mcp": {
    "hytale-atlas": {
      "type": "local",
      "command": ["<NODE>", "<ATLAS>", "--mcp"],
      "enabled": true
    }
  }
}
```

**TOML** — Codex, `~/.codex/config.toml` (or `.codex/config.toml` in a trusted
project):

```toml
[mcp_servers.hytale-atlas]
command = "<NODE>"
args = ["<ATLAS>", "--mcp"]
```

Continue, Goose and Hermes use YAML; see their own docs for the exact key.

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

`get` and `search` need only `Assets.zip`. The DECLARED layer needs the schema
the game's own server can generate:

```bash
node dist/cli/main.js generate-schema
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

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc
npm test            # node --test, runs with config discovery disabled
```

The design rule the codebase is built around: **the contract is the operation,
not the command.** `src/api/operations.ts` renders every answer, including its
text; the CLI and the MCP server only compose it. A front end that computes
anything itself has reintroduced the divergence that layer exists to prevent.

Further reading lives in `docs/` — `INDEXING.md` for how the corpus is built,
`TOOLS.md` for the tool surface, `SERVER-JAR.md` for what is known about the
server binary, `BLIND-TRIALS.md` for how answers are evaluated, and
`docs/init/` for the domain research and the open questions behind it.

---

## Legal

Unofficial and unaffiliated. It reads a local, legitimately installed copy of the
game and derives an index from it. **No Hytale-derived data is stored in this
repository** — the `local/` directory is gitignored precisely so none leaks in.
Hytale's EULA governs what you may do with what you extract; indexing your own
install for your own authoring is the use this was built for.
