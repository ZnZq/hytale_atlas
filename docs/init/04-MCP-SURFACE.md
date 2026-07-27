# 04 — MCP Surface

## Design rule

**Do not expose a generic query tool.** `run_query(sql)` or `run_query(cypher)`
looks flexible and performs badly: the agent burns turns discovering the schema,
writes queries that miss, and has no idea what a good query looks like. Every
comparable project that works well ships a fixed set of **task-shaped** tools
named after the questions agents actually ask.

Reference surfaces worth copying from (`07-PRIOR-ART.md`): codegraph ships nine —
search, context, callers, callees, impact, explore, node, files, status;
codebase-memory-mcp ships fourteen typed tools.

---

## Context discipline

Asset JSON can be very large, and the corpus is huge. One careless tool result can
consume the agent's entire budget and defeat the purpose of the tool.

**Hard rules:**

1. Only `get_asset` returns full JSON content. Everything else returns
   `{id, type, pack, one_line_summary}`.
2. All list results are paginated. Always return `total` alongside the page so the
   agent knows what it is not seeing.
3. Large arrays inside returned JSON are elided with a count marker:
   `"Drops": ["…12 entries elided…"]`, retrievable by pointer.
4. Every response carries `epoch`.
5. Default `limit` should be small (10–20). Let the agent ask for more.

---

## Tools

### Discovery

**`search_assets(query, type?, pack?, limit?, offset?)`**

Primary entry point. Full-text over asset IDs **and localized display names and
descriptions** — see `03-ARCHITECTURE.md` §Localization. Searching identifiers alone
does not answer natural-language queries, because identifiers are machine names
(`Sword_Iron`) and users describe things in prose ("flaming sword").

Returns summaries only. Each summary carries the display name alongside the ID:

```json
{ "id": "Sword_Iron", "name": "Iron Sword", "type": "item", "pack": "Hytale" }
```

This costs almost nothing and makes every result legible to both the agent and the
human reading over its shoulder.

**`list_asset_types()`**

Discovered asset types with counts. Cheap orientation call — an agent that starts
here spends far fewer turns than one that guesses.

**`get_asset(id, pack?)`**

Full **effective** JSON definition. Also reports which definitions it overrode and
which pack won. This is the only high-token tool; document that clearly in its
description so the agent rations it.

**"Effective" now means two resolutions, not one** (`OPEN-QUESTIONS.md` Q18). Real
assets declare `"Parent": "<other asset id>"`, so a definition on disk is often
partial:

1. **Inheritance** — resolve the `Parent` chain within the corpus
2. **Override** — apply cross-pack priority

Returning the raw file would be actively misleading: the agent would see a partial
definition and conclude that fields are absent which the game supplies from the
parent, then "helpfully" re-add them or report them missing.

The response should therefore distinguish, per field, **declared here** from
**inherited from `<id>`**, and name the parent chain. That distinction is exactly
what an author needs in order to know what to put in their own file, and it is
cheap to carry.

---

### Understanding structure

**`search_schema(query, type?, limit?)`**

Full-text over the **schema itself** — field pointers, `title`, `description`,
`markdownDescription`, enum values and `enumDescriptions` — across every asset
type. Returns `{type, pointer, title, description, declared_type}`.

**This answers a question no other tool here can: *where does capability X live?***
`describe_schema` requires you to already know the type. `search_assets` searches
assets, not the schema. Neither helps an agent that knows what it wants to achieve
but not which asset type expresses it.

The case that produced this tool, traced on real data:

> *"make a pickaxe that mines 3x3"*
>
> `ItemTool` is `{specs[], speed, durabilityLossBlockTypes, hitSoundLayerId,
> incorrectMaterialSoundLayerId}` — **no width, radius, area or shape.** A
> gathering tool breaks one block, and no amount of searching *assets* reveals
> that, because absence is invisible to a corpus search.
>
> `search_schema("area size shape width")` returns `buildertool`:
> `/Width`, `/Height`, `/Thickness`, `/Shape` (11 `BrushShape` values), `/Mask`,
> `/Density` — a **different asset type with different semantics**.
>
> The agent can then say: *"a gathering tool has no area field; area belongs to
> the builder-tool system, which is a different kind of asset. This probably needs
> a plugin, not a pack."* Without it, the agent writes `"BreakRadius": 3`, the game
> silently ignores it, and the user debugs for an hour.

