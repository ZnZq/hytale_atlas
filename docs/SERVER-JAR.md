# Working with HytaleServer.jar

The JAR is used for exactly one thing: **asking the game to emit its own JSON
Schema.** It is never run as a server, never kept running, and nothing else in
the pipeline touches it.

Everything else — the whole corpus index — comes from `Assets.zip` at rest
(`INDEXING.md`). Without the JAR the tool still works; every asset is simply
untyped, which the CLI calls tier 1.

Code: `src/sources/schema-gen.ts`, driven by `cmdGenerateSchema`
(`src/cli/commands.ts:142`). Background on why this beats writing our own
extractor: `docs/init/05-CODEC-EXTRACTION.md`.

---

## Why the JAR at all

Every codec in the game is schema-convertible by construction:

```java
public interface com.hypixel.hytale.codec.Codec<T>
        extends RawJsonCodec<T>, SchemaConvertable<T>
```

So the game can describe its own asset format, and it ships a switch that does
it — `--generate-asset-schema <dir>`, documented in its own `--help` as
*"Generate asset JSON schemas to the specified directory and exit"*.

Running the vendor's generator beats anything we could write: it is complete, it
is supported, and it survives patches. The alternative was decompiling builder
chains out of `<clinit>`, which would break on the next build.

What we get back, in `Schema/`: **104 files** — one per asset type (102), plus
`common.json` with 895 shared definitions and `other.json` with 382 more that
belong to no asset type (indexed under the `other:` namespace, e.g.
`other:NPC:Abstract`). They carry titles, descriptions, enums, defaults, and the
`hytale*` markers the whole index depends on.

A `.vscode/settings.json` comes with it, mapping path globs to types. That map
is what `TypeResolver` uses to type an asset from its path.

---

## Finding it

`detectInstallation` (`src/sources/detect.ts:146`) reads `patchline.json` at the
install root rather than guessing:

```
%AppData%\Roaming\Hytale\
  patchline.json                                    active patchline
  install\<patchline>\package\game\latest\
      Assets.zip
      Server\HytaleServer.jar
  install\<patchline>\package\jre\latest\bin\java.exe
```

Two consequences worth stating:

- **The JAR and `Assets.zip` are adjacent**, so a cache key combining both cannot
  go out of sync.
- **The game bundles its own JVM** (Temurin 25). We prefer it: it is
  version-matched to the JAR, and it means the user is never asked to install
  Java. `--jar` and `--assets` override detection; `--patchline` selects a
  non-active one, since several commonly coexist.

The bundled runtime is a **JRE, not a JDK** — `java.exe` but no `javac`. Enough
to run the generator, not enough to compile anything on the user's machine.

---

## How it is invoked

```
<bundled java> -jar <HytaleServer.jar> \
    --bare --disable-sentry \
    --assets <Assets.zip> \
    --generate-asset-schema <fresh temp directory>
```

`--bare` means no world and no ports. The process exits on its own in about 40
seconds; we do not kill it on success.

Run with `cwd` set to a scratch directory, `stdin` ignored, both output streams
piped. Timeout 10 minutes (`timeoutMs`), after which the child is killed and
`timedOut` is reported rather than thrown.

Success is not the exit code. The generator announces why it stopped, and we
match `shutdownReason.<...>.<Reason>` out of its log: **`schemaGenerated` means it
did what was asked**; anything else means it gave up before writing. The result
carries `exitCode`, `shutdownReason`, `schemaCount`, `elapsedMs` and `timedOut`,
and `cmdGenerateSchema` refuses to ingest unless the reason is right.

---

## The three hazards

All measured, all handled in code. They are the reason this lives in one module
with a scoped callback instead of a function returning a path.

### 1. The generator deletes its output directory first

`SchemaGenerator.cleanAndCreateSchemaDir()` wipes the target **before** writing.
Point it at a user's pack folder and their work is gone.

So the output directory is always a freshly created `mkdtemp` directory, never a
caller-supplied path. `--keep <path>` copies the result out **after** the run; the
generator is never pointed at it.

### 2. It sends telemetry, and nothing turns that off

The run logs `Sending server stop telemetry`, creates a `telemetry/` directory and
writes a session `.jsonl`. `TelemetryService` has `isEnabled()`/`setEnabled()`,
neither is public API, and **no CLI option is wired to them**.

`--disable-sentry` is a different thing — it turns off crash reporting. Saying
only "there is no such flag" made the disclosure contradict the command printed
six lines above it, and three blind trials called that out. The disclosure now
names both.

This is why `consent: true` is a required field on `GenerateOptions` with no
default. The module refuses to guess, because a silent network beacon is not a
tool's decision to make.

### 3. It writes configs into the working directory

Plugin configs and a server config land in `cwd`. Hence the scratch working
directory, created under the same temp root as the output so a single `rmSync`
removes schemas, telemetry and configs together.

---

## Consent

`askConsent` (`src/cli/consent.ts`) gates the run:

- prints the disclosure, then asks
- `--yes` pre-grants it
- `--dry-run` prints the exact command and the disclosure, and exits without
  running anything
- **non-interactive without `--yes` refuses.** Defaulting to yes in a script or CI
  would make the beacon fire silently, which is the single outcome this path
  exists to prevent

---

## Output handling

The generator emits hundreds of routine warnings — **437 of 444 lines on the
release corpus**. Echoing anything matching `WARN` buries the one line that
matters, so they are counted and only errors, exceptions and the shutdown reason
are shown.

Everything the caller needs must be read **while the temp directory still
exists**. `withGeneratedSchemas` takes a callback, runs it before the `finally`
that removes the root, and returns both the run result and the callback's value.
An earlier signature returned the path — and callers read from a directory the
function had already deleted.

The default keep location is `local/schema-release/`, which is gitignored:
**no Hytale-derived data may enter the repository** (EULA v2.2 §3.3). The indexer
reads schemas from there on subsequent runs, so the JAR is invoked once per game
version, not once per index build.

---

## What we do *not* do with it

- **Never run it as a server.** No world, no ports, no persistence.
- **Never decompile or repackage it.** The only bytecode facts recorded in
  `docs/init/` came from `javap` during a one-off investigation and are not part
  of any code path.
- **Never point it at user data.** Output and working directories are both
  temporary and both removed.
- **Never invoke it implicitly.** `index` will not start it; the schema is either
  already on disk or the corpus is indexed untyped. Only `generate-schema` runs
  the JAR, and only after consent.
