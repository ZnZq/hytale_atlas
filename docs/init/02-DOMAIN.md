# 02 — Domain Facts

Everything here is marked with a confidence level. Read `README.md` §Confidence
markers first. Hytale entered Early Access on 13 January 2026 and its formats are
explicitly documented as subject to change between versions.

`[MEASURED]` marks facts established on **2026-07-27** by direct inspection of a
real Windows installation (release patchline: `Assets.zip` 3 428 472 949 bytes,
`HytaleServer.jar` 123 347 829 bytes). These supersede any `[REPORTED]` or
`[ASSUMED]` claim they contradict. See `OPEN-QUESTIONS.md` §Verification provenance.

---

## Modding categories

`[VERIFIED]` Mods split into three categories, as classified by CurseForge (the
official mod hub):

- **Packs** — content packs. JSON definitions plus models and textures. No code.
- **Plugins** — Java JARs against the server API. Java 25 required (hard
  requirement, not a recommendation). Entity Component System architecture.
- **Early Plugins** — bootstrap-level plugins for low-level class transformation.

`[VERIFIED]` Modding is server-side first. The pack or plugin is installed on the
server; clients receive it automatically on connect without manual download. Even
singleplayer connects to a local server.

`[VERIFIED]` Hytale has no text-based scripting and Hypixel Studios has stated they
do not intend to add it. A node-based visual scripting system is planned.

Source: https://hytale.com/news/2025/11/hytale-modding-strategy-and-status

---

## Pack structure

`[VERIFIED]` A pack is a folder or ZIP containing `manifest.json`.

`[MEASURED]` **Installed packs and mods do *not* reliably live at
`UserData/Packs/`.** On the verification machine that directory does **not exist**;
`UserData\Mods\` does, and contains an installed mod. Editor-created packs live
inside the world as documented below. **The tool must probe several locations, not
assume one.**

`[VERIFIED]` `manifest.json` fields, per official documentation:

```json
{
  "Group": "YourGroupName",
  "Name": "PackName",
  "Version": "1.0.0",
  "Description": "...",
  "Authors": [{ "Name": "...", "Email": "...", "Url": "..." }],
  "Website": "https://...",
  "ServerVersion": "*",
  "Dependencies": {},
  "OptionalDependencies": {},
  "DisabledByDefault": false
}
```

`[MEASURED]` **The documented field list is incomplete, and real manifests omit
parts of it.** A third-party pack on disk declares two fields absent from every
source — **`LoadBefore`** and **`SubPlugins`** — while omitting `ServerVersion` and
`Website` entirely:

```json
{
  "Group": "Airijko_Internal",  "Name": "EndlessLevelingCoreData",
  "Version": "0.0.0",           "Description": "...",
  "Authors": [],
  "Dependencies": {},           "OptionalDependencies": {},
  "LoadBefore": {},             "SubPlugins": [],
  "DisabledByDefault": true
}
```

`LoadBefore` matters beyond schema tolerance: it means **load order is at least
partly declarative in the manifest**, which bears directly on `OPEN-QUESTIONS.md`
Q5. Treat the manifest as open-ended — validate the fields you know and preserve
the rest rather than rejecting unknown keys.

`[MEASURED]` The vanilla archive's own manifest is minimal, and confirms the
`Hytale:Hytale` addressing seen in the Asset Editor:

```json
{ "Group": "Hytale", "Name": "Hytale" }
```

`[MEASURED]` A pack directory may contain a great deal that is **not** assets. The
third-party pack above carries `augments/`, `classes/`, `races/`, `quests/`,
`raids/`, `old/`, `security/` and a SQLite database beside its `Server/` tree.
The indexer must ignore what it cannot type, silently rather than as an error.

`[VERIFIED]` Two top-level directories beside the manifest:

- `Common/` — models and textures (anything visual)
- `Server/` — item and block definitions, translations, particles, gameplay data

Sources:
- https://support.curseforge.com/support/solutions/articles/9000273179-getting-started-with-packs
- https://hytalemodding.dev/en/docs/official-documentation/worldgen/pack-tutorial/asset-packs

`[VERIFIED]` Packs created in-game via the Asset Editor are stored inside the
current world, at approximately:

```
%AppData%/Roaming/Hytale/UserData/Saves/<World Name>/mods/
```

They must be copied to the main `Mods` folder to be reusable across worlds. **The
tool must not assume the working pack lives in the canonical `Packs/` path.**

`[VERIFIED]` Assets inside a pack override the base game asset with the same
identity. Adding new assets works the same way.

### Conflicting account of internal layout — RESOLVED

`[MEASURED]` **`Common/` + `Server/` is correct for the vanilla archive**, and a
real third-party pack independently uses `Server/`. The `assets/<type>/` account
below does not describe `Assets.zip`.

There is, however, a **third top-level root that no source documented**:

| Root | Entries |
|---|---|
| `Server/` | 35 194 |
| `Common/` | 24 914 |
| `Cosmetics/` | 38 |
| `manifest.json` | 1 |
| `CommonAssetsIndex.hashes` | 1 |

**Do not hardcode two roots.** Discover them.

The conflicting account is retained below for the record; the plugin-embedded case
remains unverified, but with two independent real packs agreeing, the risk is low.

`[REPORTED]` A community documentation site describes a different structure for
asset packs bundled inside a plugin JAR:

```
my-plugin.jar/
  manifest.json
  assets/
    blocktype/    item/       model/
    soundevent/   soundset/   particle/
    weather/      entity/     entityeffect/
    environment/
