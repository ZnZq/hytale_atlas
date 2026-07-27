# OPEN QUESTIONS

**Working agreement:** when a blocker is hit during implementation, append it here
with enough context to be actionable, and continue with the next unblocked task.
Do not pause to ask. When a question is answered, record the answer inline, mark it
`RESOLVED`, and update the affected design document in the same change.

Questions are ordered by how much of the design depends on them.

---

## Verification provenance

Answers below marked `RESOLVED` were established on **2026-07-27** against a real
Windows installation:

| | |
|---|---|
| Install root | `%AppData%\Roaming\Hytale\` |
| Patchlines present | `release`, `pre-release` |
| Patchline verified | `release` |
| `Assets.zip` | 3 428 472 949 bytes, 60 148 entries |
| `HytaleServer.jar` | 123 347 829 bytes, 39 618 entries |
| Toolchain used | `javap` from Eclipse Adoptium JDK 25.0.1.8 |

Hytale is in Early Access. Re-verify anything load-bearing against a new patchline.

**Every answer below was obtained from files at rest — the JAR, the archive, pack
directories, and launcher metadata. The game was never launched.** This is not
incidental; it is the operating constraint in `01-VISION.md`. Two questions
originally filed as "needs a running game" (**Q5**, **Q7**) turned out to be
answerable from `HytaleServer.jar`, and the JAR answers were *better* than
observation would have been, because they describe the rule rather than one
instance of it. **When a question here looks like it needs the game, suspect the
framing before accepting the deferral.**

---

## Q1 — What exactly is Hytale's "Codec system"? ✅ RESOLVED

**Answer: a bespoke codec framework — *not* Mojang DataFixerUpper — and it is far
better for our purposes than DFU would have been, because every codec can emit its
own JSON Schema.**

The decisive fact:

```java
public interface com.hypixel.hytale.codec.Codec<T>
        extends RawJsonCodec<T>, SchemaConvertable<T>

public interface com.hypixel.hytale.codec.schema.SchemaConvertable<T> {
    Schema toSchema(SchemaContext);
    default Schema toSchema(SchemaContext, T);
}
```

**Every codec in the game is schema-convertible by construction.** There is no need
to trace builder bytecode, walk codec object graphs by reflection, or decompile
anything. Ask the codec for its schema and serialise the result.

`com.hypixel.hytale.codec.schema.config.Schema` is a full JSON-Schema model:

```
id, types[], title, description, markdownDescription,
anyOf[], oneOf[], allOf[], not, required[],
enumDescriptions[], markdownEnumDescriptions[],
definitions{}, ref, data, default (BsonDocument),
if / then / else,
hytale            -> Schema$HytaleMetadata
hytaleParent      -> Schema$InheritSettings
```

`Schema` itself carries `public static final ObjectCodecMapCodec<String, Schema>
CODEC`, so a schema can serialise itself to JSON with no hand-written writer.

**Sub-questions, answered:**

- *Static `Codec` field, annotations, or hand-written reader?* — a static field.
  `Item` declares `public static final AssetCodec<String, Item> CODEC` and
  `private static final AssetBuilderCodec$Builder<String, Item> CODEC_BUILDER`.
- *Are field names string literals in `<clinit>`?* — yes, the builder chain runs in
  `<clinit>`, but **this no longer matters**, because `toSchema()` supersedes it.
- *Is the codec reflectively walkable once constructed?* — moot; it exposes a
  schema directly.
- *Do defaults and optionality survive?* — yes: `Schema.default_` and
  `Schema.required[]`.
- *Shared base or registry enumerating all codecs?* — asset config classes
  implement `com.hypixel.hytale.assetstore.map.JsonAssetWithMap<K, V>` and expose
  a static `AssetStore` via `getAssetStore()` / `getAssetMap()`. That interface is
  the enumeration hook, and is more reliable than listing packages.

**Additional findings:**

- Field names, types and structure are accompanied by `title`, `description`,
  `markdownDescription` and `enumDescriptions` — **the game ships human-readable
  documentation of its own schema.** This is a significant, unanticipated windfall:
  `describe_schema` can return real prose, and that prose is also indexable for
  natural-language search.
- `com.hypixel.hytale.codec.schema.metadata.ui.*` carries Asset Editor UI hints
  (`UIEditorPreview`, `UITypeIcon`, `UIPropertyTitle`, `UISidebarButtons`,
  `UIEditorSectionStart`, `UIDisplayMode`, …). Useful for grouping and labelling
  fields the way the official editor does.
- `com.hypixel.hytale.codec.validation` (40 classes, incl. `ValidatorCache`,
  `LateValidator`) is the game's own validation layer. `Item` exposes
  `public static final ValidatorCache<String> VALIDATOR_CACHE`. **`validate_pack`
  may be able to reuse the engine's real validators rather than reimplementing
  them.** Worth a dedicated investigation — see Q17.
- The codec stack is built on **BSON** (`org.bson.BsonDocument`,
  `Codec.BSON_DOCUMENT`), not on a JSON DOM directly.
- `InheritCodec` and `RawJsonInheritCodec` exist, and `Schema.hytaleParent` is an
  `InheritSettings` — the asset inheritance mechanism is first-class in the codec
  layer. See **Q18**.

**Consequence:** `05-CODEC-EXTRACTION.md` was rewritten. Its three-approach risk
analysis is obsolete. Tier 2 drops from "highest risk component" to a small JVM
program.

---

## Q2 — Does the client installation include `HytaleServer.jar`? ✅ RESOLVED

**Answer: yes — and it ships a JVM alongside it.**

```
%AppData%\Roaming\Hytale\install\<patchline>\package\game\latest\
    Assets.zip                    3 428 472 949 bytes
    Server\HytaleServer.jar         123 347 829 bytes
