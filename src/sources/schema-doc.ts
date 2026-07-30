import { readdirSync, readFileSync, existsSync } from "node:fs";
import { escapeSegment } from "../util/json.ts";
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
  /**
   * Asset type this field references, from `hytale.hytaleAssetRef`.
   *
   * The declaration that makes a reference edge a fact rather than a guess. 932
   * fields carry it, naming 70 distinct targets -- `RootInteraction` (252),
   * `Interaction` (211), `SoundEvent` (81), `Item` (37), `ParticleSystem` (31).
   *
   * An earlier revision of this project concluded the generated schema does not
   * mark reference targets, and recorded that in the design documents. That was
   * wrong: the marker exists, it was simply not the key being looked for
   * (`hytale.type` is a JSON-type marker, `uiEditorComponent` is mostly numeric
   * widget configuration). See `docs/init/OPEN-QUESTIONS.md` Q17.
   */
  readonly referenceTarget: string | null;
  /**
   * Namespace the pointer continues in, when this field is a `$ref`.
   *
   * `Item./BlockType` has refScope `BlockType`, so a corpus pointer
   * `/BlockType/Gathering/Breaking/GatherType` rebases to
   * `BlockType./Gathering/Breaking/GatherType`. Following the ref during
   * flattening instead of recording it is what produced 138,961 duplicated fields
   * across 8 truncated types.
   *
   * **Space-separated when a union offers several branches**, which is a
   * different thing entirely: the branch in force is chosen by a discriminator in
   * the data, so the pointer alone cannot say where it continues and callers must
   * not rebase through it. Read it with `scopes()`.
   */
  readonly refScope: string | null;
  /**
   * The discriminator value that selects this definition, when the schema says so.
   *
   * Every polymorphic branch declares it in prose on its own `/Type` field: *"it
   * must be set to the constant value \"Selector\" to function as this type"*.
   * Reading it removes the guesswork: deriving the discriminator from the branch
   * NAME works for `BreakBlockInteraction` -> `BreakBlock` and fails for
   * `SelectInteraction` -> `Selector`, which is not a prefix of it. That single
   * mismatch made `describe common:SelectInteraction` report every field as
   * `unused` while vanilla pickaxes and hatchets use it in their swing chains.
   */
  readonly typeConstant: string | null;
  /** Field carrying the discriminator for this union, from the schema itself. */
  readonly discriminatorProperty: string | null;
  /** Discriminator values, space separated and aligned with `refScope`. */
  readonly discriminatorValues: string | null;
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
 * Recursion guard on schema **nodes**, not on pointer depth.
 *
 * `$ref` and `anyOf` traversal consumes node depth without adding a pointer
 * segment, so a shared limit silently truncates real fields: with a combined cap
 * of 8, `Item` reached only `/BlockType/Gathering/Breaking` while the corpus uses
 * `/BlockType/Gathering/Breaking/GatherType` -- and 95 % of observed fields failed
 * to join to any declared one.
 *
 * Cycles are caught separately by `refStack`, so this only bounds pathological
 * nesting.
 */
const MAX_NODE_DEPTH = 64;

/**
 * How deep a JSON pointer may go.
 *
 * The deepest pointer the corpus actually uses is 15 segments, but depth alone
 * cannot bound the work: `common.json`'s 895 definitions reference each other, so
 * each extra level multiplies rather than adds. At 20 the flatten did not finish
 * in ten minutes.
 */
const MAX_POINTER_DEPTH = 8;

/**
 * Hard ceiling on fields emitted for one asset type.
 *
 * The real guarantee of termination. Depth and cycle detection bound the *shape*
 * of the walk; this bounds its *size*, so a schema that references itself broadly
 * degrades to a truncated field list instead of hanging. Truncation is reported
 * rather than silent -- a partial answer a caller knows is partial is usable, one
 * they do not is worse than none.
 */
const MAX_FIELDS_PER_TYPE = 12_000;

/**
 * Hard ceiling on schema **nodes visited** for one type.
 *
 * The field cap alone does not terminate: `seenPointers` suppresses duplicate
 * emissions, so a walk can visit millions of nodes without the emitted count
 * moving, and a cap on output never fires. Bounding visits is what actually
 * guarantees the walk ends.
 */
