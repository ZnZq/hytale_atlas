import type { Database } from "../db/open.ts";

/**
 * Resolving an asset to its **effective** definition.
 *
 * A definition on disk is usually partial: real assets declare
 * `"Parent": "<other asset id>"` and inherit the rest. `Tool_Pickaxe_Iron` names a
 * parent and omits nine top-level fields the parent supplies. Returning the raw
 * file would show an agent an incomplete asset and invite it to conclude that
 * fields are missing which the game will happily supply — see
 * `docs/init/OPEN-QUESTIONS.md` Q18 and `04-MCP-SURFACE.md`.
 *
 * **The merge rule is per field, and deep-merging everything would be wrong.**
 * The generated schema marks each field one of two ways, and the two are mutually
 * exclusive — measured on `Item`: 758 `inheritsProperty`, 229 `mergesProperties`,
 * **zero** carrying both:
 *
 * | Marker | Behaviour |
 * |---|---|
 * | `inheritsProperty` | wholesale. A child that defines the field replaces the parent's value entirely, even for objects |
 * | `mergesProperties` | recursive. Child and parent are combined field by field |
 *
 * `/Interactions` and `/InteractionVars` are objects marked `inheritsProperty`,
 * so a child defining them discards the parent's; `/Container`,
 * `/InteractionConfig` and `/ItemEntity` are objects marked `mergesProperties` and
 * combine. A blanket deep merge would silently resurrect parent interactions the
 * author meant to replace.
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
  readonly merges: boolean;
}

/** Loads a raw asset document by logical id. */
export type AssetLoader = (
  logicalId: string,
) => Promise<{ path: string; type: string | null; document: Json } | null>;

/**
 * Reads the per-field merge rules for a type.
 *
 * Keyed by schema pointer, in which array indices and dynamic map keys are `*`.
 */
export function loadFieldRules(db: Database, type: string): Map<string, FieldRule> {
  const rows = db
    .prepare(
      "SELECT json_pointer, merges_properties FROM schema_fields " +
        "WHERE asset_type = ? AND (inherits_property = 1 OR merges_properties = 1)",
    )
    .all(type) as { json_pointer: string; merges_properties: number }[];

  const out = new Map<string, FieldRule>();
  for (const row of rows) {
    out.set(row.json_pointer, { merges: row.merges_properties === 1 });
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Merges `child` over `parent` according to the schema's per-field rules.
 *
 * Absent a rule the field replaces wholesale, which is the conservative choice:
 * an unmarked field is one the schema does not describe as merging, and inventing
 * a merge would fabricate a value that appears in neither document.
 */
function mergeInto(
  parent: Json,
  child: Json,
  pointer: string,
  rules: ReadonlyMap<string, FieldRule>,
  parentId: string,
  origins: FieldOrigin[],
): Json {
  if (!isPlainObject(parent) || !isPlainObject(child)) return child;

  const out: Record<string, unknown> = { ...parent };

  for (const key of Object.keys(parent)) {
    if (!(key in child)) {
      origins.push({
        pointer: `${pointer}/${escapeSegment(key)}`,
        from: parentId,
        via: "inherited",
      });
    }
  }

  for (const [key, childValue] of Object.entries(child)) {
    const childPointer = `${pointer}/${escapeSegment(key)}`;
    const rule = rules.get(childPointer);
    const parentValue = parent[key];

    if (rule?.merges === true && isPlainObject(parentValue) && isPlainObject(childValue)) {
      out[key] = mergeInto(parentValue, childValue, childPointer, rules, parentId, origins);
      origins.push({ pointer: childPointer, from: parentId, via: "merged" });
    } else {
      out[key] = childValue;
      origins.push({ pointer: childPointer, from: null, via: "declared" });
    }
  }
  return out;
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

  const rules = root.type === null ? new Map<string, FieldRule>() : loadFieldRules(db, root.type);
  const origins: FieldOrigin[] = [];

  // Fold from the most distant ancestor down to the asset itself.
  let effective: Json = chain[chain.length - 1]!.document;
  for (let i = chain.length - 2; i >= 0; i--) {
    const layer = chain[i]!;
    const ancestor = chain[i + 1]!;
    effective = mergeInto(effective, layer.document, "", rules, ancestor.id, origins);
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
