# 02 — Domain Facts

Everything here is marked with a confidence level. Read `README.md` §Confidence
markers first. Hytale entered Early Access on 13 January 2026 and its formats are
explicitly documented as subject to change between versions.

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

`[VERIFIED]` A pack is a folder or ZIP containing `manifest.json`. User packs live at:

```
%AppData%/Roaming/Hytale/UserData/Packs/<PackName>/
```

`[VERIFIED]` `manifest.json` fields:

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

### Conflicting account of internal layout

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

`[VERIFIED]` Client-side location, reachable via launcher → Settings → Open
Directory:

```
<install>/release/package/game/latest/Assets.zip
```

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

`[REPORTED]` `Assets.zip` is typically several hundred megabytes. A community auth
server implementation extracts individual entries on demand rather than unpacking
the whole archive, with lazy loading and an in-memory cache. Naive full-corpus
in-memory parsing is not viable.

Source: https://github.com/sanasol/hytale-auth-server

`[VERIFIED]` Vanilla assets are browsable in-game: in the Asset Editor, switch to
the `Hytale:Hytale` pack, locate an asset (e.g. `Armor_Bronze_Chest`), and copy it
into your own pack as a starting point.

`[VERIFIED]` Asset ID naming rule: only `A–Z`, `a–z`, `0–9`, and `_`. The first
letter and any letter following an underscore must be uppercase.

---

## Localization

`[VERIFIED]` The `Server/` directory of a pack holds translations alongside item and
block definitions, particles, and other gameplay data.

`[UNKNOWN]` Everything else: file format, naming, how an asset references its
display name, how many locales ship, and what fraction of vanilla assets have
entries. See `OPEN-QUESTIONS.md` **Q14**, which is a Phase 0 item.

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

`[ASSUMED]` This is analogous to Mojang's DataFixerUpper `Codec` — declarative,
composable, constructed in static initializers, carrying field name, type,
optionality, and default. **This assumption drives the entire schema-extraction
design in `05-CODEC-EXTRACTION.md` and is the single most important thing to
verify.** See `OPEN-QUESTIONS.md` Q1.

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

`[VERIFIED]` `FileIO` provides a virtual filesystem with multi-root support, so mod
assets layer over base assets and override them.

`[REPORTED]` A community asset-loader library processes external asset packs in
sorted filename order, deliberately, so that pack authors can control priority
through filenames. This is that library's own convention and may not reflect the
engine's rule.

Source: https://github.com/AzureDoom/Hytale-Custom-Asset-Loader

`[UNKNOWN]` How the engine actually resolves priority when two packs define the
same asset ID. See `OPEN-QUESTIONS.md` Q5. This matters directly: the
`is_effective` flag on `Asset` nodes depends on it.

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

## Diagnostics available in-game

`[REPORTED]` Server commands `/assets` (query and analyse loaded resources) and
`/packs` (manage and list active content packs, including those supplied by
plugins). Potentially useful as a cross-validation channel — compare what the game
loaded against what the index believes exists.

Source: https://hytale.game/en/managing-resources-and-content-packs/

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

`[UNKNOWN]` Whether Hytale's server policies place further limits on automated
JAR analysis. See `OPEN-QUESTIONS.md` Q10. Official policy pages are linked from
Hytale Support; check them before publishing.