const MAX_VISITS_PER_TYPE = 400_000;

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
  out: SchemaField[];
  readonly seenPointers: Set<string>;
  readonly refStack: string[];
  /** Non-finite defaults, keyed by the file and pointer they were found at. */
  readonly repaired: ReadonlyMap<string, ReadonlySet<string>>;
  /** Emitted-field ceiling for this type; see MAX_FIELDS_PER_TYPE. */
  readonly limit: number;
  /** Mutable visit budget; see MAX_VISITS_PER_TYPE. */
  visits: number;
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

export interface UnionDeclaration {
  /** Field carrying the discriminator: `Type` (229), `Id` (14) or `Op` (1). */
  readonly property: string;
  /** Discriminator values, positionally aligned with `scopes`. */
  readonly values: readonly string[];
  /** Branch namespaces, positionally aligned with `values`. */
  readonly scopes: readonly string[];
}

/**
 * Reads `hytaleSchemaTypeField` off a union node, when it is present and usable.
 *
 * The block sits either on the node carrying the branches, or on a wrapper whose
 * only content is the union -- `BlockType./Bench` is
 * `anyOf[0] = {title, anyOf: [...refs], hytaleSchemaTypeField}`. Both are read.
 *
 * Returns null unless every branch is a `$ref` and the counts line up, so a
 * partially-declared union is left to the fallbacks rather than half-trusted.
 */
function unionDeclaration(node: Node, currentFile: string): UnionDeclaration | null {
  const direct = readDeclaration(node, currentFile);
  if (direct !== null) return direct;
  // One level of wrapper: anyOf whose single object branch holds the real union.
  for (const key of ["anyOf", "oneOf"]) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const inner = asNode(branch);
      if (inner === null) continue;
      const found = readDeclaration(inner, currentFile);
      if (found !== null) return found;
    }
  }
  return null;
}

function readDeclaration(node: Node, currentFile: string): UnionDeclaration | null {
  const field = asNode(node["hytaleSchemaTypeField"]);
  if (field === null) return null;
  const property = asString(field["property"]);
  const values = field["values"];
  if (property === null || !Array.isArray(values)) return null;

  const branches = node["anyOf"] ?? node["oneOf"];
  if (!Array.isArray(branches) || branches.length !== values.length) return null;

  const scopes: string[] = [];
  for (const branch of branches) {
    const branchNode = asNode(branch);
    const ref = branchNode === null ? null : asString(branchNode["$ref"]);
    if (ref === null) return null;
    const scope = scopeOfRef(ref, currentFile);
    if (scope === null) return null;
    scopes.push(scope);
  }
  const names = values.filter((v): v is string => typeof v === "string");
  if (names.length !== scopes.length) return null;
  return { property, values: names, scopes };
}

/** Attaches a read declaration to the field already emitted at `pointer`. */
function upgradeUnion(ctx: FlattenContext, pointer: string, declared: UnionDeclaration): void {
  const index = ctx.out.findIndex(
    (f) => f.assetType === ctx.assetType && f.pointer === pointer,
  );
  if (index < 0) return;
  ctx.out[index] = {
    ...ctx.out[index]!,
    refScope: declared.scopes.join(" "),
    discriminatorProperty: declared.property,
    discriminatorValues: declared.values.join(" "),
  };
}

/**
 * Branch namespaces when a node is nothing but a union of `$ref`s.
 *
 * Returns empty for anything else, so a union that mixes refs with inline shapes
 * is left alone rather than half-recorded.
 */
function rootUnionScopes(node: Node, currentFile: string): string[] {
  const branches = node["anyOf"] ?? node["oneOf"];
  if (!Array.isArray(branches)) return [];
  const out: string[] = [];
  for (const branch of branches) {
    const asNodeBranch = asNode(branch);
    const ref = asNodeBranch === null ? null : asString(asNodeBranch["$ref"]);
    if (ref === null) return [];
    const scope = scopeOfRef(ref, currentFile);
    if (scope === null) return [];
    out.push(scope);
  }
  return out;
}