```

Source: https://doctale.dev/asset-development/overview/

This does **not** match `Common/` + `Server/`. Possibilities: the two describe
different nesting levels; one is outdated; standalone packs and plugin-embedded
packs genuinely differ. **See `OPEN-QUESTIONS.md` Q3 — this must be resolved by
inspecting a real `Assets.zip`.** The indexer must tolerate both layouts and fail
gracefully on a third.

---

## Vanilla asset corpus

`[MEASURED]` Client-side location on Windows, in full:

```
%AppData%\Roaming\Hytale\
  patchline.json      {"patchline":"release","user_data":"…\\Hytale\\UserData"}
  settings.json       {"language":"en"}
  eula.txt
  install\<patchline>\package\game\latest\Assets.zip
  install\<patchline>\package\game\latest\Server\HytaleServer.jar
  install\<patchline>\package\jre\latest\          <- Temurin 25.0.2+10
  UserData\
```

Two things follow, both consequential:

1. **`patchline.json` makes autodetection deterministic.** It names the active
   patchline and the UserData root. No path guessing is required on Windows.
2. **The client ships a JVM.** `install\<patchline>\package\jre\latest\` is an
   Eclipse Adoptium Temurin **25.0.2+10** runtime. Tier 2 therefore needs no Java
   installation from the user — see `OPEN-QUESTIONS.md` Q2 and `06-CLI-UX.md`.
   It is a JRE, not a JDK: `java.exe` is present, `javac`/`javap` are not, so any
   extractor must ship pre-compiled.

`[MEASURED]` Patchlines are **sibling directories** under `install\` — both
`release` and `pre-release` were present simultaneously, each with a full
`Assets.zip` + `HytaleServer.jar` set. This confirms multiple game versions coexist
and that the cache must be keyed by content hash, never by version string.

macOS and Linux install roots remain unverified (`OPEN-QUESTIONS.md` Q6).

`[VERIFIED]` Dedicated server layout keeps the archive and the JAR adjacent:

```
game/
  Assets.zip
  start.sh / start.bat
  jvm.options
  Server/
    HytaleServer.jar
    HytaleServer.aot
    config.json
