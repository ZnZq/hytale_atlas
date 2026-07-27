# 05 — Codec Extraction

**Highest risk, highest value component. Read `OPEN-QUESTIONS.md` Q1 before
starting: the entire approach depends on an unverified assumption.**

---

## Why this matters

Corpus inference tells you what vanilla *uses*. It cannot tell you what the game
*accepts*. The difference is the whole point:

| Source | Answers |
|---|---|
| Corpus (`Assets.zip`) | What is idiomatic. Which fields co-occur. Real examples. |
| Codecs (server JAR) | What is legal. Complete field set, types, defaults, optionality. |
| Enum types in bytecode | The **complete** valid value set for a field |

An enum recovered from the corpus contains only values that happened to be used.
An enum recovered from bytecode is exhaustive. For a creator asking "what else can
I put here", only the second is an answer.

And the diff between the two is the intended product: **fields that exist in the
schema and appear in zero vanilla assets**. Nothing else in the Hytale ecosystem
surfaces these.

**Caveat, and it is a real one.** Such a field is not automatically a usable
feature. It may be deprecated, engine-internal, set programmatically rather than
read from JSON, or a debug hook. The value of this feature rests on an untested
assumption about what fraction are genuinely usable.

Test it as soon as tier 2 works at all: pick three schema-only fields, put them in a
real pack, run the game, see what happens. That experiment costs an hour and
determines whether this is the headline feature or a footnote. See `01-VISION.md`
criterion 6.

---

## The complication

`[REPORTED]` Hytale uses a "Codec system" for JSON serialization.

`[ASSUMED]` It resembles Mojang's DataFixerUpper `Codec`.

If that assumption holds, the good news is that codecs carry more than annotations
would: field name, type, optionality, default, and nested composition are all
explicit. The bad news is *how* they carry it. Codecs are **imperative builder
chains in static initializers**, not declarative metadata. You cannot recover them
by reflecting over class fields the way you could with `@JsonProperty`.

Roughly, a codec looks like:

```java
public static final Codec<Item> CODEC = RecordCodecBuilder.create(i -> i.group(
    Codec.STRING.fieldOf("Name").forGetter(Item::name),
    Model.CODEC.optionalFieldOf("Model").forGetter(Item::model),
    Codec.INT.optionalFieldOf("MaxStack", 64).forGetter(Item::maxStack)
).apply(i, Item::new));
```

The field names live as string constants inside `<clinit>`, threaded through
builder calls. Recovering them statically means tracing bytecode.

---

## Three approaches, in order of preference

### A. Runtime reflection over codec objects (preferred)

Load the JAR in a child JVM, enumerate asset config classes, read their static
codec fields, and walk the resulting codec *object graph* via reflection.
Serialise the description to JSON and hand it back to the indexer.

**Why preferred:** you inspect the constructed codec, not the code that constructs
it. Builder complexity, helper methods, and indirection all disappear — you get
the real structure the game actually uses.

**Costs:**
- Requires a JVM (Java 25). Plugin developers have it; pack authors may not. This
  is the tier boundary in `06-CLI-UX.md`.
- Executes Hytale's code. Static initializers may have side effects or expect an
  initialised server environment. Sandbox: no network, temp working directory,
  timeout, separate process so a crash cannot take down the MCP server.
- Whether codec internals are reflectively walkable depends on their concrete
  implementation. **This is the core of Q1.**

### B. Bytecode analysis (fallback)

Read class files directly with ASM. No JVM execution, no side effects.

Recoverable without executing anything:
- Class and field structure, with generic signatures (retained in bytecode)
- Annotations, if any exist
- **Enum constants** — complete and definitive, which alone justifies this path
- Constant strings in `<clinit>`, in call order

The hard part is reconstructing which string binds to which field with which type
from the builder call sequence. Feasible for straightforward codec construction,
brittle where the code uses helpers or loops.

**Pragmatic hybrid:** use B for enums and class structure (easy, reliable, no
JVM), and A for full codec shape when a JVM is available. This maximises what tier
1 users get.

### C. Decompile to source and parse

Decompile with Vineflower, then parse the Java with tree-sitter or JavaParser.