/** The namespaces a refScope names -- more than one means a polymorphic union. */
export function scopes(refScope: string | null): string[] {
  // Empties dropped. Three call sites split this column by hand and every one of
  // them filtered; only the canonical decoder did not, so the same stored string
  // could yield a different branch COUNT depending on which reader saw it. No
  // writer can produce a double space today, which is exactly why the difference
  // sat unnoticed -- the four readers disagreed about a case none of them met.
  return refScope === null ? [] : refScope.split(" ").filter(Boolean);
}

function emit(
  ctx: FlattenContext,
  pointer: string,
  node: Node,
  optional: boolean,
  defaultUnset: boolean,
  refScope: string | null = null,
): void {
  if (ctx.seenPointers.has(pointer)) {
    // A pointer is often emitted twice: once for the `anyOf` wrapper and once for
    // the `$ref` branch inside it. The wrapper arrives first and carries no
    // refScope, so plain dedup would discard exactly the information that lets an
    // observed pointer rebase into the target namespace -- which is why
    // Item./BlockType kept its whole subtree instead of handing it to BlockType.
    if (refScope !== null) {
      const existing = ctx.out.find(
        (fld) => fld.assetType === ctx.assetType && fld.pointer === pointer,
      );
      if (existing !== undefined && existing.refScope === null) {
        const index = ctx.out.indexOf(existing);
        ctx.out[index] = { ...existing, refScope };
      } else if (existing !== undefined && !scopes(existing.refScope).includes(refScope)) {
        // A SECOND, different target for the same pointer: the union is genuinely
        // polymorphic and which branch applies is decided by a discriminator in
        // the data. Accumulate every branch rather than keeping the first.
        //
        // This is the only reliable way to tell the two `anyOf` shapes apart.
        // `anyOf: [{$ref: X}, {type: null}]` is just an optional reference -- one
        // ref branch, unambiguous -- and treating every `anyOf` as polymorphic
        // stopped those rebasing too, taking the declared/observed join from
        // 20.5% down to 8.5%.
        const index = ctx.out.indexOf(existing);
        ctx.out[index] = { ...existing, refScope: `${existing.refScope!} ${refScope}` };
      }
    }
    return;
  }
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
    inheritsProperty: inheritsFlag(node),
    mergesProperties: meta?.["mergesProperties"] === true,
    // A SIBLING of the `hytale` block, not a member of it. Reading it from inside
    // `hytale` silently yields null for all 932 fields, which is exactly how this
    // was first written.
    referenceTarget: assetRefOf(node),
    refScope,
    typeConstant: declaredConstant(asString(node["description"])),
    discriminatorProperty: null,
    discriminatorValues: null,
  });
}

/**
 * Whether a property takes part in inheritance.
 *
 * The marker is `hytale.inheritsProperty`, and for 13 of Item's 52 marked
 * properties it sits inside an `anyOf` BRANCH rather than on the property node:
 * `BlockType`, `Tool`, `Weapon`, `Armor`, `Light`, `Reticle` and friends are all
 * `anyOf: [{$ref, hytale: {inheritsProperty}}, {null}]`. Reading only the
 * property node marked them as not inherited, and `get` then replaced the whole
 * of a crop's `BlockType` with the child's, dropping `Support` (the farmland
 * restriction) and `BlockEntity.Components.FarmingBlock` (what makes it tick)
 * from every plant in the game.
 *
 * This is the third marker found one level away from where it was read --
 * `hytaleAssetRef` twice, then `hytaleSchemaTypeField`. Check the branches.
 */
function inheritsFlag(node: Node): boolean {
  if (hytale(node)?.["inheritsProperty"] === true) return true;
  const branches = node["anyOf"] ?? node["oneOf"];
  if (!Array.isArray(branches)) return false;
  return branches.some((b) => {
    const branch = asNode(b);
    return branch !== null && hytale(branch)?.["inheritsProperty"] === true;
  });
}