```

Source: https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual

This adjacency is useful: schema source and corpus source are versioned together,
so a cache key combining both hashes cannot go out of sync.

`[MEASURED]` **`Assets.zip` is 3.43 GB, not "several hundred megabytes"** —
3 428 472 949 bytes containing **60 148 entries** on the release patchline. This is
roughly an order of magnitude above what the original design budgeted for, and it
makes streaming, per-entry extraction non-negotiable.

One property cuts the other way and is worth planning around: the ZIP central
directory is a compact index yielding every path and size without touching
compressed data, and per-entry random access is very cheap.

`[MEASURED]` Against the release archive, through the implemented reader
(`src/sources/archive.ts`):

| Operation | Cost |
|---|---|
| Read the central directory (60 148 entries) | **~4.0 s** |
| `list()` over a 3 641-entry prefix | ~1 ms |
| Decompress one asset JSON | **~0.13 ms** |

An earlier revision of this document claimed ~0.5 s for the directory read and
concluded pass 1 was "effectively free". The 0.5 s figure was real but measured
through .NET's `ZipArchive`; **our reader costs ~4 s**, and the difference is the
library's per-entry walk, not the archive format. Pass 1 is cheap and cached, not
free. If that ever matters, hand-rolling the directory read recovers the 0.5 s —
it is a reader problem, not a design problem.

`[MEASURED]` The archive root carries **`CommonAssetsIndex.hashes`** (3 028 686
bytes) — a precomputed `<sha256> <path>` manifest covering the `Common/` tree,
paths relative to `Common/`:

```
2b693c02…c53 BlockTextures/Rock_Magma_Cooled_Adamantite_Cracks02.png
```

A free content-hash source for the frozen layer, and a completeness cross-check.

`[REPORTED]` A community auth server implementation extracts individual entries on
demand rather than unpacking the whole archive, with lazy loading and an in-memory
cache. Naive full-corpus in-memory parsing is not viable.

Source: https://github.com/sanasol/hytale-auth-server

### Measured layout

`[MEASURED]` **51 second-level directories.** A second-level directory is *not* an
asset type — `Server/Item` alone holds 14 distinct third-level groupings
(`Items` 3641, `Interactions` 1341, `RootInteractions` 611, `Block` 477,
`Recipes` 403, `ResourceTypes` 181, `Animations` 146, …), below which nesting is
arbitrary and organisational (`Server/Item/Items/Rock/Magma/…`).

Largest directories:

```
Server/World  12175   Server/Prefabs 7831   Server/Item   6893
Common/NPC     6039   Common/Icons   4832   Common/Sounds 3857
Common/Characters 2724  Common/Blocks 2637   Server/Particles 2344
```

`[MEASURED]` **`Server/World` + `Server/Prefabs` are a third of the corpus**
(20 006 of 60 148 entries) and have no matching codec asset type. Decide
deliberately whether worldgen data belongs in the graph before it dominates every
field statistic.

`[MEASURED]` One asset per file, named by its ID. **Identity is path-derived** —
the basename without extension, excluding organisational path segments. No `Id`
field appears in the JSON. See `OPEN-QUESTIONS.md` Q16.

`[MEASURED]` **File references are `Common/`-relative paths with extension; asset
references are bare unnamespaced basenames.** From one real item:

```json
"Icon":   "Icons/ItemsGenerated/Rock_Magma_Cooled_Brick_Decorative.png",
"Set":    "Rock_Magma_Cooled",
"Parent": "Rock_Magma_Cooled_Brick"
```

The bare-string form is exactly the low-confidence collision case
`03-ARCHITECTURE.md` anticipates. It is real, not hypothetical.

`[MEASURED]` **Assets inherit.** `"Parent": "<other asset id>"` makes definitions
non-self-contained, and the codec layer has `InheritCodec` / `RawJsonInheritCodec`
to match. This affects `get_asset` and schema inference directly — see
`OPEN-QUESTIONS.md` **Q18**.

### Item anatomy

`[MEASURED]` Items are the largest codec-backed type (3 641 definitions) and the
one most requests touch. `Tool_Pickaxe_Iron.json`, abridged:

```json
{
  "TranslationProperties": { "Name":        "server.items.Tool_Pickaxe_Iron.name",
                             "Description": "server.items.Tool_Pickaxe_Crude.description" },
  "Parent": "Tool_Pickaxe_Crude",
  "Quality": "Uncommon",  "ItemLevel": 20,  "MaxDurability": 250,
  "Model":   "Items/Tools/Pickaxe/Iron.blockymodel",
  "Recipe": {
    "TimeSeconds": 3.5,
    "Input": [ { "ItemId": "Ingredient_Bar_Iron", "Quantity": 5 } ],
    "BenchRequirement": [ { "Id": "Workbench", "Type": "Crafting",
                            "Categories": ["Workbench_Tools"] } ]
  },
  "Tool": {
    "Specs": [ { "Power": 0.5, "GatherType": "Rocks", "Quality": 3 } ],
    "DurabilityLossBlockTypes": [ { "BlockSets": ["Stone","Rock","Ores"],
                                    "DurabilityLossOnHit": 0.25 } ]
  }
}
```

Four facts worth carrying forward:

1. **Recipes live inside the item**, not in a separate file. `Server/Item/Recipes/`
   holds 403 more, so both forms exist.
2. **Bench and category are one structure:**
   `BenchRequirement[{Id, Type, Categories[]}]`. `Id` names a bench asset, `Type`
   is a crafting-kind vocabulary (`Crafting`, `StructuralCrafting`), `Categories`
   are ids the bench declares. `Server/Item/Category/` holds the category assets.
3. **Inheritance is routine, not exotic.** The first tool opened during
   verification used `Parent`, and even borrows the parent's *description key*. The
   parent file is larger than the child (3 708 vs 2 201 bytes). A `get_asset` that
   returns the raw file shows an agent a materially incomplete definition.
4. **Vocabularies are bare strings throughout** — `GatherType` (`Rocks`, `Soils`,
   `OreIron`, `VolcanicRocks`, `Benches`…), `BlockSets`, `Categories`, `Type`,
   `Quality`. The corpus yields only *used* values; the codec schema yields the
   complete set. For authoring against a user's own bench or category, that
   difference is the whole answer.

### Capability boundaries between asset types

`[MEASURED]` **A gathering tool has no area of effect.** The complete `ItemTool`:

```
specs[], speed, durabilityLossBlockTypes, hitSoundLayerId, incorrectMaterialSoundLayerId
```

No width, radius, area or shape. Area and shape belong to a **different asset
type**, `buildertool`, whose `BuilderTool` config carries `builtin_Width`,
`builtin_Height`, `builtin_Thickness`, `builtin_Shape`, `builtin_Origin`,
`builtin_Mask`, `builtin_Density`, `builtin_Spacing`, with an 11-value
`BrushShape` enum (`Cube`, `Sphere`, `Cylinder`, `Cone`, `Pyramid`, `Dome`,
`Diamond`, `Torus`, …).

**This class of fact — where a capability lives, and where it demonstrably does
not — is invisible to corpus search**, because absence cannot be found by searching
what exists. It is the clearest justification for extracting schema, and it drives
the `search_schema` tool in `04-MCP-SURFACE.md` and the canonical evaluation
scenario in `09-EVALUATION.md`.

`[VERIFIED]` Vanilla assets are browsable in-game: in the Asset Editor, switch to
the `Hytale:Hytale` pack, locate an asset (e.g. `Armor_Bronze_Chest`), and copy it
into your own pack as a starting point.

`[VERIFIED]` Asset ID naming rule: only `A–Z`, `a–z`, `0–9`, and `_`. The first
letter and any letter following an underscore must be uppercase.

---

## Localization

`[VERIFIED]` The `Server/` directory of a pack holds translations alongside item and
block definitions, particles, and other gameplay data.

`[MEASURED]` **Q14 is resolved, favourably. Search does not need embeddings.**

Format is `.lang`: plain `key = value`, `#` comments, `# === section ===` headers.
121 `.lang` files ship in the archive, across two roots:

```
Server/Languages/<locale>/server.lang      714 KB / 9 971 keys (en-US)
Server/Languages/<locale>/wordlists.lang
Server/Languages/fallback.lang
Common/Languages/<locale>/avatarCustomization/*.lang
```

**Five locales ship:** `en-US`, `pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`.
`fallback.lang` maps ~50 regional variants onto base locales (`en-GB = en-US`) and
references base locales not yet shipped, so more are planned. `uk-UA` carries
9 435 of en-US's 9 971 keys (94.6 %).

**The asset → key reference is explicit, not conventional:**

```json
"TranslationProperties": { "Name": "server.items.Sword_Iron.name" }
```

This makes `LOCALIZED_BY` a **high-confidence observed edge**, not a derived one —
better than `03-ARCHITECTURE.md` assumed.

**Prefix rule — the one trap here.** The reference reads
`server.items.<Id>.name`; the key **stored in the file** is `items.<Id>.name`. The
`server.` prefix corresponds to the `Server/` root the lang file lives under. A
literal string match across the whole corpus returns **zero** hits. The first scan
run during verification made exactly this mistake and briefly concluded item
localization was missing entirely. Strip or derive the root prefix when joining.

**Coverage: 3 637 of 3 641 item definitions (99.9 %)** carry
`TranslationProperties.Name`. Roles observed under `items.*`: `name` (3 762),
`description` (330), `nameFull` (1).

