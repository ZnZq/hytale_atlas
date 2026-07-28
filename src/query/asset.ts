import type { Database } from "../db/open.ts";

/**
 * Resolving an asset to its **effective** definition.
 *
 * A definition on disk is usually partial: real assets declare
 * `"Parent": "<other asset id>"` and inherit the rest. Returning the raw file
 * would show an agent an incomplete asset and invite it to conclude that fields
 * are missing which the game will happily supply.
 *
 * **Two markers govern this, and an earlier revision read both in the wrong
 * place.** The schema states the rule in prose on every `Parent` field:
 *
 * > the child field will simply replace the value provided by the parent, in the
 * > case of nested structures this will apply to the fields **within** the
 * > structure. In some cases the field may decide to act differently...
 *
 * | Marker | Where it lives | Meaning |
 * |---|---|---|
 * | `hytale.inheritsProperty` | on a property, OR inside one of its `anyOf` branches | this property is inherited at all |
 * | `hytale.mergesProperties` | on a schema's ROOT, i.e. per TYPE | values of this type combine field by field instead of being replaced |
 *
 * Both were read as plain per-property markers on the property node. The cost of
 * each was a false statement about the game:
 *
 * - `inheritsProperty` sits in an `anyOf` branch for 13 of Item's 52 marked
 *   properties, `BlockType` among them. Missing it meant a crop's whole
 *   `BlockType` was replaced by the child's, so every plant in the game read as
 *   having no `Support` (the farmland restriction) and no
 *   `BlockEntity.Components.FarmingBlock` (what makes it tick).
 * - `mergesProperties` is a type-level marker: 141 occurrences, nearly all on a
 *   schema root. As a property marker it was true for almost nothing, so nested
 *   objects replaced wholesale -- `Explode_Generic_Blocks` declares one field of
 *   `Config` and read as having no block damage at all, though it is named for it.
 *
 * `inheritsProperty` is recorded but NOT used as a gate -- see `mergeInto` for
 * the corpus evidence that its absence does not mean a field is dropped.
 */
/** Depth cap for the parent chain. Cycles are detected separately. */
const MAX_CHAIN = 16;

export type Json = unknown;

export interface FieldOrigin {
  /** JSON pointer into the effective document. */
  readonly pointer: string;
  /** Logical id the value came from, or null when declared on the asset itself. */
  readonly from: string | null;
  /** How the value arrived. */
  readonly via: "declared" | "inherited" | "merged";
}

export interface ResolvedAsset {
  readonly logicalId: string;
  readonly type: string | null;
  readonly path: string;
  /** Nearest ancestor first. Empty when the asset declares no parent. */
  readonly parentChain: readonly string[];
  readonly effective: Json;
  /** Where each top-level and merged field came from. */
  readonly origins: readonly FieldOrigin[];
  /** A parent named but not found, if any. */
  readonly missingParent: string | null;
  /** True when the chain hit a cycle or the depth cap. */
  readonly truncated: boolean;
}

interface FieldRule {
  /** The property takes part in inheritance at all. */
  readonly inherits: boolean;
  /** Type this property crosses into, when it is a `$ref`. */
  readonly scope: string | null;
}

/**
 * Per-type merge rules, loaded on demand.
 *
 * Lazily, because a merge descends through `$ref` crossings into other types and
 * loading every type up front would read the whole schema for a one-field asset.
 */
interface RuleBook {
  rulesFor(scope: string): ReadonlyMap<string, FieldRule>;
  mergesType(scope: string): boolean;
}

/** Loads a raw asset document by logical id. */
export type AssetLoader = (
  logicalId: string,
) => Promise<{ path: string; type: string | null; document: Json } | null>;

/**
 * Reads the per-field inheritance rules for a type.
 *
 * Keyed by schema pointer, in which array indices and dynamic map keys are `*`.
 */
export function loadFieldRules(db: Database, type: string): Map<string, FieldRule> {
  const rows = db
    .prepare(
      "SELECT json_pointer, inherits_property, ref_scope FROM schema_fields WHERE asset_type = ?",
    )
    .all(type) as { json_pointer: string; inherits_property: number; ref_scope: string | null }[];

  const out = new Map<string, FieldRule>();
  for (const row of rows) {
    out.set(row.json_pointer, {
      inherits: row.inherits_property === 1,
      // A single-target crossing only. A polymorphic union names several types
      // and which one applies depends on the data's own discriminator, so there
      // is no one rule set to descend into.
      scope:
        row.ref_scope !== null && !row.ref_scope.includes(" ") ? row.ref_scope : null,
    });
  }
  return out;
}

