# 05 — Codec Extraction

**Status: substantially de-risked.** This document previously described the
highest-risk component in the project, built on the assumption (`Q1`) that Hytale
used DataFixerUpper-style codecs whose structure would have to be recovered by
reflection, bytecode tracing, or decompilation.

**That assumption was wrong, and the reality is much better.** Verified 2026-07-27
against `HytaleServer.jar` (release patchline). See `OPEN-QUESTIONS.md` Q1.

---

## The finding

```java
public interface com.hypixel.hytale.codec.Codec<T>
        extends RawJsonCodec<T>, SchemaConvertable<T>

public interface com.hypixel.hytale.codec.schema.SchemaConvertable<T> {
    Schema toSchema(SchemaContext);
    default Schema toSchema(SchemaContext, T);
}
```

**Every codec in the game can emit its own JSON Schema.** The game needs this for
its own Asset Editor, which is a schema-driven UI. We are not reverse-engineering
a serialization format; we are calling a supported API that already produces
exactly the artifact this project wanted.

The three approaches this document used to weigh — runtime reflection over codec
object graphs, ASM bytecode analysis, Vineflower decompilation — are all obsolete.
They are retained only in §Historical note.

---

## Why this still matters

Unchanged from the original rationale, and now cheaply achievable:

| Source | Answers |
|---|---|
| Corpus (`Assets.zip`) | What is idiomatic. Which fields co-occur. Real examples. |
| Codec schema (server JAR) | What is **legal**. Complete field set, types, defaults, optionality, **and the game's own prose documentation**. |

The diff between the two remains the intended product: fields the schema permits
that appear in zero vanilla assets. See `01-VISION.md` criterion 6 and
`OPEN-QUESTIONS.md` Q15 — the caveat there still stands, but Q15 is now much more
likely to resolve favourably, because schema-only fields arrive with descriptions
attached that usually reveal whether a field is live or vestigial.

---

## Scope boundary — what we extract, and what we do not

**This list is fixed. Adding to it is a decision, not a discovery.**

Phase 0 kept finding useful things in the JAR — validators, a reference graph, pack
priority, editor write behaviour — and the natural drift is to reach for all of
them. That drift is what this section exists to stop.

### The line: read data, do not invoke behaviour

| | Cost | Verdict |
|---|---|---|
| **Read data** — load classes, call `toSchema()`, serialise, exit | One process, one run per game version, output cached by content hash | **In scope** |
| **Invoke behaviour** — run validators, populate `AssetStore`s, replicate engine lifecycle | Requires initialised stores and an engine-shaped environment; couples us to how the game *runs*, not just what it *declares* | **Out of scope** |

The fragility is entirely on the second row. Reading a declaration is stable across
patches in a way that depending on an initialisation sequence is not.

Note the corollary, because it is easy to miss: **learning a rule from the JAR does
not create a dependency on the JAR.** Pack priority (`PackSource.overrides()`,
`OPEN-QUESTIONS.md` Q5) and Asset Editor write semantics (Q7) were both read
statically and then written down. We implement those ourselves in a few lines. They
are knowledge, not coupling.

### What the extractor produces — the whole list

1. **The asset type table** — `id`, `path`, `fileExtension` per registered type.
   Without it, nothing else can be joined to a file on disk.
2. **The codec schema per type** — `toSchema()` output: fields, types, optionality,
   defaults, enum values, and the game's own `title` / `description` /
   `enumDescriptions` prose.
3. **Reference-typed field markers** — which fields point at which asset store.

**Item 3 costs nothing.** `AssetKeyValidator.updateSchema(SchemaContext, Schema)`
means a reference-validated field writes itself into the very schema item 2 already
produces. The same is true of `Schema.hytaleParent` (`InheritSettings`), which is
how inheritance semantics arrive — also free, also inside item 2.

That is the entire extraction surface. One program, one run.

### Explicitly excluded, with the trigger to revisit

| Excluded | Why it looked attractive | Revisit when |
|---|---|---|
| **Q17** — executing the engine's validators | `validate_pack` would report exactly what the game rejects | Phases 1–3 ship and validation demonstrably misses real errors |
| **Q19** — the engine's `AssetReferences` graph | Authoritative relationships instead of inferred ones | Schema-typed references prove insufficient in practice |
| Pack priority *logic* | Already solved — we know the rule and implement it ourselves | Never; this is knowledge, not a dependency |
| Editor write path | Same — knowledge, not a dependency | Never |

Both exclusions are genuinely affordable. `validate_pack` degrades to schema
conformance plus broken-reference detection, which is what the design originally
specified. Reference confidence stays high for every field the schema types, which
is the majority.

**Do not pursue Q17 or Q19 during Phase 2.** They are filed, not scheduled.

## What `Schema` contains

`com.hypixel.hytale.codec.schema.config.Schema` is a full JSON-Schema model:

```
id                        types[]              title
description               markdownDescription
anyOf[]  oneOf[]  allOf[]  not
required[]
enumDescriptions[]        markdownEnumDescriptions[]
definitions{}             ref                  data
default (BsonDocument)
if / then / else
hytale        -> Schema$HytaleMetadata
hytaleParent  -> Schema$InheritSettings
```

Subtypes: `ObjectSchema`, `ArraySchema`, `StringSchema`, `NumberSchema`,
`IntegerSchema`, `BooleanSchema`, `NullSchema`, plus `NamedSchema`.

Three parts of this deserve emphasis:

1. **`title` / `description` / `markdownDescription` / `enumDescriptions`.** The
   game ships human-readable documentation of its own schema. This was not
   anticipated anywhere in the original design. It makes `describe_schema` far more
   useful than "field name and type", and the prose is independently valuable as
   FTS input for natural-language search.
2. **`required[]` and `default`** give optionality and defaults directly. No
   inference needed.
3. **`hytaleParent` / `InheritSettings`** describes the `Parent` inheritance
   mechanism found in real assets. See `OPEN-QUESTIONS.md` Q18 — this is a
   first-class part of the data model, not an edge case.

`Schema` also carries `public static final ObjectCodecMapCodec<String, Schema>
CODEC` — a schema can serialise itself to JSON. **The extractor needs no
hand-written writer.**

Adjacent and useful: `com.hypixel.hytale.codec.schema.metadata.ui.*`
(`UIEditorPreview`, `UITypeIcon`, `UIPropertyTitle`, `UIEditorSectionStart`,
`UISidebarButtons`, `UIDisplayMode`, `UIDefaultCollapsedState`, …) carries the
Asset Editor's presentation hints. Grouping and labelling fields the way the
official editor does costs nothing extra and makes output legible to users who
already know that UI.

---

## The extractor

A small pre-compiled Java program, run as a subprocess, that:

1. Enumerates asset config classes — see §Entry points
2. Reads each class's static `CODEC` field
3. Calls `toSchema(SchemaContext)`
4. Serialises the result via `Schema.CODEC`
5. Writes one JSON document to stdout or a temp file