/**
 * The asset type a property references, from `hytaleAssetRef`.
 *
 * Read on the property node **and inside its `anyOf` branches**, exactly like
 * `inheritsFlag` above -- and for the same reason. An optional reference is
 * spelled `anyOf: [{$ref: X, hytaleAssetRef: "Interaction"}, {type: "null"}]`,
 * so the marker sits on the branch, not on the property. Measured on the release
 * schema: 439 properties carry it directly, **363 carry it only inside a branch**,
 * and none carry two different targets, so the first branch to name one decides.
 *
 * Reading only the property node found 545 of them. The 363 it missed were graded
 * as name collisions rather than declared references: no `high` confidence, no
 * broken-reference detection (`dangling = 2`), no observed `target_types`. The
 * targets lost this way are the most referenced types in the corpus --
 * `Interaction` (205 properties), `RootInteraction` (26), `ItemDropList` (19),
 * `BlockSet` (19).
 *
 * This is the fourth marker in this schema found one level away from where it was
 * read, and the third time the fix has been "check the branches"
 * (`docs/init/OPEN-QUESTIONS.md` Q22).
 */
function assetRefOf(node: Node): string | null {
  const direct = asString(node["hytaleAssetRef"]);
  if (direct !== null) return direct;
  const branches = node["anyOf"] ?? node["oneOf"];
  if (!Array.isArray(branches)) return null;
  for (const branch of branches) {
    const found = asString(asNode(branch)?.["hytaleAssetRef"]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The constant a polymorphic branch declares for its own discriminator.
 *
 * The generator states it in prose and nowhere else -- there is no `const` or
 * single-valued `enum` to read -- so this is the only machine-readable form
 * available. Anchored on the exact sentence it always emits, so a description
 * that merely quotes something is not mistaken for a declaration.
 */
function declaredConstant(description: string | null): string | null {
  if (description === null) return null;
  return /must be set to the constant value "([^"]+)"/.exec(description)?.[1] ?? null;
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
  if (depth > MAX_NODE_DEPTH) return;
  if (ctx.out.length >= ctx.limit) return;
  if (++ctx.visits > MAX_VISITS_PER_TYPE) return;
  // Pointer depth is counted from the pointer itself, so following a $ref or an
  // anyOf branch costs nothing -- those move sideways, not downwards.
  if (pointer.length > 0 && pointer.split("/").length - 1 > MAX_POINTER_DEPTH) return;

  const ref = asString(node["$ref"]);
  if (ref !== null) {
    // Record the crossing; do not walk through it.
    //
    // Every namespace is flattened exactly once, and a $ref becomes an edge
    // between namespaces rather than an inlined copy. Expanding instead meant
    // common.json's 895 mutually-referencing definitions multiplied at every
    // referring site: 138,961 fields, 8 types truncated, and a declared/observed
    // join of 7.8% because the deep tail was cut off anyway.
    if (pointer !== "") emit(ctx, pointer, node, optional, false, scopeOfRef(ref, currentFile));
    return;
  }

  // A type whose ROOT is a union of $refs and nothing else -- Interaction.json is
  // `anyOf` over 102 concrete interaction definitions, with no properties of its
  // own. Skipping the root because `pointer === ""` left that namespace entirely
  // empty, so every observation that rebased into it had nowhere to land:
  // `common:BreakBlockInteraction` had zero observed fields while the corpus uses
  // it constantly, and 1 689 `RootInteraction./Interactions/*/Parent` rows sat
  // unjoined. Recorded at the empty pointer so `align()` can take the second hop
  // using the discriminator in the data.
  if (pointer === "" && !ctx.seenPointers.has("")) {
    const branches = rootUnionScopes(node, currentFile);
    // `mergesProperties` is a TYPE-level marker sitting on the schema root, not a
    // per-property one: 141 occurrences, nearly all at the root of a file. Read as
    // a property marker it was true for almost nothing, so `get` replaced every
    // nested object wholesale -- the opposite of what the type declares. Recorded
    // on the root row so the resolver can ask 'does this type merge?'.
    const typeMerges = hytale(node)?.["mergesProperties"] === true;
    if (branches.length > 1 || typeMerges) {
      // The root carries its own hytaleSchemaTypeField too -- Interaction.json
      // declares `property: "Type"` and 102 values aligned with its branches.
      // Omitting it left `describe Interaction` printing "?" for every branch
      // while the complete legal set sat one field away.
      const rootDeclared = readDeclaration(node, currentFile);
      ctx.seenPointers.add("");
      ctx.out.push({
        assetType: ctx.assetType,
        pointer: "",
        declaredType: Array.isArray(node["anyOf"]) ? "anyOf" : "oneOf",
        optional: true,
        defaultValue: null,
        defaultUnset: false,
        enumValues: null,
        title: asString(node["title"]),
        description: null,
        inheritsProperty: false,
        mergesProperties: typeMerges,
        referenceTarget: null,
        // Null unless this really is a union. An empty string here made
        // `describe Item` announce "a union of 0 shapes": the merge-only root
        // rows added for `mergesProperties` all matched `ref_scope IS NOT NULL`.
        refScope: branches.length > 1 ? (rootDeclared?.scopes ?? branches).join(" ") : null,
        typeConstant: null,
        discriminatorProperty: rootDeclared?.property ?? null,
        discriminatorValues: rootDeclared?.values.join(" ") ?? null,
      });
    }
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

  // The generator DECLARES its discriminators, and this reads that declaration
  // rather than reconstructing it.
  //
  // Two heuristics preceded this and both were wrong in ways that cost real
  // investigation. Matching the discriminator value against the branch NAME by
  // prefix works for `BreakBlock` -> `BreakBlockInteraction` and fails for
  // `Selector` -> `SelectInteraction`, which reported every field of a type used
  // 415 times as unused. And the discriminator PROPERTY was hardcoded to `Type`,
  // while 15 of the 244 declarations name `Id` or `Op` -- those unions could
  // never resolve at all, including `ScriptedBrushAsset./Operations/*`, 56
  // branches that were recorded as having no discriminator when the schema says
  // it is `Id`.
  //
  // This is the third machine-readable marker in this schema found only after
  // being reconstructed by hand; `hytaleAssetRef` was the first two occasions.
  const declared = unionDeclaration(node, currentFile);
  if (declared !== null && pointer !== "") {
    upgradeUnion(ctx, pointer, declared);
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
/**
 * Namespace a `$ref` points into.
 *
 * `BlockType.json#` -> `BlockType` (an asset type).
 * `common.json#/definitions/ItemTool` -> `common:ItemTool` (a shared definition,
 * which gets its own pointer space so it is described once rather than per
 * referring type).
 */
function scopeOfRef(ref: string, currentFile: string): string | null {
  const hash = ref.indexOf("#");
  const file = hash <= 0 ? currentFile : ref.slice(0, hash);
  const pointer = hash < 0 ? "" : ref.slice(hash + 1);
  const base = file.replace(/\.json$/, "");
  const defName = /^\/definitions\/([^/]+)$/.exec(pointer)?.[1];
  if (defName !== undefined) return `${base}:${defName}`;
  return pointer === "" || pointer === "/" ? base : null;
}

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
        const base = file.replace(/\.json$/, "");
        for (const [name, body] of Object.entries(defs)) {
          definitions.push({ sourceFile: file, name, body: JSON.stringify(body) });
          const node = asNode(body);
          if (node === null) continue;
          // Its own namespace, flattened once, referenced by pointer from anywhere.
          flatten(
            {
              assetType: `${base}:${name}`,
              resolver,
              out: fields,
              seenPointers: new Set(),
              refStack: [],
              repaired,
              limit: fields.length + MAX_FIELDS_PER_TYPE,
              visits: 0,
            },
            node,
            "",
            `/definitions/${name}`,
            file,
            0,
            true,
          );
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

    const before = fields.length;
    flatten(
      {
        assetType: id,
        resolver,
        out: fields,
        seenPointers: new Set(),
        refStack: [],
        repaired,
        limit: before + MAX_FIELDS_PER_TYPE,
        visits: 0,
      },
      root,
      "",
      "",
      file,
      0,
      true,
    );
    if (fields.length - before >= MAX_FIELDS_PER_TYPE) {
      warnings.push(
        `${id}: field list truncated at ${MAX_FIELDS_PER_TYPE} -- the schema references ` +
          `itself too broadly to enumerate fully`,
      );
    }
  }

  return { types, fields, definitions, warnings };
}