**Why this validates the whole search design.**
`items.Armor_Adamantite_Chest.name` = **"Adamantite Cuirass"**. The identifier says
`Chest`; the player sees *Cuirass*. A user searching "cuirass" matches nothing in
the identifier space. This is the identifier/prose gap
`03-ARCHITECTURE.md` §Localization predicted, demonstrated on real data.

**Parsing complications:** multi-line continuation via a trailing `\`, and **ICU
MessageFormat** including nested plurals (`other {{count, number} blocks}}`) —
brace-counting, not regex. 810 of 9 971 en-US values contain `{placeholder}`
interpolation.

**Why this is not a minor gap.** Asset identifiers are machine names — `Sword_Iron`,
`Armor_Bronze_Chest`. Localization files are the only place in the corpus where
human-readable prose lives. That makes them the bridge between what a user asks for
("a flaming sword") and what the files are called, and therefore the foundation of
search. See `03-ARCHITECTURE.md` §Localization.

`[REPORTED]` A server config flag exists for debugging UI strings, which implies
localization keys can be surfaced raw in-game — potentially useful for verifying the
index against reality.

---

## Serialization

`[REPORTED]` **Hytale uses a "Codec system" to serialize and deserialize JSON
data**, described as allowing developers to build robust custom configuration
files.

Source: https://hytale.game/en/configuring-your-server-config-json-files/

`[MEASURED]` **It is a bespoke framework, not DataFixerUpper — and it exposes JSON
Schema directly.** The DFU analogy previously recorded here was wrong; the reality
is considerably better.

```java
public interface com.hypixel.hytale.codec.Codec<T>
        extends RawJsonCodec<T>, SchemaConvertable<T>

public interface com.hypixel.hytale.codec.schema.SchemaConvertable<T> {
    Schema toSchema(SchemaContext);
}
```

Every codec can emit its own schema, because the game's Asset Editor is a
schema-driven UI and needs exactly this. `Schema` is a full JSON-Schema model
(`types`, `required`, `default`, `anyOf`/`oneOf`/`allOf`, `definitions`, `ref`,
`if`/`then`/`else`) and — unanticipated by any design document — carries
**`title`, `description`, `markdownDescription`, and `enumDescriptions`**. The
game ships prose documentation of its own schema.

`Schema` has its own `CODEC`, so it serialises itself. No hand-written writer is
needed anywhere in the extraction path.

Notable neighbours:

- `com.hypixel.hytale.codec.validation` (40 classes, incl. `ValidatorCache`,
  `LateValidator`) — the engine's own validation layer, potentially reusable by
  `validate_pack`. See `OPEN-QUESTIONS.md` **Q17**.
- `InheritCodec` / `RawJsonInheritCodec`, and `Schema.hytaleParent` typed as
  `InheritSettings` — asset inheritance is first-class. See **Q18**.
- `com.hypixel.hytale.codec.schema.metadata.ui.*` — Asset Editor presentation hints.
- The stack is built on **BSON** (`org.bson.BsonDocument`), not a JSON DOM.

`[MEASURED]` Asset config classes carry `public static final AssetCodec<K, T>
CODEC`, implement `com.hypixel.hytale.assetstore.map.JsonAssetWithMap<K, V>`, and
expose a static `AssetStore` via `getAssetStore()`. That interface is a more
reliable enumeration hook than the package convention.

See `05-CODEC-EXTRACTION.md`, rewritten around this finding.

`[VERIFIED]` The server JAR is not obfuscated and can be freely decompiled.

`[REPORTED]` Asset system package root: `com.hypixel.hytale.server.core.asset.type`,
with per-type config classes such as
`com.hypixel.hytale.server.core.asset.type.item.config.Item` and
`...blocktype.config.BlockType`. The package convention
`...asset.type.<name>.config` implies asset types can be enumerated by listing
subpackages.

`[VERIFIED]` Plugin entry point: `com.hypixel.hytale.server.core.plugin.JavaPlugin`.
Plugin manifest carries `group`, `name`, `version`, `main`, `dependencies`, and
`includesAssetPack`.

`[REPORTED]` A `JsonLoader` class exists and loads files through the `FileIO`
abstraction rather than direct filesystem reads.

---

## Overlay and load order

`[MEASURED]` **`FileIO` is `com.hypixel.hytale.procedurallib.file.FileIO`, and it is
read-only.** Its entire surface is `exists`, `resolve`, `load`, `list`,
`startsWith`, `relativize`, `append`, plus `setDefaultRoot` and
`openFileIOSystem`/`closeFileIOSystem`. **There is no write, save, or store
method.** It is the multi-root read overlay; writing happens elsewhere (see
§Asset Editor below). Do not look for override semantics here.

`[MEASURED]` **Priority is resolved by pack *source category*, via an explicit enum
method** — not by filename order:

```java
public final class AssetPack$PackSource extends Enum<PackSource> {
    CLI, CLASSPATH, MODS, RUNTIME;                    // ordinals 0,1,2,3
    boolean overrides(PackSource o) { return this.ordinal() < o.ordinal(); }
}
```

**Lower ordinal wins: `CLI` > `CLASSPATH` > `MODS` > `RUNTIME`.**

`AssetPack` carries `name`, `root`, `fileSystem` (a `java.nio.file.FileSystem` —
**archive packs are mounted, not unpacked**), `isImmutable`, `manifest`,
`packLocation`, `source`, and `isCoreMod()`. It implements
`com.hypixel.hytale.common.plugin.Mod`: packs and plugins share one abstraction.

**Caveat that matters for `is_effective`.** `overrides()` returns **false for equal
ordinals**, so it does not resolve two packs in the same category — the common
case of two mods both under `MODS`. That tiebreak lives elsewhere (registration
order, manifest `LoadBefore`, or dependency topology) and is still open. See
`OPEN-QUESTIONS.md` Q5.

`[MEASURED]` **Override is whole-asset replacement, and the winner is the pack
registered LAST.** Read out of `CommonAssetRegistry` in the server jar:

```
assetByNameMap : Map<String, List<PackAsset>>     // PackAsset = record(pack, asset)