Two properties make this cheap. The schema ships with the game's own prose
(`05-CODEC-EXTRACTION.md`), so there is real language to match against rather than
just identifiers — the same argument that makes localization load-bearing for
`search_assets`. And the schema is small relative to the corpus, so this FTS index
costs almost nothing.

**Requires tier 2.** Without extracted schema, degrade to searching observed field
pointers from corpus inference, and say so — corpus-derived pointers cannot answer
the "does this capability exist at all" question, which is the whole point.

**`describe_schema(type, field?)`**

The inventory of fields for an asset type. Each field carries **both layers**:

```json
{
  "pointer": "/Components/Renderable/Model",
  "declared": {
    "type": "Optional<AssetRef<Model>>",
    "default": null,
    "source": "codec",
    "title": "Model",
    "description": "…the game's own field documentation…",
    "enum_values": null,
    "enum_descriptions": null
  },
  "observed": {
    "used_in": 1183,
    "of_total": 1247,
    "target_types": ["model"],
    "examples": ["Sword_Iron", "Sword_Bronze"]
  }
}
```

**`declared` carries prose, and this was not anticipated.** The codec schema
supplies `title`, `description`, `markdownDescription` and `enumDescriptions`
(`05-CODEC-EXTRACTION.md`) — the game documents its own schema for the Asset
Editor. Pass it through verbatim rather than paraphrasing; it is authoritative, and
it is the difference between "field `Rarity`, enum, 5 values" and an answer the
user can act on.

Two caveats worth stating in the tool description:

- `observed.used_in` counts occurrences in **inheritance-resolved** assets. Raw
  file counts undercount, because an inherited field never appears in the child
  document (Q18).
- `observed` is absent for fields the schema permits but the corpus never uses —
  that is `find_undocumented`'s input, not a bug.

`declared` is absent when codec extraction was unavailable (tier 1 — see
`06-CLI-UX.md`). `observed` is absent for fields that exist in the schema but
appear nowhere in the corpus.

**`find_undocumented(type?)`**

Fields present in the extracted schema with **zero** occurrences in the vanilla
corpus. Requires tier 2.

Framing matters here. The honest description is *"fields the schema permits that
vanilla never uses"* — **not** "undocumented features". Such a field may be
deprecated, engine-internal, populated programmatically rather than from JSON, or a
debug affordance. Present results as leads to investigate, and say so in the tool
description so the agent does not present them to a user as working features.

If early testing shows most are genuinely usable (see `01-VISION.md` criterion 6),
the framing can be strengthened. Do not start there.

**`lookup_lang(query | key | asset_id)`**

Resolve between display names, localization keys, and assets, in any direction.
Answers "what is *Torch* actually called in the files" and "what text does this
asset show the player". Cheap, and frequently the first thing an agent needs.

**`find_examples(type, has_field?, field_value?, limit?)`**

"Show me vanilla assets that do X." The workhorse for *how is this implemented*
questions. Returns summaries plus, for each hit, the relevant JSON fragment only —
not the whole asset.

---

### Understanding relationships

**`trace_refs(id, direction, depth?, min_confidence?)`**

- `direction: "out"` — what this asset needs. Use for completeness: "what must my
  pack include for this to load?"
- `direction: "in"` — what depends on this asset. Use for impact: "what breaks if
  I change it?"

`depth` must be bounded and default to 1. Three hops explodes. Unreal's Reference
Viewer exposes search depth as a first-class control for exactly this reason.

**`diff_override(id)`**

What a pack changed relative to the asset it overrides, as a structural diff. The
single best way to teach an agent the idioms of modifying vanilla content, because
it isolates the delta from the boilerplate.

**`find_conflicts(pack?)`**

Assets defined by more than one pack, with the winner marked. Directly useful to
the "why does my pack break when I install theirs" case.

---

### Health

**`validate_pack(path?)`**

Steal Unity's three report types wholesale — they are the right three:

- **Broken references** — points at an ID that resolves to nothing
- **Missing files** — references a model or texture that is not present
- **Unused assets** — nothing references it. For packs this doubles as bloat
  detection.

Plus Hytale-specific checks:

- `manifest.json` well-formed. **Not "complete"** — a real pack manifest carries
  fields absent from the documented schema (`LoadBefore`, `SubPlugins`) and omits
  documented ones (`ServerVersion`, `Website`). Validate what is known; preserve
  and ignore what is not. Reporting unknown manifest keys as errors would fire on
  valid packs (`02-DOMAIN.md`).