%AppData%\Roaming\Hytale\install\<patchline>\package\jre\latest\
    Temurin 25.0.2+10 (Eclipse Adoptium)
```

Both `release` and `pre-release` patchlines carry a full set. `Assets.zip` and the
JAR are adjacent, exactly as the dedicated-server layout suggested, so a cache key
combining both hashes cannot go out of sync.

**Two consequences, both large:**

1. **Tier 2 is available to pack authors**, the primary audience — not only to
   plugin developers. Everyone with the game installed has the schema source.
2. **The JVM dependency for tier 2 is free.** The bundled Temurin 25 runtime
   satisfies the extractor's requirement, so the tool never has to ask a no-code
   user to install Java. The `06-CLI-UX.md` caveat "no Java → tier 1" is now an
   edge case rather than the expected path.

The bundled runtime is a **JRE, not a JDK** — it contains `java.exe` but no
`javap`/`javac`. That is sufficient to *run* an extractor; it is not sufficient to
compile one on the user's machine, so the extractor must ship pre-compiled.

---

## Q3 — Pack layout: `Common/` + `Server/`, or `assets/<type>/`? ✅ RESOLVED

**Answer: `Common/` + `Server/`. The `assets/<type>/` account does not describe the
vanilla archive.**

`Assets.zip` root contains exactly:

| Entry | Count |
|---|---|
| `Server/` | 35 194 |
| `Common/` | 24 914 |
| `Cosmetics/` | 38 |
| `manifest.json` | 1 |
| `CommonAssetsIndex.hashes` | 1 |

**`Cosmetics/` is a third top-level root** that no source documented. The indexer
must not assume exactly two roots.

The vanilla `manifest.json` is minimal, and confirms the `Hytale:Hytale` addressing
seen in the Asset Editor:

```json
{ "Group": "Hytale", "Name": "Hytale" }
```

A real third-party pack on disk
(`UserData\Saves\qqq\mods\Airijko_EndlessLevelingCore`) also uses `Server/`, so the
convention holds outside vanilla. Note that its manifest declares fields absent
from `02-DOMAIN.md` — `LoadBefore`, `SubPlugins` — and omits `ServerVersion` and
`Website`. **The manifest schema in the docs was incomplete; `LoadBefore` bears
directly on Q5.**

That pack also contains many directories that are plugin data rather than assets
(`augments/`, `classes/`, `races/`, `quests/`, `raids/`, `old/`, `security/`). The
indexer must not assume every directory in a pack holds assets, and should ignore
what it cannot type — silently, not as an error.

Still unverified: the layout inside a plugin JAR built with `IncludesAssetPack:
true`. Low risk now that two independent real packs agree.

---

## Q4 — What is the actual internal structure of `Assets.zip`? ✅ RESOLVED (mostly)

**60 148 entries, 3.43 GB.** The central directory reads in ~0.5 s, so **pass 1 over
paths is effectively free**; all real cost is in decompressing entry contents.

**Type directories are at the second level, PascalCase**, 51 in total. Largest:

```
Server/World       12175    Common/NPC          6039
Server/Prefabs      7831    Common/Icons        4832
Server/Item         6893    Common/Sounds       3857
Server/Particles    2344    Common/Characters   2724
Server/Audio        1761    Common/Blocks       2637
Server/NPC          1537    Common/Items        1033
Server/Drops         676    Common/BlockTextures 916
Server/Entity        269    Common/Languages     110
Server/Languages      11    Cosmetics/CharacterCreator 38
```

**A second-level directory is not an asset type.** `Server/Item` alone contains 14
distinct third-level groupings:

```
Items 3641   Interactions 1341   RootInteractions 611   Block 477
Recipes 403  ResourceTypes 181   Animations 146         Groups 43
Unarmed 20   CustomConnectedBlockTemplates 11            Qualities 11
Category 5   Reticles 2          PlayerToolsMenuConfig 1
```

and below that, arbitrary organisational nesting
(`Server/Item/Items/Rock/Magma/…`). **Path → asset type mapping must be derived
from the JAR's type registry, not guessed from directory depth.**

The JAR exposes 39 subpackages of `com.hypixel.hytale.server.core.asset.type`:

```
ambiencefx attitude audiocategory audiostate blockbreakingdecal blockhitbox
blockparticle blockset blocksound blocktick blocktype buildertool camera
entityeffect environment equalizereffect fluid fluidfx gamemode gameplay item
itemanimation itemsound model modelvfx musiccontainer particle physicalmaterial
portalworld projectile responsecurve reverbeffect soundevent soundset tagpattern
trail weather wordlist
```

These are **lowercase and do not map one-to-one onto the 51 PascalCase archive
directories** — 39 vs 51, and names differ (`Server/Prefabs`, `Server/World`,
`Server/Drops` have no matching subpackage; `blockhitbox`, `attitude`,
`responsecurve` have no obvious matching directory). Note also there is no
`entity` subpackage despite `Server/Entity` existing — entities are presumably ECS
prefabs rather than a codec-backed asset type.

**Do not reconcile this by hand — the engine ships the mapping.** The Asset Editor
carries an authoritative type table and a path resolver:

```java
class AssetEditorAssetType {            // protocol.packets.asseteditor
    public String id;                   // asset type id
    public String path;                 // its directory
    public String fileExtension;
    public AssetEditorEditorType editorType;
}