addCommonAsset(pack, asset):
    list = assetByNameMap.computeIfAbsent(asset.getName())
    scan list for an entry with the same pack()
      found -> list.set(i, new)      // same pack re-adding: replace in place
      else  -> list.add(new)         // APPEND. no sort, no comparator, no priority

getByName(name):
    list = assetByNameMap.get(name)
    return list == null ? null : list.getLast().asset()      // LAST WINS
```

Every definition is kept (hence `getDuplicatedAssets()` and `duplicateAssetCount`),
but exactly one is returned, whole. There is no field-level blending anywhere on
this path -- `set`/`add` move entire `PackAsset` objects, and the return type is a
single `CommonAsset`.

`[MEASURED]` **The typed `AssetStore` does no ordering of its own.** Its 4 870
lines of bytecode contain no reference to `PackSource`, `overrides`, `getLast`,
`sort`, `compareTo` or any priority field.

`[MEASURED]` **`AssetRegistryLoader.loadAssets(LoadAssetEvent, AssetPack)` takes
one pack at a time**, so pack order is set by its CALLER, not by the loader. The
`loadsAfter`/`loadsBefore` directives in that class (26 and 4 uses) order asset
STORES -- which asset TYPE loads before which -- and say nothing about packs.

`[MEASURED]` **`PackSource.overrides()` has nothing to do with asset conflicts.**
A constant-pool scan of all 8 728 `com/hypixel/` classes finds exactly two that
reference it: the enum itself and `AssetModule`. Its only call site:

```java
boolean registerPack(String name, Path path, PluginManifest m, PackSource source) {
    AssetPack existing = getAssetPack(name);        // looked up by PACK NAME
    if (existing != null) {
        if (existing.getSource().overrides(source)) {
            log("Asset pack '%s' already registered (%s), skipping %s");
            return true;                             // the new one is DROPPED
        }
        if (source.overrides(existing.getSource())) {
            log("Asset pack '%s' overriding %s with %s");
            ...                                      // the new one REPLACES it
```

That resolves one pack registered TWICE under the same name from different
sources -- the same pack passed on the CLI and also sitting in `mods/`. It never
sees an asset. Two different packs both defining `Armor_Adamantite_Chest` never
reach this code.

**Consequence for `is_effective`.** There is no per-asset priority in the engine
at all. Every asset collision is settled by load order alone, and load order is
not visible in the archives. Our `packs.priority` column therefore models
something the engine does not do; vanilla-loses-to-mod happens to be right, but
because the base game registers first, not because it ranks lower. Treat the
vanilla-vs-pack case as a safe BET and a pack-vs-pack case as unknown -- the
difference is confidence, not mechanism.

**Closed as out of scope:** who calls `loadAssets` and in what order. Load order
decides what happens in one player's install, and a mod author controls neither
which other mods are present nor how they are ordered. The question this tool
answers is what EXISTS and what is safe to build on:

- defined by the base game -> every player has it, build on it
- defined by a pack -> only players with that pack have it
- defined by two packs and not the base game -> not safe either way

None of those three need the load order. Tracing it would buy a prediction about
someone else's install, which is not a fact about how to write a mod.

`[REPORTED, CONTRADICTED]` doctale.dev's asset overview lists a three-tier
priority -- Core Assets < Plugin Assets < Override Packs. No class or code backs
it, the same site's registry page describes last-write-wins with no tiers, and
the only priority enum in the jar governs pack registration rather than assets.
Do not model it.

The community frameworks below are consistent with the measurement and were the
original, weaker evidence for it:

- **Hytalor** (137k+ downloads) -- "*Instead of overwriting entire JSON files*,
  Hytalor allows smaller patches which are merged together into a final asset at
  runtime." A patching framework is only needed because the engine replaces the
  whole file.
- **Zima** -- mods declare intent specs, it resolves conflicts and emits
  *generated override assets* as a runtime pack. It works inside the replace
  model rather than contradicting it.

So `is_effective` picking exactly one winner is correct, and a shadowed
definition is inert: it sits in its archive and is never loaded.

Concrete consequence: Endgame&QoL's `Bench_Weapon` has 11 top-level keys to
vanilla's 12, missing `PhysicalMaterialId`. Under replacement that key is simply
gone in a game with that pack installed. It is a bug in the pack, not a quirk of
this index.

The `Parent`/`InheritCodec` merge (Q18) is a DIFFERENT axis -- within one
asset's inheritance chain, not between packs. Conflating the two is what kept
this question open; `hytale.mergesProperties` says nothing about pack overlay.

Not resolved by the above: Zima ships its output as a "runtime pack" while
`PackSource.RUNTIME` has the *lowest* priority of the four ordinals. Either that
label means something other than the enum constant, or the tiebreak is subtler
than the enum suggests. Unverified either way -- do not build on it.

`[REPORTED]` A community asset-loader library processes external asset packs in
sorted filename order. **Now known to be that library's own convention**, not the
engine's rule.

Source: https://github.com/AzureDoom/Hytale-Custom-Asset-Loader

### Asset Editor — server-side, and statically readable

`[MEASURED]` The Asset Editor is a **builtin server plugin**
(`com.hypixel.hytale.builtin.asseteditor`, `AssetEditorPlugin`), not a client
feature. Its file operations go through a `DataSource` interface:
`createAsset`, `updateAsset`, `deleteAsset`, `moveAsset`, plus directory
equivalents, `getAssetBytes`, `isImmutable`, and `getManifest`.

`[MEASURED]` `StandardDataSource.updateAsset` writes **in place**:
`Files.write(path, bytes, CREATE, WRITE, TRUNCATE_EXISTING)`. No temp-then-rename,
no `ATOMIC_MOVE`. One saved asset produces exactly one changed file — but the
truncate leaves a real window in which the file is empty or partial.

`[MEASURED]` **The editor hot-reloads externally modified files.** `DataSource`
declares `shouldReloadAssetFromDisk(Path)` and `getLastModificationTimestamp(Path)`,
and `AssetTypeHandler` provides `loadAsset` / `unloadAsset` /
`restoreOriginalAsset` with an `UndoRedoManager` behind it.

This closes the authoring loop without the tool ever touching a running game: an
agent writes a file, the index sees and validates it, the editor picks it up live.
See `OPEN-QUESTIONS.md` Q7.

`[VERIFIED]` Packs are enabled per-world: right-click the world, open the mod list,
enable there.

---

## Plugin project shape

`[VERIFIED]` Canonical Gradle setup:

```kotlin
dependencies {
    compileOnly(files("libs/HytaleServer.jar"))
}
```

Compile against the server, do not bundle it. Gradle wrapper pinned (9.2.0 in at
least one template). Java 25 toolchain.

`[VERIFIED]` `./gradlew runServer` produces a `run/` directory containing generated
server files and the game's default assets. IntelliJ auto-creates a `HytaleServer`
run configuration on project open.

`[VERIFIED]` Plugin-bundled assets go in `src/main/resources/Common/` or
`src/main/resources/Server/`, and are editable in real time via the in-game Asset
Editor. `IncludesAssetPack: true` in the manifest activates them.

`[VERIFIED]` One template provisions the environment explicitly: unzips
`data/server/Assets.zip` into `data/assets`, and unpacks the server JAR into
`data/unpacked` via introspection. `data/` is gitignored and regenerated by setup.

Source: https://github.com/mbround18/hytale-modding-template

**This is manual execution of what this tool should automate.** Study it.

`[VERIFIED]` A Gradle plugin `com.azuredoom.hytale-tools` (Maven at
`https://maven.azuredoom.com/mods`) handles manifest generation, validation, local
server runs, IDE source setup, and optional hosted Javadoc injection. Task:
`./gradlew setupHytaleDev`. **Integration target, not a competitor.**

Source: https://github.com/HytaleModding/plugin-template

`[VERIFIED]` Hytale ships updates across multiple *patchlines* (release channels).
Templates select one via `gradle.properties`, which determines both the
`HytaleServer.jar` version compiled against and the version the run configuration
launches. **Multiple game versions can coexist on one machine.**

`[VERIFIED]` Built plugin JARs are installed to `%appdata%/Hytale/UserData/Mods/`.

---

## Diagnostics available in-game — ⛔ not a source for this tool

`[REPORTED]` Server commands `/assets` (query and analyse loaded resources) and
`/packs` (manage and list active content packs).

Source: https://hytale.game/en/managing-resources-and-content-packs/

**These were previously floated as a cross-validation channel. They are not
available to us:** `01-VISION.md` §Operating constraint forbids the tool from
depending on a running game. See `OPEN-QUESTIONS.md` Q9, demoted.

The static replacement is better anyway. `AssetRegistry.getStoreMap()`,
`AssetStore`, `AssetKeyValidator` and `AssetValidationResults` all live in the JAR
and describe the rules the game *obeys*, rather than the output of one observed
session.

---

## Legal

`[VERIFIED]` Community projects that touch server binaries explicitly decline to
redistribute Hytale binaries or assets, and place responsibility on the user to
obtain files through official channels and comply with the EULA.

**Design constraints that follow:**

1. Extraction runs **locally, on the user's own installation**.
2. The tool ships **no** Hytale-derived data — no bundled schema dumps, no cached
   corpus, no asset listings in the repository or the npm package.
3. Generated index artifacts live in the user's cache directory and are never
   uploaded anywhere.
4. Do not vendor decompiled Hytale source into the repository.

`[MEASURED]` **Hytale EULA v2.2** (effective 2026-01-13), read from
`%AppData%\Roaming\Hytale\eula.txt`. Q10 is resolved: **the project is viable.**

- **§3.1** modding is explicitly encouraged; **§3.2(a)** and **§3.3** forbid
  distributing the Game in whole or part, "including its source code, any
  decryption keys or any other files pertaining to the Game."
- **§4.1(a)** forbids "reverse engineer, decompile, or disassemble the Game
  **except as permitted by law**".
- **§4.2 Interoperability Exception** preserves statutory reverse-engineering
  rights "solely and to the extent necessary to achieve interoperability between
  the Game and independently created software", conditioned on not disclosing or
  misusing proprietary information.
- **§3.6** permits descriptive use of the name ("Mod for Hytale") but forbids
  logos, trade dress, or anything implying endorsement.

Consequences, beyond the four constraints above:

5. **Prefer `toSchema()` over decompilation.** Calling a public API is ordinary
   interoperability use and does not engage §4.1(a) at all. The obsolete
   decompilation approach depended entirely on §4.2 to be permissible — a second,
   independent reason the Q1 finding improves the project's position.
6. **Never transmit extracted schema.** §3.3 plus §4.2's non-disclosure condition.
7. **Descriptive naming only** for the published package and its README (§3.6).
8. §4.2's scope is jurisdiction-dependent. Since the tool runs locally on the
   user's own installation and ships no game data, this falls on the user rather
   than the distributor.

Not legal advice. Re-check on EULA version bumps.

`[MEASURED]` The server JAR is in fact unobfuscated — confirmed directly. Whether
"freely decompilable" is an official statement or a community observation remains
unestablished.
