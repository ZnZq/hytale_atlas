# 05 — Schema Extraction

**Status: solved, and not by us.** The server ships a documented batch mode that
generates the schemas itself.

This document has been rewritten twice. The first version planned to recover schema
by reflection, ASM bytecode analysis, or decompilation, and rated the work "highest
risk, highest value". The second discovered `Codec<T> extends SchemaConvertable<T>`
and planned a small reflective extractor. Both are obsolete: **the game has a CLI
flag for exactly this.** See §Historical note.

Verified 2026-07-27 against the release patchline.

---

## The command

```
java -jar HytaleServer.jar \
     --bare \
     --assets <Assets.zip> \
     --generate-asset-schema <output-dir>
```

From the server's own `--help`:

> `generate-asset-schema` — Generate asset JSON schemas to the specified directory and exit
> `generate-config-schema` — Generate config JSON schemas to the specified directory and exit
> `bare` — Runs the server bare. For example without loading worlds, binding to ports or creating directories.

Measured: **~40 seconds**, exits with shutdown reason `schemaGenerated`.

`Assets.zip` can be passed directly — archive packs are mounted as a
`java.nio.file.FileSystem` rather than unpacked (`AssetPack.fileSystem`). Asset
loading is a precondition: without `--assets` the server exits with
`missingAssets.failedToLoad`.

---

## What it produces

**104 schema files, 12.7 MB**, in a fixed layout under the given directory:

```
<output-dir>/
  Schema/<TypeName>.json      104 files, incl. shared common.json and other.json
  .vscode/settings.json       102 fileMatch -> schema bindings
```

### The schemas

Real JSON Schema, with cross-file `$ref` (`common.json#/definitions/ItemTool`,
`CraftingRecipe.json#`), `$id`, `title`, `properties`, `additionalProperties`,
`default`, and enums.

**17 641 field descriptions**, many with `markdownDescription`. The game documents
its own schema, because this output drives a VS Code authoring workflow.

Each schema root carries a `hytale` block with **`path` and `extension`** — the
asset type table, embedded:

```
BlockGroup           -> Item/Groups        *.json
BlockBoundingBoxes   -> Item/Block/Hitboxes
AttitudeGroup        -> NPC/Attitude/Roles
```

Paths are relative to `Server/` and are frequently three levels deep, confirming
that a second-level directory is not an asset type (`OPEN-QUESTIONS.md` Q4).

### The `hytale` metadata block

Counts across all 104 schemas:

| Key | Count | Meaning |
|---|---|---|
| `type` | 24 153 | **JSON** type marker (`string`, `object`, `Enum`, `EnumMap`, `Color`, …) — *not* an asset reference |
| `uiPropertyTitle` / `uiDisplayMode` | ~10 200 each | Asset Editor presentation |
| **`inheritsProperty`** | 3 024 | this field is inherited from `Parent` |
| **`mergesProperties`** | 1 237 | this field merges rather than replaces |
| `uiEditorComponent` | 259 | which editor picker the field uses |
| `path` / `extension` | 102 each | the type table |
| `internalKeys`, `idProvider`, `allowEmptyObject` | few | |

`inheritsProperty` and `mergesProperties` answer `OPEN-QUESTIONS.md` **Q18 at field
granularity** — not just "inheritance exists" but which fields do what.

### The `.vscode` bindings

```json
{ "fileMatch": ["/Server/Audio/AmbienceFX/*.json",
                "/Server/Audio/AmbienceFX/**/*.json"],
  "url": "./Schema/AmbienceFX.json" }
```

An independent, machine-readable statement of the same path → type mapping. Use it
to cross-check the embedded `hytale.path`; a disagreement is a bug worth surfacing.

---

## Hazards — all three are real

### 1. It wipes the output directory

`SchemaGenerator.cleanAndCreateSchemaDir(Path)` **deletes the target directory
before writing.** Point it only at a freshly created temp directory. Pointing it at
a user's pack folder would destroy their work.

This is not hypothetical carelessness to guard against later — it is the first
thing the generator does.

### 2. It emits telemetry, and that cannot be disabled

The run logs `Sending server stop telemetry`, creates a `telemetry/` directory in
the working directory, and writes a session `.jsonl`. `TelemetryService` exposes
`isEnabled()` / `setEnabled(boolean)`, but neither is public API and **no CLI option
is wired to them**. Of ~50 options there are `--disable-sentry`,
`--disable-file-watcher` and `--disable-asset-compare`, but nothing for telemetry.

**The tool must disclose this before running schema generation.** A user is
entitled to know that this step starts the vendor's server binary and that the
binary phones home. Do not bury it in a log line.

The run also writes plugin configs and a server config into the working directory,
so give it a scratch working directory of its own, not the user's project.

### 3. `common.json` is not valid JSON

It contains bare `NaN`, which `JSON.parse` rejects. Measured on the release
patchline: **103 of 104 files parse strictly; `common.json` has exactly three
occurrences**, all in one place —

```
/definitions/RailPoint/properties/Normal/default/{X,Y,Z}
```