class AssetTypeRegistry {               // builtin.asseteditor
    Map<String, AssetTypeHandler> getRegisteredAssetTypeHandlers();
    AssetTypeHandler getAssetTypeHandlerForPath(java.nio.file.Path);   // <- pass 1 needs exactly this
    boolean isPathInAssetTypeFolder(java.nio.file.Path);
}
```

`AssetEditorSetupAssetTypes` is a **protocol packet**, i.e. the whole table is
already built to be serialised and shipped to the editor client. Extracting it is
the same class of work as extracting schema.

**This retires "path → type mapping" as a design unknown.** What remains is
execution, plus one caveat: `AssetTypeRegistry` is populated by `registerAssetType`
calls during Asset Editor plugin initialisation, so **determine the minimum
initialisation that populates it without booting a server** (`01-VISION.md`
§Operating constraint). Fallback if runtime population proves impractical: the
handler construction sites pass literal `id`/`path`/`fileExtension` strings, which
are readable from the constant pool.

The 39-vs-51 disagreement remains worth *reporting* — a directory with no
registered type is a real fact about the corpus — but it is no longer something the
indexer must guess its way through.

**One asset per file**, named by the asset ID.

**Identity is path-derived, not content-derived** — see Q16.

**`CommonAssetsIndex.hashes`** (3 028 686 bytes) is a precomputed manifest:

```
<sha256> <path relative to Common/>
2b693c02…c53 BlockTextures/Rock_Magma_Cooled_Adamantite_Cracks02.png
```

It covers the `Common/` tree only. Useful as a free content-hash source for the
frozen layer, and as a cross-check that the archive is complete.

**File references in JSON are `Common/`-relative paths, with extension:**

```json
"Icon":     "Icons/ItemsGenerated/Rock_Magma_Cooled_Brick_Decorative.png",
"Textures": [{ "All": "BlockTextures/Rock_Magma_Cooled_Brick_Decorative.png" }]
```

**Asset references are bare, unnamespaced short strings:**

```json
"Set": "Rock_Magma_Cooled",  "Parent": "Rock_Magma_Cooled_Brick",
"ResourceTypeId": "Rock_Magma_Cooled",  "Id": "Builders"
```

This confirms the low-confidence-noise concern in `03-ARCHITECTURE.md` is real and
not hypothetical. Codec schema is what promotes these to high confidence.

Still open: exact size percentiles and the non-JSON file-type census — folded into
Q11.

---

## Q5 — How does the engine resolve priority between packs? ✅ RESOLVED (mechanism)

**Answer: priority is by *pack source category*, declared as an enum with an
explicit comparison method. Not filename order.**

```java
public final class AssetPack$PackSource extends Enum<PackSource> {
    CLI, CLASSPATH, MODS, RUNTIME;          // ordinals 0,1,2,3
    public boolean overrides(PackSource other);
}
```

Decoded from `overrides()` bytecode — `if_icmpge` on the two `ordinal()` values,
returning `false` on greater-or-equal and `true` otherwise:

```java
boolean overrides(PackSource other) { return this.ordinal() < other.ordinal(); }
```

**Lower ordinal wins. Priority, highest first: `CLI` → `CLASSPATH` → `MODS` →
`RUNTIME`.**

That settles the standing doubt in `02-DOMAIN.md`: the community asset-loader
library's sorted-filename ordering is **that library's own convention**, not the
engine's rule.

Supporting structure on `AssetPack`: `name`, `root`, `fileSystem`
(a `java.nio.file.FileSystem` — archive packs are mounted, not unpacked),
`isImmutable`, `manifest` (`PluginManifest`), `packLocation`, `source`, and
`isCoreMod()`. `AssetPack implements com.hypixel.hytale.common.plugin.Mod`, so
packs and plugins share one abstraction.

**Two things this does NOT answer, and the second is the important one:**

1. `overrides()` returns **false for equal ordinals**, so it cannot resolve two
   packs in the same category — the common case, two mods both in `MODS`. The
   tiebreak lives elsewhere (candidates: registration order, `LoadBefore` from the
   manifest, dependency topology). **`is_effective` cannot be computed from
   `PackSource` alone.**
2. **Whether override is whole-asset replacement or field-level merge is still
   open**, and it is now sharper rather than softer: `Parent` (Q18) proves the
   engine already performs field-level inheritance *within* the corpus, and
   `InheritCodec` exists. If pack override reuses that machinery, `diff_override`
   semantics change substantially.

**How to check next, statically:** the `AssetStore` load path and `InheritCodec`,
plus wherever `LoadBefore` is consumed. Blocks Phase 4 only.

---

## Q6 — Game install paths per operating system ✅ RESOLVED (Windows)

```
%AppData%\Roaming\Hytale\
  patchline.json          <- machine-readable, see below
  settings.json           {"language":"en"}
  eula.txt
  install\<patchline>\package\game\latest\Assets.zip
  install\<patchline>\package\game\latest\Server\HytaleServer.jar
  install\<patchline>\package\jre\latest\                (bundled Temurin 25)
  UserData\
