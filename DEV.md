# Developing hytale-atlas

This is the contributor's guide: building from source, running the tests, the one
design rule the codebase is built around, and how a release is cut. For using the
tool, see [README.md](README.md).

Requires **Node.js ≥ 22.5.0**.

---

## Build from source

```bash
git clone https://github.com/ZnZq/hytale_atlas.git
cd hytale_atlas
npm install
npm run build            # tsc -> dist/

node dist/cli/main.js status
node dist/cli/main.js index
node dist/cli/main.js search pickaxe
```

`npm run dev` runs `tsc --watch` for an incremental rebuild while you work.

### Running it as a command from the working tree

Inside this repository `npx hytale-atlas <command>` already works — `npx` reads
the `bin` of the package in the current directory, so it runs your local `dist/`,
not the published package.

To get the command (and the `hytlas` alias) on your `PATH` from any directory
while still running the working tree, link it once:

```bash
npm link                 # from this directory
hytlas status
```

`npm link` symlinks this directory into your global npm folder, so it is the
working tree that runs, not a copy: `npm run build` takes effect immediately with
no re-linking. Undo with `npm rm -g hytale-atlas`.

---

## The scripts

```bash
npm run typecheck        # tsc --noEmit && tsc -p tsconfig.test.json
npm run build            # tsc
npm test                 # node --test, runs with config discovery disabled
npm run clean            # remove dist/
```

The test suite sets `HYTALE_ATLAS_NO_CONFIG=1`, so results never depend on which
mods a developer happens to have installed.

---

## The one design rule

**The contract is the operation, not the command.** `src/api/operations.ts`
renders every answer, including its text; the CLI (`src/cli/`) and the MCP server
(`src/mcp/`) only compose it. A front end that computes anything itself has
reintroduced the divergence that layer exists to prevent — the whole point is that
`hytale-atlas search …` and the `search` MCP tool cannot drift apart, because they
call the same function and print the same bytes.

That parity is also what makes the system testable without an agent in the loop,
which matters more for iteration speed than almost anything else.

---

## MCP registration for a source install

The published-package instructions in the README (`npx -y hytale-atlas --mcp`) are
what end users want. If you are running an unpublished working tree instead, point
clients at your built entry point with **absolute** paths:

```bash
node dist/cli/main.js mcp-install         # prints snippets for detected clients,
node dist/cli/main.js mcp-install --all   # your own paths already filled in
```

A client starts the server from its own working directory with its own `PATH`, so
a bare `node` or a relative path produces a config that works only on the machine
that wrote it. `node -e "console.log(process.execPath)"` prints the absolute path
to your `node`.

---

## Further reading

The `docs/` directory holds the domain research and design notes:

- `INDEXING.md` — how the corpus is built
- `TOOLS.md` — the tool surface
- `SERVER-JAR.md` — what is known about the server binary
- `BLIND-TRIALS.md` — how answers are evaluated
- `docs/init/` — the domain research and the open questions behind it

---

## Cutting a release

The package is published to npm as [`hytale-atlas`](https://www.npmjs.com/package/hytale-atlas).

1. Bump the version — this commits a tag:
   ```bash
   npm version patch      # or minor / major
   ```
2. Publish. `prepublishOnly` runs `clean && build` automatically, so `dist/` is
   always fresh:
   ```bash
   npm publish
   ```

**Run `npm publish` in a real interactive terminal**, not through a non-interactive
wrapper. The npm account has 2FA enabled, so publishing triggers a browser
web-authentication step (a passkey / one-time password). A non-interactive shell
cannot complete it and fails with `EOTP`.

### What ships

`package.json`'s `files` allowlist restricts the tarball to `dist/` and
`README.md`; npm always adds `package.json` and `LICENSE`. Nothing under `local/`,
`docs/`, `src/` or this file is published. Confirm before releasing with:

```bash
npm publish --dry-run
```

### A harmless warning

`npm publish` prints, for each `bin` entry:

```
npm warn publish "bin[hytale-atlas]" script name dist/cli/main.js was invalid and removed
```

This is **cosmetic**. It refers to npm's normalized registry manifest, not the
`package.json` inside the tarball — both `bin` entries are present in the published
package (`npm view hytale-atlas bin` confirms it), and installing the package
creates working `hytale-atlas` and `hytlas` commands. Ignore it.

---

## Repository hygiene

**No Hytale-derived data is stored in this repository.** The `local/` directory —
where generated schemas, built indexes and working packs live — is gitignored
precisely so none leaks in. The built index also lives outside the repo, in a
per-user cache directory (`hytale-atlas status` prints where).