**Runtime requirement is satisfied by the game itself.** `OPEN-QUESTIONS.md` Q2
confirmed the client ships Temurin 25 at
`%AppData%\Roaming\Hytale\install\<patchline>\package\jre\latest\`. The extractor
must therefore be **shipped pre-compiled** — that bundled runtime is a JRE with
`java.exe` but no `javac`, so it can run our extractor but cannot build it.

This removes the tier-2 adoption barrier entirely: a no-code pack author with no
Java installation still gets authoritative schema.

**Sandboxing still applies.** The extractor loads and initialises Hytale's classes,
whose static initializers may have side effects or expect server state. Run it in a
separate process with a temp working directory, no network, and a timeout, so a
crash or hang cannot take down the MCP server. Where a class fails to initialise,
record it in `coverage` and continue — never abort the whole extraction for one bad
type.

---

## Entry points

Two independent discovery paths; use both and reconcile.

**By registry (preferred).** `com.hypixel.hytale.assetstore.AssetRegistry` holds a
static, complete map of every registered asset type:

```java
public static Map<Class<? extends JsonAssetWithMap>, AssetStore<?,?,?>> getStoreMap();
```

One call, no scanning, no package-name assumptions, and it reflects what the engine
actually registered rather than what the source tree happens to look like. Asset
config classes implement `JsonAssetWithMap<K, V>` and expose their store through
`getAssetStore()` / `getAssetMap()`, so the map is bidirectional.

Note `AssetRegistry.HAS_INIT` and `ASSET_LOCK` — the registry is populated by an
initialisation step. **Determine the minimum initialisation that populates it
without booting a server** (`01-VISION.md` §Operating constraint). If the map is
only populated by a full server start, fall back to the package scan below and
record the limitation.

**By package.** `com.hypixel.hytale.server.core.asset.type.<name>.config.<Name>` —
39 subpackages exist in the release JAR:

```
ambiencefx attitude audiocategory audiostate blockbreakingdecal blockhitbox
blockparticle blockset blocksound blocktick blocktype buildertool camera
entityeffect environment equalizereffect fluid fluidfx gamemode gameplay item
itemanimation itemsound model modelvfx musiccontainer particle physicalmaterial
portalworld projectile responsecurve reverbeffect soundevent soundset tagpattern
trail weather wordlist
```

**These 39 do not correspond cleanly to the 51 second-level directories in
`Assets.zip`** — different case, different names, and several archive directories
(`Server/World`, `Server/Prefabs`, `Server/Drops`, `Server/Entity`) have no
matching subpackage. **Surface the disagreement rather than resolving it by
guesswork**; it is information about the corpus, and it is the weakest link in
path → type mapping. See `OPEN-QUESTIONS.md` Q4.

---

## Remaining hard problems

### Polymorphic components

The original concern stands but is much reduced. `toSchema()` produces
`anyOf`/`oneOf`/`definitions`/`ref`, which is how a polymorphic union is expressed
natively — no registry-walking heuristic required for anything the schema covers.

Runtime registration by plugins remains outside static extraction's reach. Degrade
gracefully: an unrecognised component type falls back to corpus-inferred structure
and is marked `source: "inferred"`, never a validation error.

### Non-codec paths

Not every asset type necessarily goes through a codec. Where no `CODEC` field is
found, fall back to inference and mark the schema `source: "inferred"` so the agent
knows the difference. Report the split in `coverage`.

### Version drift

Multiple patchlines coexist — both `release` and `pre-release` were present on the
verification machine. **Key the extracted schema by JAR content hash, never by a
version string.** Store the patchline as display metadata only.

---

## Output contract

Unchanged in shape, extended to carry the prose the schema now provides:

```json
{
  "source_jar_hash": "…",
  "patchline": "release",
  "extracted_at": "…",
  "method": "toSchema",
  "asset_types": {
    "item": {
      "class": "com.hypixel.hytale.server.core.asset.type.item.config.Item",
      "schema": { "…": "verbatim Schema.CODEC output" },
      "fields": [
        {
          "pointer": "/TranslationProperties/Name",
          "type": "String",
          "optional": true,
          "default": null,
          "title": "…",
          "description": "…",
          "enum_values": null,
          "reference_target": "lang_key"
        }
      ]
    }
  },
  "coverage": {
    "types_found": 39,
    "types_with_codec": 0,
    "types_inferred_only": 0,
    "types_failed_init": 0
  }
}
```

Keep the verbatim `schema` document alongside the flattened `fields` list. The flat
list is what the query layer joins against corpus `json_pointer` statistics; the
verbatim document is what preserves `anyOf`/`definitions` structure that flattening
loses.

`coverage` is not decoration. Report it in `status()` so the agent knows how much of
what it is told is authoritative.

---

## Payoff for the resolver

Larger than originally estimated. Once schema is available, reference detection
stops being heuristic for every field it covers, and the corpus makes clear how
much that matters: real asset references are **bare, unnamespaced short strings**
(`"Set": "Rock_Magma_Cooled"`, `"Parent": "Rock_Magma_Cooled_Brick"`,
`"Id": "Builders"`). Without schema these are exactly the low-confidence collisions
`03-ARCHITECTURE.md` warns about. With schema, a declared reference field is
high-confidence by construction.

**And the mechanism is concrete, not hoped for.** Reference-typed fields annotate
themselves into the emitted schema:

```java
public class AssetKeyValidator<K> implements Validator<K> {
    private final Supplier<AssetStore<K, ?, ?>> store;
    public void updateSchema(SchemaContext, Schema);   // writes itself into the schema
}
```

A field validated by `AssetKeyValidator` is therefore identifiable **in
`toSchema()` output** as a reference, together with the `AssetStore` it targets.
That is the high-confidence tier in `03-ARCHITECTURE.md` §Confidence, obtained by
construction rather than by string matching.

Capture this during extraction — a `reference_target` on the flattened field list
is what turns the resolver from heuristic to exact.

Note what this does **not** require. `AssetValidationResults` has first-class
missing-reference handling and `AssetReferences` suggests the engine maintains its
own reference graph — but reading the marker out of the schema is a *declaration*,
while using either of those would mean *invoking behaviour*. See §Scope boundary:
Q17 and Q19 are filed, not scheduled.

This is a strong argument for pulling codec extraction earlier in the roadmap —
see `08-ROADMAP.md`, where it has been moved.

---

## Legal boundary — non-negotiable

Verified against Hytale EULA v2.2 (`OPEN-QUESTIONS.md` Q10):

- **Calling `toSchema()` is ordinary interoperability use of a public API, not
  "reverse engineer, decompile, or disassemble" under §4.1(a).** The obsolete
  decompilation and bytecode approaches depended on the §4.2 interoperability
  exception to be permissible at all. Adopting `toSchema()` removes that exposure —
  an independent second reason to prefer it.
- Extraction runs locally, on the user's own installation.
- The repository and published package contain **no** extracted Hytale data.
- No decompiled Hytale source is vendored.
- Extracted schema lives in the user's cache and is **never transmitted** — §3.3
  bars distributing any part of the Game, and §4.2 conditions the interoperability
  exception on not disclosing proprietary information.
- Package naming and README must be descriptive only, never implying endorsement
  (§3.6).

---

## Historical note

Three approaches were weighed before Q1 was answered: (A) runtime reflection over
constructed codec objects, (B) ASM bytecode analysis of `<clinit>` builder chains,
(C) Vineflower decompilation plus source parsing. The document rated this component
"highest risk, highest value" and flagged the possibility that tier 2 was
infeasible.

Recorded because the reasoning was sound given what was known, and because it is a
concrete illustration of the project's own rule: **five minutes of checking beat a
page of careful inference.** The `<clinit>` builder chain the analysis feared is
real — `AssetBuilderCodec.builder(...)` followed by ~168 `lambda$static$N`
getter/setter pairs on `Item` alone — and tracing it would have been every bit as
brittle as predicted. It simply never needed tracing.