```

**Autodetection does not need to guess.** `%AppData%\Roaming\Hytale\patchline.json`
names the active patchline and the UserData root:

```json
{"patchline":"release","user_data":"C:\\Users\\<user>\\AppData\\Roaming\\Hytale\\UserData"}
```

Patchlines are sibling directories under `install\`, confirming that multiple game
versions coexist and that **content hashing, not version strings, must key the
cache**.

**Correction to `02-DOMAIN.md`:** user packs were documented at
`%AppData%/Roaming/Hytale/UserData/Packs/`. On this installation **`UserData\Packs`
does not exist**; `UserData\Mods\` does, and holds an installed mod
(`WeaponStatsViewer`). Editor-created packs live inside the world, as documented:
`UserData\Saves\<World>\mods\<PackName>\`. **The tool must probe, not assume.**

macOS and Linux install roots remain unverified.

---

## Q7 — Does the Asset Editor write files in a watcher-hostile way? ✅ RESOLVED

This was initially filed as "requires running the game". That was wrong: **the
Asset Editor is server-side, shipped as a builtin plugin inside
`HytaleServer.jar`** (`com.hypixel.hytale.builtin.asseteditor`), so its write path
reads statically like anything else.

**Answer: in-place whole-file writes. No temp-then-rename.**

`StandardDataSource.updateAsset(Path, byte[], EditorClient)` writes via:

```java
Files.write(path, bytes, CREATE, WRITE, TRUNCATE_EXISTING)
```

No `ATOMIC_MOVE`, no temp-file pattern anywhere in the class. `Files.move` appears
only in `moveAsset` / `moveDirectory`.

**Consequences for the watcher, and they cut both ways:**

- **Favourable:** writes are per-asset and whole-file. One saved asset = one changed
  file. No `.tmp` churn, no rename storms, no partial-directory rewrites. The
  watcher design stays simple.
- **Unfavourable:** `TRUNCATE_EXISTING` then write leaves a **real window where the
  file exists and is empty or partial**. A zero-length JSON file is the *expected*
  transient. The stability-check-and-retry mitigation in `03-ARCHITECTURE.md` is
  therefore required, not merely prudent.
- Renames surface as delete + create pairs; handle them as such.

**The editor hot-reloads from disk — confirmed.** `DataSource` declares:

```java
boolean       shouldReloadAssetFromDisk(Path);
java.time.Instant getLastModificationTimestamp(Path);
```

plus `AssetTypeHandler.loadAsset / unloadAsset / restoreOriginalAsset` and an
`UndoRedoManager`. The editor polls modification timestamps and reloads externally
changed assets.

**This closes the loop, which was the outcome this question hoped for:** agent
writes a file → our index sees it and validates → the editor picks it up live. It
is a genuine selling point and it is now established rather than assumed.

Full `DataSource` surface, useful for modelling what the editor can do to a pack:
`createAsset`, `updateAsset`, `deleteAsset`, `moveAsset`, `createDirectory`,
`deleteDirectory`, `moveDirectory`, `getAssetBytes`, `doesAssetExist`,
`isImmutable`, `getRootPath`, `getManifest`, `getFullPathToAssetData`.

---

## Q8 — How are ECS component types registered and discovered? ⚠️ PARTIAL

Not yet investigated directly. Two relevant findings from Q1/Q4:

- Asset config classes implement `JsonAssetWithMap<K, V>` and expose a static
  `AssetStore` — a discoverable registry pattern for *asset types*.
- There is no `entity` subpackage under `asset.type` despite `Server/Entity` and
  `Server/Prefabs` existing, which suggests entities/prefabs are composed rather
  than codec-backed as a single type.

The record-vs-map discrimination problem stands, but is now much less dangerous:
`toSchema()` distinguishes an `ObjectSchema` with fixed properties from a dynamic
map, so inference no longer has to guess for schema-covered fields.

---

## Q9 — Is `/assets` output parseable for cross-validation? ⛔ OUT OF SCOPE

**Demoted deliberately.** This question presupposes a running server, and
`01-VISION.md` §Operating constraint forbids the tool from depending on one. Even a
favourable answer could not be used at runtime.

The cross-validation it was meant to provide has a better static replacement: the
engine's own `AssetStore` / `AssetRegistry` / validator machinery, read from the
JAR (Q17). That checks the index against the rules the game *obeys*, rather than
against the output of one observed session — a stronger check, not a weaker
substitute.

Left on file because a one-off manual comparison during development is still
harmless and mildly informative. Nothing may be built on it.

---

## Q10 — What do Hytale's policies say about automated JAR analysis? ✅ RESOLVED

**Source:** `%AppData%\Roaming\Hytale\eula.txt` — Hytale EULA v2.2, effective
2026-01-13.

**§4.1(a)** — you may not *"reverse engineer, decompile, or disassemble the Game
**except as permitted by law**"*.

**§4.2 Interoperability Exception** — *"Nothing in this EULA limits your rights
under applicable law to conduct reverse engineering solely and to the extent
necessary to achieve interoperability between the Game and independently created
software, provided such activity is strictly limited to what the law permits and
does not disclose or misuse our proprietary information."*

**§3.1** — modding is explicitly encouraged. **§3.2(a)** and **§3.3** — you may not
distribute the Game in whole or in part, *"including its source code, any
decryption keys or any other files pertaining to the Game."*

**Assessment (not legal advice):**

The project's existing constraints already match what these clauses require, and
the Q1 outcome improves the position further:

1. **Prefer calling `toSchema()` over decompiling.** Loading the JAR and invoking a
   public API is ordinary interoperability use, not "decompile or disassemble".
   The now-obsolete Vineflower/ASM approaches sat squarely inside §4.1(a) and
   depended entirely on §4.2 to be permissible. **Q1's answer removes that
   exposure**, which is a second, independent reason to adopt it.
2. **Never redistribute extracted output.** §4.2's "does not disclose our
   proprietary information" and §3.3's distribution ban together mean extracted
   schema must stay in the user's cache. Already the design; now load-bearing.
3. **No Hytale-derived data in the repository or npm package.** Reaffirmed.
4. **Descriptive naming only.** §3.6 permits "Mod for Hytale"-style descriptive
   use; it forbids logos, trade dress, and anything implying endorsement. **The
   published package name and README must not imply official status.**
5. §4.2's scope is jurisdiction-dependent ("under applicable law"). Users in the
   EU have a statutory decompilation-for-interoperability right; other
   jurisdictions vary. Since the tool runs locally on the user's own installation
   and ships no game data, this affects the user, not the distributor.

**Verdict: the project is viable.** No clause prohibits a local tool that reads the
user's own installation for interoperability. Re-check on EULA version bumps.

Not established: whether "not obfuscated, freely decompilable" is an official
statement — it appears to be a community observation. The JAR is in fact
unobfuscated, as confirmed directly.

---

## Q11 — Practical corpus statistics ⚠️ PARTIAL

Gathered so far:

- 60 148 archive entries; 3.43 GB; 51 second-level directories
- `Server/Item/Items` = 3 641 item definitions; `Server/Item` total 6 893
- All 6 893 entries under `Server/Item` are `.json`
- 10 726 distinct localization keys across all locales
- Sample item JSON ≈ 1.2 KB with ~8 top-level fields

Still needed before Phase 2: size percentiles per type (drives elision thresholds
in `04-MCP-SURFACE.md`), reference density, and the accidental-ID-collision rate
that sets the low-confidence noise floor.

---

## Q12 — Is `.blockymodel` worth parsing?

Unchanged. Not investigated. Low priority — do not block on it.

Note `Server/Models` (436) and `Common/` model-adjacent trees exist, and the codec
registry has a `model` asset type, so model *metadata* may be reachable through
schema without parsing the binary format at all.

---

## Q13 — How stable are asset IDs across patchlines?

Unchanged — cannot be answered until a patch lands. However, **both `release` and
`pre-release` are installed side by side**, which makes this answerable *now* by
diffing the two archives' entry lists. Cheap, and it would give an early read on
rename frequency. Opportunistic, not blocking.

---

## Q14 — How does localization work? ✅ RESOLVED

**Answer: it works, it is explicit, and coverage is essentially complete for items.
Search does not need embeddings.**

**Format** — `.lang`, plain `key = value`, `#` comments, `# === section ===`
headers. 121 `.lang` files in the archive.