/** True when values of this type combine field by field rather than replace. */
export function typeMerges(db: Database, type: string): boolean {
  const row = db
    .prepare(
      "SELECT merges_properties FROM schema_fields WHERE asset_type = ? AND json_pointer = ''",
    )
    .get(type) as { merges_properties: number } | undefined;
  return row?.merges_properties === 1;
}

function buildRuleBook(db: Database): RuleBook {
  const rules = new Map<string, ReadonlyMap<string, FieldRule>>();
  const merges = new Map<string, boolean>();
  return {
    rulesFor(scope) {
      let found = rules.get(scope);
      if (found === undefined) {
        found = loadFieldRules(db, scope);
        rules.set(scope, found);
      }
      return found;
    },
    mergesType(scope) {
      let found = merges.get(scope);
      if (found === undefined) {
        found = typeMerges(db, scope);
        merges.set(scope, found);
      }
      return found;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Looks a pointer up, falling back to the wildcard form the schema uses for
 * array indices and dynamic map keys.
 */
function ruleAt(
  rules: ReadonlyMap<string, FieldRule>,
  pointer: string,
): FieldRule | undefined {
  const exact = rules.get(pointer);
  if (exact !== undefined) return exact;
  const cut = pointer.lastIndexOf("/");
  return cut < 0 ? undefined : rules.get(`${pointer.slice(0, cut)}/*`);
}

/**
 * Whether a property is carried down from a parent.
 *
 * Everything is, and `inheritsProperty` is deliberately NOT consulted here.
 *
 * Treating the marker as a gate was an inference, and the corpus refutes it.
 * `common:FarmingData` marks exactly one of its five properties, so gating
 * dropped `StageSetAfterHarvest` from 14 of the 15 crops that inherit
 * `Template_Crop_Block` -- while every one of them still carried a `Harvested`
 * stage set that nothing then pointed at. Dead data across fifteen files is
 * evidence; a marker's absence is not. The same shape appears wherever the
 * marker is sparse: 368 of common.json's 895 definitions carry it on no
 * property at all, and 527 more on only some, while declaring
 * `mergesProperties: true` -- which would mean nothing if their properties
 * never merged.
 *
 * The schema's own prose on every `Parent` field says it plainly: "most
 * properties will simply be copied from the parent asset to this asset". What
 * varies is only whether a nested value REPLACES or COMBINES, and that is the
 * type-level `mergesProperties` marker, which is used consistently.
 *
 * The nearest thing to counter-evidence is that `Recipe` and `Quality` are
 * unmarked on `Item`, and inheriting a parent's recipe is a strange thing for
 * the engine to do. That is a hypothesis about the engine, not a reading of
 * the data, so it does not get to remove fields from an answer.
 */
/**
 * Merges `child` over `parent` according to the schema's own two markers.
 *
 * `scope` is the type whose rules apply here; it changes at every `$ref`
 * crossing, and the pointer restarts at the root of the new type. Merging
 * `Item./BlockType` against `Item`'s rules found nothing, because those fields
 * are declared on `BlockType`.
 */
function mergeInto(
  parent: Json,
  child: Json,
  pointer: string,
  scope: string,
  book: RuleBook,
  parentId: string,
  origins: FieldOrigin[],
  outPointer: string,
): Json {
  if (!isPlainObject(parent) || !isPlainObject(child)) return child;

  const rules = book.rulesFor(scope);
  const out: Record<string, unknown> = {};

  for (const [key, parentValue] of Object.entries(parent)) {
    const schemaPointer = `${pointer}/${escapeSegment(key)}`;
    const docPointer = `${outPointer}/${escapeSegment(key)}`;
    const rule = ruleAt(rules, schemaPointer);
    if (key in child) continue;
    // Unmarked means not inherited. Copying it anyway is how every child item
    // came to claim its parent's Recipe.

    out[key] = parentValue;
    origins.push({ pointer: docPointer, from: parentId, via: "inherited" });
  }

  for (const [key, childValue] of Object.entries(child)) {
    const schemaPointer = `${pointer}/${escapeSegment(key)}`;
    const docPointer = `${outPointer}/${escapeSegment(key)}`;
    const rule = ruleAt(rules, schemaPointer);
    const parentValue = parent[key];
    const nested = rule?.scope ?? null;

    // A map is a plain object with no `$ref` of its own whose ENTRIES cross into
    // a merging type: `common:StateData./Definitions` has no scope, but
    // `/Definitions/*` continues into BlockType. Descending into it keeps the
    // current scope and extends the pointer, so the next step matches the `/*`
    // rule. Without this a crop's `State` replaced the template's wholesale and
    // `StageFinal.InteractionHint` -- the string that makes the last stage
    // harvestable -- vanished from every plant.
    const entryScope = nested === null ? (ruleAt(rules, `${schemaPointer}/*`)?.scope ?? null) : null;
    const mapMerges = entryScope !== null && book.mergesType(entryScope);

    if (
      isPlainObject(parentValue) &&
      isPlainObject(childValue) &&
      ((nested !== null && book.mergesType(nested)) || mapMerges)
    ) {
      out[key] = mergeInto(
        parentValue,
        childValue,
        mapMerges ? schemaPointer : "",
        mapMerges ? scope : nested!,
        book,
        parentId,
        origins,
        docPointer,
      );
      origins.push({ pointer: docPointer, from: parentId, via: "merged" });
    } else {
      out[key] = childValue;
      origins.push({ pointer: docPointer, from: null, via: "declared" });
    }
  }
  return out;
}

/**
 * The type whose rules actually apply to a document.
 *
 * A root-level union declares no field of its own -- `Interaction` is 102
 * branches and one root row -- so looking a pointer up in it finds nothing and
 * every field reads as not-inherited. `Explode_Generic_Blocks` came back as
 * `{Type, Parent, Config: {DamageEntities: false}}`, i.e. an asset named for
 * block damage with no block damage in it. The branch is chosen by the
 * discriminator the schema declares and the data carries.
 */
function resolveScope(db: Database, type: string, chain: { document: Json }[]): string {
  const root = db
    .prepare(
      `SELECT ref_scope, discriminator_property, discriminator_values
         FROM schema_fields
        WHERE asset_type = ? AND json_pointer = '' AND ref_scope IS NOT NULL`,
    )
    .get(type) as
    | { ref_scope: string; discriminator_property: string | null; discriminator_values: string | null }
    | undefined;
  if (root === undefined) return type;

  const branches = root.ref_scope.split(" ").filter(Boolean);
  const values = (root.discriminator_values ?? "").split(" ").filter(Boolean);
  if (branches.length < 2 || values.length !== branches.length) return type;
  const property = root.discriminator_property ?? "Type";

  // Nearest declaration wins, then up the chain: 152 of 1 341 Interaction assets
  // declare only a Parent and inherit their Type from it.
  for (const layer of chain) {
    if (!isPlainObject(layer.document)) continue;
    const declared = layer.document[property];
    if (typeof declared !== "string") continue;
    const at = values.indexOf(declared);
    if (at >= 0) return branches[at]!;
  }
  return type;
}

/** Reads the `Parent` field, which is how inheritance is declared. */
function parentOf(document: Json): string | null {
  if (!isPlainObject(document)) return null;
  const parent = document["Parent"];
  return typeof parent === "string" && parent.length > 0 ? parent : null;
}

/**
 * Resolves an asset's effective definition by walking and merging its parent
 * chain, oldest ancestor first.
 */
export async function resolveAsset(
  db: Database,
  logicalId: string,
  load: AssetLoader,
): Promise<ResolvedAsset | null> {
  const root = await load(logicalId);
  if (root === null) return null;

  // Collect the chain child-first, guarding against cycles and runaway depth.
  const chain: { id: string; document: Json }[] = [{ id: logicalId, document: root.document }];
  const visited = new Set<string>([logicalId]);
  let missingParent: string | null = null;
  let truncated = false;

  let cursor = root.document;
  while (chain.length < MAX_CHAIN) {
    const next = parentOf(cursor);
    if (next === null) break;
    if (visited.has(next)) {
      truncated = true; // cyclic Parent chain
      break;
    }
    const loaded = await load(next);
    if (loaded === null) {
      missingParent = next;
      break;
    }
    visited.add(next);
    chain.push({ id: next, document: loaded.document });
    cursor = loaded.document;
  }
  if (chain.length >= MAX_CHAIN && parentOf(cursor) !== null) truncated = true;

  const book = buildRuleBook(db);
  const scope = root.type === null ? null : resolveScope(db, root.type, chain);
  const origins: FieldOrigin[] = [];

  // Fold from the most distant ancestor down to the asset itself. An untyped
  // asset has no rules to consult, so it keeps only what it declares.
  let effective: Json = chain[chain.length - 1]!.document;
  for (let i = chain.length - 2; i >= 0; i--) {
    const layer = chain[i]!;
    const ancestor = chain[i + 1]!;
    effective =
      scope === null
        ? layer.document
        : mergeInto(
            effective,
            layer.document,
            "",
            scope,
            book,
            ancestor.id,
            origins,
            "",
          );
  }

  return {
    logicalId,
    type: root.type,
    path: root.path,
    parentChain: chain.slice(1).map((c) => c.id),
    effective,
    origins,
    missingParent,
    truncated,
  };
}