— a rail point's normal vector with no meaningful default. `Infinity` does not
currently appear but is the same class of defect.

**Do not repair this with a regex.** The obvious
`/(?<=[:\[,\s])(NaN|Infinity)/ → null` happens to work on today's input, but the
same corpus contains **640 occurrences of these words inside string literals** —
field descriptions are prose, and one reading *"the value NaN, which means…"* would
be silently corrupted. The reader must track string state.

Implemented in `src/util/json.ts` (`parseJsonLenient`), which is string-aware and
**reports** repairs as JSON Pointers rather than applying them silently: a `default`
that was `NaN` means *unset*, which is a more useful thing to tell a pack author
than `default: null`. `src/util/json.integration.test.ts` re-checks the whole
schema set and fails if the shape of the defect changes after a patchline update.

---

## What it does NOT give us

**Asset reference targets ARE machine-marked, via `hytaleAssetRef`.** This corrects
two earlier claims in this document, in opposite directions.

The first revision assumed `AssetKeyValidator.updateSchema(SchemaContext, Schema)`
annotated reference fields with their target `AssetStore`. The second concluded
from the generated output that nothing of the sort existed. Both were wrong: the
marker is real, but it is a **sibling of the `hytale` block, not a member of it** —
which is exactly why reading it from inside `hytale` returned null for all 932
fields and looked like proof of absence.

```json
"Icon": {
  "type": ["string", "null"],
  "hytaleAssetRef": "Texture",
  "hytale": { "type": "string", … }
}
```

`hytale.type` really is a JSON-type marker, not a pointer to an asset type — that
part stood. `hytaleAssetRef` is the pointer, and it covers 849 fields across 70
types. `describe_schema` surfaces it as `declared.referenceTarget`, and pass 2
resolves declared-target references before falling back to name heuristics.

Further signal, still worth mining:

- **`hytale.uiEditorComponent`** (259 fields) names the editor picker and sometimes
  a path template — `Icon` carries
  `{"component":"Icon","defaultPathTemplate":"Icons/ItemsGenerated/{assetId}.png"}`.
  That identifies both the reference kind and its file convention.
- **`$ref` structure** types nested objects precisely, even where leaf strings are
  untyped.
- Field descriptions sometimes name the target type in prose.

**Consequence for `03-ARCHITECTURE.md` §Confidence: the "High — typed by schema, not
a heuristic at all" tier is real but still a minority of fields** — 849 of 17 400.
Reference resolution stays substantially heuristic outside them, and the confidence
tiers stay load-bearing.

---

## Extraction contract

The tool's extraction step is a **subprocess invocation**, not a program we write.
There is no Java code in this project.

1. Create a fresh temp directory; never reuse and never point at user content
2. Run the command above with the working directory set to that temp directory
3. Read `Schema/*.json` (tolerating `NaN` in `common.json`) and `.vscode/settings.json`
4. Normalise into the index's own store, keyed by **JAR content hash**
5. Delete the temp directory, including `telemetry/` and the written configs
6. Record in `status()`: schema count, type count, generator exit reason, and the
   fact that telemetry was emitted

Cache aggressively — this is minutes of a user's time and a network beacon per run.
Re-run only when the JAR hash changes.

---

## Adjacent capability, now reachable

The same batch surface offers:

```
--validate-assets           exit non-zero if any assets are invalid
--validate-prefabs          same for prefabs
--shutdown-after-validate   exit once validation completes
```

This reopens `OPEN-QUESTIONS.md` **Q17** in a much better form. The question is no
longer "can we invoke the engine's validators by reflection" — it is "should we
shell out to a documented validation mode". That is the same class of action as
schema generation, with the same hazards and the same disclosure requirement.

Still filed, not scheduled: evaluate after Phases 1–3 show what validation misses.

---

## Legal boundary

Verified against Hytale EULA v2.2 (`OPEN-QUESTIONS.md` Q10). The official batch
mode strengthens the position further:

- **We now run the vendor's own documented tool** rather than reflecting into
  internals. §4.1(a) on reverse engineering is not engaged at all.
- Extraction runs locally, on the user's own installation.
- The repository and published package contain **no** extracted Hytale data.
- Generated schema lives in the user's cache and is never transmitted.
- Package naming and README must be descriptive only (§3.6).

---

## Historical note

Three generations of plan, recorded because the progression is instructive:

1. **Reverse-engineer the codecs** — reflection, ASM, or Vineflower. Rated highest
   risk in the project. Obsolete once Q1 was checked.
2. **Reflect over `toSchema()`** — a small Java extractor calling
   `AssetRegistry.getStoreMap()` then `codec.toSchema(new SchemaContext())`. Built
   and run; it failed at `AssetRegistryLoader.init()` because
   `Options.getOptionSet()` was null — the registry is populated by server
   bootstrap, not by class loading. Deleted.
3. **Run `--generate-asset-schema`** — the current plan.

Each step was a page of careful reasoning replaced by five minutes of checking. The
recurring lesson, now three for three: **look at the artifact before designing
around it.** Reading `--help` would have found this on day one.