```
items.Armor_Adamantite_Chest.name = Adamantite Cuirass
assetEditor.messages.unknownItem  = Unknown Item "{id}"
```

**Locales shipped: 5** — `en-US`, `pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`.
`Server/Languages/fallback.lang` maps ~50 regional variants onto base locales
(`en-GB = en-US`, `ru-UA = ru-RU`, …) and references base locales that are **not
yet shipped** (`de-DE`, `es-ES`, `fr-FR`, `it-IT`, `pl-PL`, …), so more are
planned. Coverage: `uk-UA` has 9 435 of `en-US`'s 9 971 keys (94.6 %).

**Layout** — two roots:

```
Server/Languages/<locale>/server.lang        (714 KB en-US, 9 971 keys)
Server/Languages/<locale>/wordlists.lang
Server/Languages/fallback.lang
Common/Languages/<locale>/avatarCustomization/*.lang   (22 small files per locale)
```

**The reference is EXPLICIT, not conventional** — this is the key finding:

```json
"TranslationProperties": { "Name": "server.items.Rock_..._Decorative.name" }
```

Therefore `LOCALIZED_BY` edges are **observed, high-confidence**, not derived. The
lower-confidence fallback contemplated in `03-ARCHITECTURE.md` is unnecessary.

**Key prefix rule — do not miss this.** The referenced key is
`server.items.<Id>.name`, but the key **stored in the file** is `items.<Id>.name`.
The `server.` prefix corresponds to the **`Server/` root the lang file lives
under**. A naive string match finds zero matches across the entire corpus — the
first scan performed during this verification did exactly that and produced a false
"localization is missing" result. **Strip/derive the root prefix when joining.**
Presume `Common/Languages/…` resolves under a `common.` prefix; verify before
relying on it.