- **Missing localization** — an asset with no translation entry ships as a raw
  identifier shown to players. One of the most common beginner mistakes in any
  modding ecosystem, and trivially detectable once lang data is in the graph.
  Vanilla sets the bar here: 99.9 % of items are localized, so an unlocalized asset
  is genuinely anomalous rather than merely untidy.
- **Dangling localization key** — `TranslationProperties.Name` pointing at a key no
  `.lang` file defines. Distinct from the above and equally common. Beware the
  root-prefix rewrite (`server.` ↔ `Server/`) when implementing this: getting it
  wrong reports *every* asset as broken.
- Asset ID naming rules (`A–Z a–z 0–9 _`; first letter and letters after `_`
  uppercase) — see `02-DOMAIN.md`
- **Broken `Parent` reference** — inheritance targets an asset that does not exist,
  leaving the definition permanently partial (Q18)
- Fields not present in the extracted schema — the game will silently ignore them,
  which is the single most frustrating failure mode for a pack author. Requires
  tier 2; without it, degrade to "this field is unusual in the corpus."
- Declared dependencies present

**Open opportunity — reuse the engine's own validators.** Stronger than it first
appeared. The JAR contains `com.hypixel.hytale.codec.validation` (40 classes), asset
config classes expose a static `VALIDATOR_CACHE`, and two pieces are directly on
point:

```java
class AssetKeyValidator<K> implements Validator<K> {
    void accept(K, ValidationResults);          // is this key a real asset?
    void updateSchema(SchemaContext, Schema);   // and it says so in the schema
}
class AssetValidationResults extends ValidationResults {
    void handleMissingAsset(String, Class<? extends JsonAsset>, Object);
    void logOrThrowValidatorExceptions(HytaleLogger, String, Path, int);   // file + line
}
```

**Broken-reference detection is a first-class engine concept, with file-and-line
reporting already built in.** If these can be invoked on a candidate asset,
`validate_pack` stops approximating and reports **exactly what the game will
reject**. Error messages resolve through `assetEditor.messages.*` keys, so they can
be rendered as real prose in the user's locale.

The catch: `AssetKeyValidator` holds a `Supplier<AssetStore>` and validates against
a **populated** store, so this needs the corpus loaded through the engine — heavier
than schema extraction, though still short of booting a server, which
`01-VISION.md` §Operating constraint forbids.

**Deliberately not scheduled — on cost, not feasibility.** The engine's validators
*are* reachable, as a documented batch mode (`--validate-assets
--shutdown-after-validate`). What rules them out as the default is the price:
a full server boot of roughly 40 seconds, an unsuppressable telemetry beacon, and a
scratch directory — **per run**. `validate_pack` is meant to be callable after
every edit; this cannot be.

So `validate_pack` ships as schema conformance plus broken-reference detection —
the design's original specification — and deep validation is at most an explicit,
user-invoked `validate --deep`. See `OPEN-QUESTIONS.md` **Q17**.

Distinguish **error** (will not load) from **warning** (unusual but legal). Do not
report low-confidence heuristic findings as errors.

**`whats_changed(since_epoch)`**

The tool that makes live indexing worth building. An agent returning after the
user has been editing sees: these assets changed, this one was added, this
reference just broke. Without it the agent either re-asks or silently works from a
stale picture.

**`status()`**

Which packs are indexed, source hashes, patchline, tier (1/2/3), epoch, index
freshness, and any degradation currently in effect. An agent that can see it is on
tier 1 knows not to promise schema-level answers.

---

## Naming and descriptions

Tool descriptions are prompt engineering, not documentation. Each should state:

- the question it answers, in the words a user would use
- when **not** to use it (especially: "use `search_assets` first, not `get_asset`")
- its cost profile

Suggested orientation hint in the server instructions: *to find out **whether**
something is expressible, start with `search_schema`; to find **what exists**, start
with `list_asset_types` or `search_assets`; use `find_examples` to learn a pattern;
use `get_asset` only when you need the complete definition.*

The first clause matters more than its length suggests. An agent that reaches for
`search_assets` when the real question is "can this be done at all" will find
nothing and conclude it must invent something — the failure mode traced in
`09-EVALUATION.md` §The canonical scenario.

---

## Deferred

- `run_query` escape hatch — only if concrete evidence emerges that the fixed
  surface is insufficient. Adding it early guarantees the fixed tools stay
  underdeveloped.
- Graph visualisation. Genuinely useful for humans, irrelevant to agents. Later.
- Write tools. The agent writes files directly; the index observes. Keeping this
  tool read-only avoids an entire category of consistency problem.