Least preferred: decompiler output varies in quality, and you inherit both the
decompiler's errors and the difficulty of A without its accuracy. Mentioned
because a working precedent exists (below) and because decompiled source is
independently useful for humans reading the result.

---

## Precedent to study

A community project documents Hytale's QUIC/UDP network protocol by
**automatically extracting, decompiling, and documenting all packets, enums, and
data structures from server JAR files**, using Vineflower, with version tracking
and generated wiki documentation.

Found via https://github.com/topics/hytale-api

This is a working JAR-to-structured-data pipeline for exactly this game. Study
specifically: how it handles version tracking, and how it diffs between versions.
That is the problem you will hit second.

Separately, Hytale Depot generates an API index from the current `HytaleServer.jar`
using an automated class-file parser, regenerating signatures and class counts from
the JAR rather than hand-maintaining them:
https://hytaledepot.net/en/dev-docs/assets-config

Both confirm automated JAR analysis is practical. Neither extracts *asset schema* —
that is the gap.

---

## Entry points

`[REPORTED]` Asset config classes follow the convention:

```
com.hypixel.hytale.server.core.asset.type.<typename>.config.<TypeName>
```

Known: `...asset.type.item.config.Item`, `...asset.type.blocktype.config.BlockType`.

**Enumerating asset types = listing subpackages of
`com.hypixel.hytale.server.core.asset.type`.** Discover them; do not hardcode a
list. Cross-check against the directory names actually present in `Assets.zip` —
if they disagree, that disagreement is itself information worth surfacing.

---

## Known hard problems

### Polymorphic components

The ECS resolves component types through a registry mapping strings to classes.
Registration is typically imperative and may be scattered, including registration
performed by plugins at runtime. This is the hardest part of the extraction and
the most likely place where approach A (runtime, where the registry is populated
and inspectable) decisively beats B.

Expect partial coverage here. Degrade gracefully: an unrecognised component type
should fall back to corpus-inferred structure, not produce a validation error.

### Non-codec paths

Not everything necessarily goes through codecs. Hand-written loaders exist in
community code (`GSON.fromJson(reader, JsonObject.class)` style), and the vanilla
game may do the same for some asset types. Where no codec is found for a type,
fall back to inference and mark the schema `source: "inferred"` so the agent knows
the difference.

### Version drift

Multiple patchlines can coexist on one machine (`02-DOMAIN.md`). Key the extracted
schema by JAR content hash, never by a version string. Store the patchline as
metadata for display.

---

## Output contract

Extraction produces a JSON document consumed by the indexer:

```json
{
  "source_jar_hash": "…",
  "patchline": "release",
  "extracted_at": "…",
  "method": "reflection|bytecode|hybrid",
  "asset_types": {
    "item": {
      "class": "com.hypixel.hytale.server.core.asset.type.item.config.Item",
      "fields": [
        {
          "pointer": "/Name",
          "type": "String",
          "optional": false,
          "default": null,
          "enum_values": null,
          "reference_target": null
        },
        {
          "pointer": "/Rarity",
          "type": "Rarity",
          "optional": true,
          "default": "Common",
          "enum_values": ["Common", "Uncommon", "Rare", "Epic", "Legendary"],
          "reference_target": null
        }
      ]
    }
  },
  "coverage": {
    "types_found": 47,
    "types_with_codec": 41,
    "types_inferred_only": 6
  }
}
```

`coverage` is not decoration. Report it in `status()` so the agent knows how much
of what it is told is authoritative.

---

## Payoff for the resolver

Once schema is available, reference detection stops being heuristic for every
field it covers. If `/Components/Renderable/Model` is *declared* as a reference to
a model asset, the edge is high-confidence by construction, and confidence tiers
are only needed for the uncovered remainder.

This is a significant accuracy improvement and an argument for pulling codec
extraction earlier in the roadmap than a "nice to have" reading would suggest.
See `08-ROADMAP.md`.

---

## Legal boundary — non-negotiable

- Extraction runs locally, on the user's own installation
- The repository and published package contain **no** extracted Hytale data
- No decompiled Hytale source is vendored into the repository
- Extracted schema lives in the user's cache and is never transmitted
- Check Hytale's official server/EULA policy pages before publishing
  (`OPEN-QUESTIONS.md` Q10)