**Roles** under `items.*`: `name` (3 762), `description` (330), `nameFull` (1).

**Coverage:** 3 637 of 3 641 item definitions (99.9 %) carry
`TranslationProperties.Name`.

**Why this validates the design.** `items.Armor_Adamantite_Chest.name` resolves to
*"Adamantite Cuirass"*. A user searching "cuirass" finds nothing in the identifier
space — the ID says `Chest`. This is precisely the identifier/prose gap
`03-ARCHITECTURE.md` §Localization predicted, demonstrated on real data.

**Parsing complications to handle:**

- **Multi-line continuation** with a trailing `\`
- **ICU MessageFormat**, including nested plural forms:
  `other {{count, number} blocks}}` — brace-counting, not regex
- 810 of 9 971 en-US values contain `{placeholder}` interpolation

**Section namespaces in `server.lang`** (useful as a type-adjacent taxonomy):
`assetEditor assetTypes barter benchCategories builderTools chat commands customUI
entityEffects formatting general worldmap instances interactionHints interactions
io itemSets items map memories modules music npc npcRoles objectives portals
prefabs shop ui universe`.

---

## Q15 — Are schema-only fields actually usable? 🟡 PRODUCT-DEFINING — still open

Unchanged as a question, but **much cheaper to answer now** and with a better
chance of a clean result.

Because `toSchema()` yields `title`, `description`, `markdownDescription` and
`enumDescriptions`, a schema-only field usually arrives **with the game's own prose
attached**. That prose is very likely to distinguish a live capability from a
deprecated or engine-internal one — which is exactly the "detectable marker" this
question hoped for. Check the descriptions before running the in-game experiment.

**Static evidence to exhaust before any in-game experiment**, per
`01-VISION.md` §Operating constraint:

1. **The field's own `description` / `markdownDescription`** — deprecation and
   internal-use notes usually say so.
2. **Whether a validator is attached.** `AssetKeyValidator.updateSchema` (Q17)
   shows validators annotate the schema. A field the engine bothers to validate is
   a field the engine reads.
3. **Whether the field appears in the client protocol.** `com.hypixel.hytale.protocol`
   is in the same JAR; a property that never crosses to the client is a different
   kind of thing from one that does.
4. **Whether anything reads the getter.** The codec builder registers a
   getter/setter pair per field; if nothing outside the codec calls the getter, the
   field is decoded and then ignored.

Points 2–4 are the "detectable marker" this question hoped for, and all four are
available from files at rest.

The in-game experiment — three schema-only fields in a real pack, load, observe —
remains the ground truth and stays available as **one-off product research**. It is
not something the tool may depend on, and it should be the last step rather than
the first.

---

## Q16 — How is `logical_id` correctly derived? ✅ RESOLVED

**Answer: path-derived — the file's basename without extension. Identity is not
carried in the file.**

Evidence: `Server/Item/Items/Rock/Magma/Rock_Magma_Cooled_Brick_Decorative.json`
contains no `Id` or `Name` identity field, and its localization key is
`server.items.Rock_Magma_Cooled_Brick_Decorative.name` — the basename exactly, with
**no path segments**. Organisational nesting (`Items/Rock/Magma/`) is therefore
**not** part of identity. Independently, `AssetStore<String, Item, …>` keys assets
by plain `String`.

References confirm it: `"Parent": "Rock_Magma_Cooled_Brick"` and
`"Set": "Rock_Magma_Cooled"` are bare basenames.

**Rule:** `logical_id = <asset_type>:<basename without extension>`, with asset type
resolved from the type registry rather than from directory depth (see Q4).

Pack-level namespacing (`Hytale:Hytale` in the Asset Editor) is `Group:Name` from
the manifest and identifies the **pack**, not the asset. Whether asset IDs can also
be pack-qualified at reference sites is unverified — no namespaced reference was
observed in vanilla.

Still unverified: case sensitivity, and what the engine does with two files sharing
a basename in different directories of one pack. Both are cheap to test and worth
doing before Phase 4.

---

## Q17 — Can the engine's own validators be reused? 🆕 HIGH VALUE

**Discovered during Q1.** `com.hypixel.hytale.codec.validation` contains 40 classes
including `ValidatorCache` and `LateValidator`, and `Item` exposes
`public static final ValidatorCache<String> VALIDATOR_CACHE`.

**Why it matters:** `04-MCP-SURFACE.md` specifies `validate_pack` with
hand-written checks. If the engine's validators can be invoked directly on a
candidate asset, validation becomes *authoritative* rather than approximate — the
tool would report exactly what the game will reject, which is a far stronger claim
than "this field is unusual in the corpus."

**Substantially advanced during the Q5/Q7 investigation. Two findings:**

**1. Reference-typed fields mark themselves in the emitted schema.**

```java
public class AssetKeyValidator<K> implements Validator<K> {
    private final Supplier<AssetStore<K, ?, ?>> store;
    public void accept(K, ValidationResults);
    public void updateSchema(SchemaContext, Schema);      // <-- this
}
```

`updateSchema` means a validator **writes itself into the schema `toSchema()`
produces**. So a field validated by `AssetKeyValidator` is identifiable *in the
extracted schema* as a reference, along with which `AssetStore` it targets.

This is exactly the "High — the field is covered by extracted codec schema and
typed as a reference. Not a heuristic at all" tier that `03-ARCHITECTURE.md`
§Confidence hoped for, and it removes the guesswork for every field it covers.
Given that real references are bare unnamespaced strings (`"Set": "Rock_Magma_Cooled"`),
this is the difference between a usable reference graph and a noisy one.

**2. Missing-reference diagnosis is a first-class engine concept.**

```java
public class AssetValidationResults extends ValidationResults {
    void handleMissingAsset(String, Class<? extends JsonAsset>, Object);
    void disableMissingAssetFor(Class<? extends JsonAsset>);
    void logOrThrowValidatorExceptions(HytaleLogger, String, Path, int);
}
```

The engine already models "this asset points at something that does not exist",
including per-file, per-line reporting (`Path`, `int`). That is `validate_pack`'s
headline check, built in.

**Still to determine:** whether validators can run without a live server. This is
the one part that is *not* obviously free — `AssetKeyValidator` holds a
`Supplier<AssetStore>` and validates against a **populated** store, so using it
means loading the corpus through the engine's own `AssetStore`, not merely reading
schema. That is heavier than extraction but still short of booting a server;
`AssetRegistry.getStoreMap()` and `AssetPack`'s `FileSystem`-mounted roots suggest
it is reachable. Also determine whether `LateValidator` implies a two-phase model,
and whether error messages resolve through `assetEditor.messages.*` keys and can
therefore be rendered as real prose.

**⛔ Filed, not scheduled.** `05-CODEC-EXTRACTION.md` §Scope boundary excludes this
from Phase 2. Reading the schema marker is *reading a declaration*; running the
validators is *invoking behaviour*, which needs populated `AssetStore`s and couples
us to the engine's initialisation sequence rather than to what it declares.

The affordable consequence: `validate_pack` degrades to schema conformance plus
broken-reference detection — which is what the design specified in the first place.

**Revisit when** Phases 1–3 have shipped and validation demonstrably misses real
errors that these validators would have caught. Not before.

---

## Q18 — How does asset inheritance (`Parent`) work? 🆕 BLOCKING FOR `get_asset`

**Discovered during Q4.** A real item declares:

```json
"Parent": "Rock_Magma_Cooled_Brick"
```

and the codec layer has `InheritCodec`, `RawJsonInheritCodec`, and
`Schema.hytaleParent` typed as `Schema$InheritSettings`. **Asset definitions are
not self-contained.**

**Why it matters, immediately:**

- `04-MCP-SURFACE.md` defines `get_asset` as returning "full effective JSON
  definition". With inheritance, *effective* now means *after resolving the parent
  chain* — a different and larger job than reading one file. Returning the raw file
  would be actively misleading, since the agent would see a partial definition and
  conclude fields are absent.
- It creates a new edge kind (`INHERITS_FROM`) that is distinct from `OVERRIDES`:
  overriding is cross-pack and identity-based; inheritance is intra-corpus and
  explicit.
- Schema inference (pass 3) will **undercount** field usage if it aggregates raw
  files, because inherited fields never appear in the child document.
- It interacts with Q5: if pack override uses the same merge machinery, both
  problems share a solution.

**Determine:** merge semantics (deep merge? list concatenation or replacement?
null-as-delete?); whether chains can be multi-level or cyclic; whether `Parent` is
the only inheritance field or one of several; how `InheritSettings` in the schema
describes it.

**This is the most consequential newly discovered item.** It affects Phase 1
(`get_asset`) and Phase 2 (schema inference), not just later phases.

---

## Q19 — Does the engine already maintain the reference graph? 🆕 HIGH VALUE

**Discovered while resolving Q5/Q7.**

```java
public class AssetReferences<CK, C extends JsonAssetWithMap<CK, ?>> {
    private final Class<C> parentAssetClass;
    private final Set<CK> parentKeys;
    public <T extends JsonAssetWithMap<K, ?>, K> void addChildAssetReferences(Class<T>, K);
}
```

**The engine models asset → asset references as first-class data**, typed by asset
class and key, with a parent/child direction.

**Why it matters:** this project's central artifact is a reference graph, and
`03-ARCHITECTURE.md` builds it heuristically from string matching, with confidence
tiers to manage the noise. If the engine constructs an authoritative one during
load, and it is reachable, then large parts of pass 2 become *verification* rather
than *inference*, and `trace_refs` — the "what breaks if I change this" tool that is
the project's safest differentiator — rests on the engine's own answer.

**Determine:** when `AssetReferences` is populated and by what; whether it covers
all reference kinds or only some; whether it is reachable without a live server
(same boundary question as Q17 — it plausibly needs populated `AssetStore`s);
whether it survives as queryable state or is transient during load; how it relates
to `AssetKeyValidator`, which appears to be the per-field mechanism.

**⛔ Filed, not scheduled.** Same boundary as Q17: reaching this graph means
populating asset stores through the engine, i.e. invoking behaviour rather than
reading a declaration (`05-CODEC-EXTRACTION.md` §Scope boundary).

The heuristic resolver is needed regardless — for anything schema does not type,
and for the hot layer, where the user's in-progress pack may not load at all. And
reference confidence is already high for every schema-typed field, which is the
majority. So the marginal gain here is smaller than it first appeared.

**Revisit when** schema-typed references prove insufficient in practice — measured,
via the resolver-precision regression test in `09-EVALUATION.md`, not assumed.

---

## Newly discovered blockers

*(append below during implementation)*

- **Q17**, **Q18** and **Q19** above were discovered during Phase 0 verification and
  are filed as full questions rather than notes.
- **`FileIO` is read-only and lives in `com.hypixel.hytale.procedurallib.file`**,
  not where `02-DOMAIN.md` implied. Its surface is `exists`, `resolve`, `load`,
  `list`, `relativize`, `append` — **there is no write method**. It is the
  multi-root read overlay; writing goes through the Asset Editor's `DataSource`
  (Q7). Do not look for override semantics in `FileIO`.
- **The Asset Editor is a builtin server plugin**
  (`com.hypixel.hytale.builtin.asseteditor`, `AssetEditorPlugin`), not a client
  feature. Anything about its behaviour is statically readable.
- **`AssetRegistry.getStoreMap()`** returns
  `Map<Class<? extends JsonAssetWithMap>, AssetStore>` — a static, complete
  registry of asset types. This is the extraction entry point; prefer it over
  package-name scanning (`05-CODEC-EXTRACTION.md` §Entry points).
- **Tags are interned to ints globally** (`AssetRegistry.TAG_MAP`,
  `getOrCreateTagIndex`, `CLIENT_TAG_MAP`). Real assets carry a `Tags` block. If
  tags are queryable, they are a cheap and meaningful search facet.
- **Type-registry mismatch.** 39 JAR asset-type subpackages vs 51 archive
  directories, with names in different cases and no clean correspondence. Until
  resolved, path → type mapping is the weakest link in pass 1. See Q4.
- **`Server/World` and `Server/Prefabs` are a third of the corpus** (20 006 of
  60 148 entries) and have no matching codec asset type. Decide explicitly whether
  worldgen data belongs in the graph before it dominates every field statistic.
