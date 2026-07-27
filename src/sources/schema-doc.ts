import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

import { isUnsetDefault, parseJsonLenient } from "../util/json.ts";

/**
 * Reads the schema set produced by `HytaleServer.jar --generate-asset-schema`.
 *
 * Layout, fixed by the generator (`docs/init/05-CODEC-EXTRACTION.md`):
 *
 * ```
 * <dir>/Schema/<TypeName>.json      104 files, incl. shared common.json and other.json
 * <dir>/.vscode/settings.json       102 fileMatch -> schema bindings
 * ```
 */

export interface AssetTypeInfo {
  /** Schema file basename, e.g. "Item". */
  readonly id: string;
  /** `hytale.path`, relative to the pack root, e.g. "Item/Items". */
  readonly schemaPath: string | null;
  readonly fileExtension: string | null;
  /** Globs from `.vscode/settings.json`, kept as an independent cross-check. */
  readonly fileMatch: readonly string[];
}

export interface SchemaField {
  readonly assetType: string;
  /** JSON pointer with `*` standing for any array index or dynamic map key. */
  readonly pointer: string;
  readonly declaredType: string | null;
  readonly optional: boolean;
  readonly defaultValue: string | null;
  /** The generator emitted a non-finite default, which means *unset*. */
  readonly defaultUnset: boolean;
  readonly enumValues: readonly string[] | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly inheritsProperty: boolean;
  readonly mergesProperties: boolean;
}

export interface SchemaDefinition {
  readonly sourceFile: string;
  readonly name: string;
  readonly body: string;
}

export interface GeneratedSchemaSet {
  readonly types: readonly AssetTypeInfo[];
  readonly fields: readonly SchemaField[];
  readonly definitions: readonly SchemaDefinition[];
  readonly warnings: readonly string[];
}

/** Files that are shared definition libraries rather than asset types. */
const DEFINITION_FILES = new Set(["common.json", "other.json"]);

/**
 * How deep to follow nested objects and `$ref`s.
 *
 * Not a performance guard so much as a shape guard: `common.json` holds 895
 * definitions and `InteractionSettings` alone is referenced 303 times, so an
 * unbounded expansion produces a field list nobody can read. Eight levels covers
 * every field observed in real assets.
 */
const MAX_DEPTH = 8;

/**
 * Node-editor scratch fields, skipped.
 *
 * `$Title`, `$Comment`, `$Author`, `$TODO`, `$Position`, `$FloatingFunctionNodes`,
 * `$Groups`, `$WorkspaceID`, `$NodeId`, `$NodeEditorMetadata` appear on **101 of
 * 102 types**, always typed `null`, and carry no information about the asset —
 * they are the visual editor's bookkeeping. Left in, they would add ~1 000 empty
 * rows to `describe_schema` and dilute `search_schema` on every type.
 */
function isEditorMetadata(name: string): boolean {
  return name.startsWith("$");
}

type Node = Record<string, unknown>;

function asNode(value: unknown): Node | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Node)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Renders a JSON Schema `type` (string or union) into one label. */
function declaredType(node: Node): string | null {
  const t = node["type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === "string").join("|");
  if (typeof node["$ref"] === "string") return `$ref ${node["$ref"] as string}`;
  if (Array.isArray(node["anyOf"])) return "anyOf";
  if (Array.isArray(node["oneOf"])) return "oneOf";
  return null;
}

/** A type union containing `null` is how this generator expresses nullability. */
function isNullable(node: Node): boolean {
  const t = node["type"];
  return Array.isArray(t) && t.includes("null");
}

function hytale(node: Node): Node | null {
  return asNode(node["hytale"]);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export class SchemaResolver {
  readonly #files: ReadonlyMap<string, Node>;

  constructor(files: ReadonlyMap<string, Node>) {
    this.#files = files;
  }

  /**
   * Resolves `common.json#/definitions/ItemTool`, `Other.json#` or `#/definitions/X`.
   * Returns null when the target is absent rather than throwing — a dangling ref
   * is a fact about the corpus, not a reason to abandon the whole read.
   */
  resolve(ref: string, currentFile: string): { node: Node; file: string } | null {
    const hash = ref.indexOf("#");
    const file = hash <= 0 ? currentFile : ref.slice(0, hash);
    const pointer = hash < 0 ? "" : ref.slice(hash + 1);

    const root = this.#files.get(file);
    if (root === undefined) return null;
    if (pointer === "" || pointer === "/") return { node: root, file };

    let current: unknown = root;
    for (const raw of pointer.split("/").slice(1)) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      const node = asNode(current);
      if (node === null) return null;
      current = node[key];
    }
    const node = asNode(current);
    return node === null ? null : { node, file };
  }
}

interface FlattenContext {
  readonly assetType: string;
  readonly resolver: SchemaResolver;
  readonly out: SchemaField[];
  readonly seenPointers: Set<string>;
  readonly refStack: string[];
  /** Non-finite defaults, keyed by the file and pointer they were found at. */
  readonly repaired: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Whether the default at this location was a non-finite literal.
 *
 * Repairs are recorded against the pointer in their **source** file, while fields
 * are emitted against the pointer in the **referring type**. A `$ref` moves
 * between the two spaces, so the check has to be made in source coordinates —
 * otherwise the flag silently never fires, which is how it behaved when this was
 * first written.
 */
function hadNonFiniteDefault(
  ctx: FlattenContext,
  file: string,
  sourcePointer: string,
): boolean {
  const repairs = ctx.repaired.get(file);
  if (repairs === undefined) return false;
  const prefix = `${sourcePointer}/default`;
  for (const pointer of repairs) {
    if (pointer === prefix || pointer.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function emit(
  ctx: FlattenContext,
  pointer: string,
  node: Node,
  optional: boolean,
  defaultUnset: boolean,
): void {
  if (ctx.seenPointers.has(pointer)) return;
  ctx.seenPointers.add(pointer);

  const meta = hytale(node);
  const enumValues = Array.isArray(node["enum"])
    ? (node["enum"] as unknown[]).map((v) => String(v))
    : null;
  const hasDefault = "default" in node;

  ctx.out.push({
    assetType: ctx.assetType,
    pointer,
    declaredType: declaredType(node),
    optional: optional || isNullable(node),
    defaultValue: hasDefault ? JSON.stringify(node["default"]) : null,
    defaultUnset,
    enumValues,
    title: asString(node["title"]),
    description: asString(node["markdownDescription"]) ?? asString(node["description"]),
    inheritsProperty: meta?.["inheritsProperty"] === true,
    mergesProperties: meta?.["mergesProperties"] === true,
  });
}

/**
 * Walks a schema node, emitting one field per reachable JSON pointer.
 *
 * Array elements and dynamic map keys both collapse to `*`. That is deliberate:
 * corpus pointers carry real indices (`/Recipe/Input/0/ItemId`) while schema
 * pointers carry structure (`/Recipe/Input/items/ItemId`), and the two must join
 * on the same key for `describe_schema` to show declared and observed side by
 * side. Normalising both to `/Recipe/Input/*​/ItemId` is what makes that join work.
 *
 * The 894 object-valued `additionalProperties` in the corpus are dynamic maps —
 * ECS component blocks and tag sets — and treating them as fixed records would
 * explode every component name into its own schema field
 * (`07-PRIOR-ART.md` §polars-genson).
 */
function flatten(
  ctx: FlattenContext,
  node: Node,
  pointer: string,
  /** Pointer within `currentFile`, which is a different space once a $ref is followed. */
  sourcePointer: string,
  currentFile: string,
  depth: number,
  optional: boolean,
): void {
  if (depth > MAX_DEPTH) return;

  const ref = asString(node["$ref"]);
  if (ref !== null) {
    const key = `${currentFile}|${ref}`;
    if (ctx.refStack.includes(key)) return; // cyclic definition
    const target = ctx.resolver.resolve(ref, currentFile);
    if (target !== null) {
      const hash = ref.indexOf("#");
      const targetPointer = hash < 0 ? "" : ref.slice(hash + 1);
      ctx.refStack.push(key);
      flatten(ctx, target.node, pointer, targetPointer, target.file, depth + 1, optional);
      ctx.refStack.pop();
    }
    return;
  }

  if (pointer !== "") {
    emit(ctx, pointer, node, optional, hadNonFiniteDefault(ctx, currentFile, sourcePointer));
  }

  const required = new Set(
    Array.isArray(node["required"])
      ? (node["required"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  );

  const properties = asNode(node["properties"]);
  if (properties !== null) {
    for (const [name, child] of Object.entries(properties)) {
      const childNode = asNode(child);
      if (childNode === null || isEditorMetadata(name)) continue;
      const escaped = escapeSegment(name);
      flatten(
        ctx,
        childNode,
        `${pointer}/${escaped}`,
        `${sourcePointer}/properties/${escaped}`,
        currentFile,
        depth + 1,
        !required.has(name),
      );
    }
  }

  const additional = asNode(node["additionalProperties"]);
  if (additional !== null) {
    flatten(
      ctx, additional, `${pointer}/*`,
      `${sourcePointer}/additionalProperties`, currentFile, depth + 1, true,
    );
  }

  const items = asNode(node["items"]);
  if (items !== null) {
    flatten(ctx, items, `${pointer}/*`, `${sourcePointer}/items`, currentFile, depth + 1, true);
  }

  // Polymorphic unions: every branch contributes fields at the same pointer, and
  // emit() deduplicates so the first branch to define a pointer wins.
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, i) => {
      const branchNode = asNode(branch);
      if (branchNode !== null) {
        flatten(
          ctx, branchNode, pointer,
          `${sourcePointer}/${key}/${i}`, currentFile, depth + 1, true,
        );
      }
    });
  }
}

/** Reads `.vscode/settings.json` into type-id → globs, when present. */
function readVsCodeBindings(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const path = join(dir, ".vscode", "settings.json");
  if (!existsSync(path)) return out;

  try {
    const { value } = parseJsonLenient<{
      "json.schemas"?: { fileMatch?: string[]; url?: string }[];
    }>(readFileSync(path, "utf8"), path);
    for (const entry of value["json.schemas"] ?? []) {
      const url = entry.url;
      if (typeof url !== "string") continue;
      out.set(basename(url, ".json"), entry.fileMatch ?? []);
    }
  } catch {
    // A missing or malformed bindings file costs a cross-check, not the read.
  }
  return out;
}

export function readGeneratedSchemas(dir: string): GeneratedSchemaSet {
  const schemaDir = join(dir, "Schema");
  if (!existsSync(schemaDir)) {
    throw new Error(`No Schema/ directory under ${dir}`);
  }

  const warnings: string[] = [];
  const documents = new Map<string, Node>();
  /** Pointers whose default was a non-finite literal, per file. */
  const repaired = new Map<string, Set<string>>();

  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".json"))) {
    const { value, repairs } = parseJsonLenient<Node>(
      readFileSync(join(schemaDir, file), "utf8"),
      file,
    );
    documents.set(file, value);
    if (repairs.length > 0) {
      repaired.set(file, new Set(repairs.filter(isUnsetDefault).map((r) => r.pointer)));
      warnings.push(
        `${file}: repaired ${repairs.length} non-finite literal(s); ` +
          `${repairs.filter(isUnsetDefault).length} were unset defaults`,
      );
    }
  }

  const resolver = new SchemaResolver(documents);
  const bindings = readVsCodeBindings(dir);

  const types: AssetTypeInfo[] = [];
  const fields: SchemaField[] = [];
  const definitions: SchemaDefinition[] = [];

  for (const [file, root] of documents) {
    const id = basename(file, ".json");

    if (DEFINITION_FILES.has(file)) {
      const defs = asNode(root["definitions"]);
      if (defs !== null) {
        for (const [name, body] of Object.entries(defs)) {
          definitions.push({ sourceFile: file, name, body: JSON.stringify(body) });
        }
      }
      continue;
    }

    const meta = hytale(root);
    const schemaPath = meta === null ? null : asString(meta["path"]);
    if (schemaPath === null) {
      warnings.push(`${file}: no hytale.path — cannot map corpus files to this type`);
    }

    types.push({
      id,
      schemaPath,
      fileExtension: meta === null ? null : asString(meta["extension"]),
      fileMatch: bindings.get(id) ?? [],
    });

    flatten(
      { assetType: id, resolver, out: fields, seenPointers: new Set(), refStack: [], repaired },
      root,
      "",
      "",
      file,
      0,
      true,
    );
  }

  return { types, fields, definitions, warnings };
}
