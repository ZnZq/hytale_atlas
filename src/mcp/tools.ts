import type { Database } from "../db/open.ts";
import { AssetArchive } from "../sources/archive.ts";
import {
  typesOp,
  assetsDeclaringField,
  countAssetsDeclaringField,
  packDefinitions,
  refreshWorking,
  declarerSampleSize,
  assetsOfType,
  benchIdExists,
  benchOp,
  benchesOp,
  brokenRefsFor,
  declaredCount,
  describeOp,
  getAssetOp,
  packAssetLoader,
  identify,
  langOp,
  refsAnyOp,
  searchAssetsOp,
  searchSchemaOp,
  statusOp,
  typeAlternatives,
  typeExists,
  undeclaredObserved,
  undocumentedOp,
  valueLinkFor,
} from "../api/operations.ts";
import { isContainer, normalizeFieldPointer } from "../query/schema.ts";
import { type Caveat, type Result, caveat } from "../api/types.ts";

/**
 * The MCP surface: one tool per question, each returning an operation's own
 * `{ value, caveats }` object.
 *
 * **Nothing here computes an answer.** Every handler calls into `src/api` and
 * serialises what comes back, which is the whole reason that layer exists: the
 * defects this project keeps finding are *sentences*, and the sentences live in
 * the caveats. A server that re-derived a total, re-worded a limitation or
 * dropped a caveat would ship exactly the divergence the CLI already paid for --
 * `benchOp` returned 200 recipes while the CLI printed 911, and `statsOp`
 * returned a locale count the CLI had already replaced with names.
 *
 * Where a CLI command enriches an operation (describe adds broken references,
 * value links and declaring assets), this composes the SAME operations rather
 * than reimplementing the enrichment. Composition is allowed; computation is not.
 *
 * **Deliberately not exposed:** `index`, `generate-schema`, `clean` and `eval`.
 * The first three mutate state, and `generate-schema` launches the game's own
 * generator, which emits telemetry that cannot be switched off and therefore
 * requires explicit human consent (`docs/SERVER-JAR.md`). Putting it behind a
 * tool call would route around that consent, which is the one thing that path
 * exists to prevent. `eval` measures the tool against a fixture set on disk and
 * is a development instrument, not an answer about the game.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** JSON Schema helpers, kept tiny -- these shapes are all flat. */
const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const int = (description: string): Record<string, unknown> => ({
  type: "integer",
  description,
  minimum: 1,
});
const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties: false,
});

// Two arguments, because one description was wrong on four of the five tools
// that carried it. A shared definition is not an asset type: nothing carries
// `common:ItemTool`, so offering it as the example here invited a call that
// cannot return anything -- `types(type: 'common:ItemTool')` answers "the schema
// declares this type but no vanilla asset carries it", which reads as a fact
// about vanilla when it is structural. Only `describe` reads the schema and so
// only `describe` accepts them.
const TYPE_ARG = str(
  "Asset type, e.g. 'Item'. This is the type an ASSET carries; shared definitions " +
    "('common:...') name no asset and belong to `describe` instead.",
);
const SCHEMA_TYPE_ARG = str(
  "Asset type, e.g. 'Item', or a shared definition with its namespace: 'common:ItemTool'.",
);
const LIMIT_ARG = int("Maximum rows. The answer says so when it truncates.");

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "status",
    // Promises what it now returns. It once described the CLI command's output
    // while serving `statsOp`, which knows only the index counts -- two agents
    // reported the gap. The operation carries both halves, so the description
    // can be whole again.
    description:
      "Where the game is and what the index holds: install paths, patchline, which " +
      "source tiers are available, and the corpus counts -- assets, typed assets, schema " +
      "fields, edges, the declared/observed join, and the locales this Assets.zip ships. " +
      "Answerable even before the index is built, so start here.",
    inputSchema: object({}),
  },
  {
    name: "types",
    description:
      "Every asset type with how many assets carry it, how many fields the schema declares, " +
      "and where its files live. Pass `type` to list the ASSETS of one type -- that is how " +
      "to enumerate the legal values of a field declared '-> SomeType'.",
    inputSchema: object({ type: TYPE_ARG, limit: LIMIT_ARG }),
  },
  {
    name: "search",
    description:
      "Find an asset by identifier or localized name, in any indexed locale. Searches NAMES, " +
      "not field values -- to find what uses a value, call `refs` with it instead.",
    inputSchema: object({ query: str("Free text: an identifier or a translated name."), type: TYPE_ARG, limit: LIMIT_ARG }, ["query"]),
  },
  {
    name: "get",
    description:
      "The effective definition of one asset, with its parent chain folded in -- what the " +
      "engine sees, not what the file says. Identifiers are not unique across types; pass " +
      "`type` to choose. When several packs define one identifier this returns the LIST of " +
      "packs instead of a document -- the engine keeps whichever pack loaded last and that " +
      "order is not in this index, so call again with `pack` to say which one you want.",
    inputSchema: object(
      {
        id: str("Asset identifier, e.g. 'Tool_Pickaxe_Iron'."),
        type: TYPE_ARG,
        pack: str(
          "Which pack's version to read, e.g. 'Hytale' for the base game. Required " +
            "once a previous call reported several definitions; it also reads a version " +
            "the game does not load.",
        ),
      },
      ["id"],
    ),
  },
  {
    name: "describe",
    description:
      "The schema of a type, in two layers that are never merged: DECLARED (what the game " +
      "accepts) and OBSERVED (what vanilla actually does). Pass `field` for one pointer, " +
      "which also returns its broken references, value link and declaring assets.",
    inputSchema: object(
      { type: SCHEMA_TYPE_ARG, field: str("JSON pointer, e.g. '/Tool/Specs/*/Power'."), limit: LIMIT_ARG },
      ["type"],
    ),
  },
  {
    name: "refs",
    description:
      "What points at this. Answers three questions depending on what the string turns out " +
      "to be: an asset (inbound edges), a plain field value (where it occurs), or a file " +
      "(which assets reference it).",
    inputSchema: object({ id: str("An asset id, a field value, or a file name."), type: TYPE_ARG, limit: LIMIT_ARG }, ["id"]),
  },
  {
    name: "search_schema",
    description:
      "Where a capability is declared, searching field names, titles, descriptions and enum " +
      "values. The index is LEXICAL: a miss is evidence, not proof, and the result says so.",
    inputSchema: object({ query: str("Words describing a capability, e.g. 'gather type'."), limit: LIMIT_ARG }, ["query"]),
  },
  {
    name: "search_lang",
    description:
      "Localization keys and their translations. Returns both spellings: the stored key and " +
      "the reference an asset must contain (they differ by a root prefix).",
    inputSchema: object({ query: str("A key, a key fragment, or a translated string."), limit: LIMIT_ARG }, ["query"]),
  },
  {
    name: "bench",
    description:
      "Crafting stations. Without an id, every bench; with one, its categories and what it " +
      "crafts. The bench id a recipe must name is NOT the id of the asset declaring it.",
    inputSchema: object({ id: str("Bench id, e.g. 'Workbench'. Omit for the full list."), limit: LIMIT_ARG }),
  },
  {
    name: "undocumented",
    description:
      "Fields the schema declares that appear in zero vanilla assets. A negative, and " +
      "qualified as one: the result carries the declared-side join ratio.",
    inputSchema: object({ type: SCHEMA_TYPE_ARG, limit: LIMIT_ARG }),
  },
];

/** Arguments arrive as JSON; these read them without trusting the shape. */
function text(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function count(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * A miss is an ANSWER, not an error.
 *
 * The CLI exits 1 for "nothing matched" and that is right for a shell, but an
 * MCP error would tell the model the call failed rather than that the corpus is
 * silent -- and "no such asset" is frequently the finding. So a miss returns a
 * normal result carrying `found: false` and the same guidance the CLI prints.
 */
function miss(reason: string, next?: Record<string, unknown>): Result<Record<string, unknown>> {
  return { value: { found: false, reason, ...(next ?? {}) }, caveats: [] };
}

/**
 * A miss that KEEPS the operation's own rendering and caveats.
 *
 * Every miss here used to be re-worded locally, and every re-wording lost
 * something the CLI said: the route across a `$ref` crossing, the reason a bench
 * id with no station is still a bench, the rule about localization roots. The
 * structured fields are what a model acts on; `text` is the same sentence a
 * person would have read.
 */
function missOf(
  result: Result<unknown>,
  fields: Record<string, unknown>,
): Result<Record<string, unknown>> {
  return {
    value: { found: false, ...fields },
    caveats: result.caveats,
    ...(result.text === undefined ? {} : { text: result.text }),
  };
}

export interface ToolContext {
  readonly db: Database;
  /** Opened lazily: only `get` needs the archive, and it costs ~4s. */
  openArchive: () => Promise<AssetArchive>;
  /** Where the index lives, for the CLI renderer to reopen. */
  readonly options: { assets?: string; patchline?: string };
}

export async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Result<unknown>> {
  const { db } = ctx;
  // Before answering, not on a timer. A server outlives the files it describes,
  // so the pack being authored is re-read here whenever its tree stamp moved --
  // which is why a one-shot CLI run and a long-lived server need no different
  // code, and why a missed file-watch event cannot produce a stale answer.
  await refreshWorking(db);
  // A malformed `limit` is REPORTED, not swallowed. `count` maps anything
  // invalid to undefined, which the operations then replace with their default,
  // so `limit: 0` returned a full page and `limit: "20"` returned the default --
  // in both cases indistinguishable from a request that named no limit at all.
  // The CLI has rejected exactly these since the day `--limit 0` printed
  // "No matches." for a query with dozens; the lesson never crossed to MCP.
  if (args["limit"] !== undefined && count(args, "limit") === undefined) {
    return miss(
      `'limit' takes a positive whole number, not ${JSON.stringify(args["limit"])}.`,
    );
  }
  const limit = count(args, "limit");

  switch (name) {
    case "status":
      // The whole question, from the same operation the CLI prints: install
      // paths, patchline, tiers AND index counts. It used to serve `statsOp`,
      // which knows only the counts, so the description promised paths and a
      // tier that the payload never carried.
      return statusOp(ctx.options);

    case "types": {
      // The operation renders itself, so this returns exactly what the CLI
      // prints -- including the footnote about `common:` definitions, whose
      // absence here an agent reported as "types silently omits a namespace".
      const type = text(args, "type");
      const result = typesOp(db, {
        ...(type === undefined ? {} : { type }),
        ...(limit === undefined ? {} : { limit }),
      });
      if (result.value.kind === "miss") {
        return missOf(result, {
          reason: result.value.reason,
          type: result.value.type,
          didYouMean: typeExists(db, result.value.type)
            ? []
            : typeAlternatives(db, result.value.type),
        });
      }
      return result;
    }

    case "search": {
      const query = text(args, "query");
      if (query === undefined) return miss("A 'query' is required.");
      return searchAssetsOp(db, query, limit ?? 20, text(args, "type"));
    }

    case "get": {
      const id = text(args, "id");
      if (id === undefined) return miss("An 'id' is required.");
      const type = text(args, "type");
      // Pack-aware: `get` used to read the vanilla archive alone, so a mod's
      // asset was catalogued and unreachable -- the worst state, because every
      // count still included it.
      const pack = text(args, "pack");
      const { load, close } = packAssetLoader(
        db,
        type,
        ...(pack === undefined ? [] : [{ logicalId: id, pack }]),
      );
      const resolved = await getAssetOp(db, id, load, type, false, pack);
      close();
      // A multi-pack identifier also comes back with no value, and it is NOT a
      // miss -- the asset exists and is waiting on a choice. Reporting "No asset"
      // there would deny something the very same result is listing.
      const needsChoice = resolved.caveats.some(
        (c) => c.code === "shadowed" || c.code === "contested-packs",
      );
      // The pack names a client must choose between belong in the payload, not
      // only in a sentence. This branch returned `value: null` with the choices
      // spelled out in prose and in CLI syntax -- `--pack "Endgame&QoL"` -- so an
      // MCP client following this project's own advice ("the machine-actionable
      // form is value and the caveat codes") had to regex a shell command out of
      // an English paragraph to learn what to pass. Enrichment by composition,
      // the same shape `missOf` uses.
      if (needsChoice) {
        return {
          ...resolved,
          value: {
            found: false,
            reason: `'${id}' is defined by more than one pack -- pass 'pack' to choose.`,
            packs: packDefinitions(db, id, type).map((d) => ({
              pack: d.pack,
              vanilla: d.kind === "vanilla",
              path: d.path,
            })),
          },
        };
      }
      if (resolved.value === null) {
        return missOf(resolved, {
          reason: benchIdExists(db, id)
            ? `'${id}' is a bench id, not an asset. Call 'bench' with it.`
            : `No asset '${id}'${type === undefined ? "" : ` of type '${type}'`}.`,
          alsoKnownAs: identify(db, id),
        });
      }
      return resolved;
    }

    case "describe": {
      const type = text(args, "type");
      if (type === undefined) return miss("A 'type' is required.");
      const field = text(args, "field");
      const request = {
        assetType: type,
        ...(field === undefined ? {} : { field }),
        ...(limit === undefined ? {} : { limit }),
      };
      const described = describeOp(db, request);

      if (described.value.fields.length === 0 && described.value.union === null) {
        const carried = assetsOfType(db, type);
        if (!typeExists(db, type) && carried === 0) {
          return missOf(described, {
            reason: `No type '${type}' in the schema.`,
            didYouMean: typeAlternatives(db, type),
          });
        }
        if (field !== undefined) {
          // The route out, not just the denial. `nearestDeclared` alone reads as
          // "the field tree stops here"; `continuesIn` names the type the pointer
          // actually continues in, and the operation's caveat says it in words.
          return missOf(described, {
            reason: `'${type}' has no field '${normalizeFieldPointer(field)}'.`,
            nearestDeclared: described.value.nearestDeclared,
            continuesIn: described.value.continuesIn,
          });
        }
        return missOf(described, {
          reason:
            `'${type}' is a real asset type (${carried} assets) but the schema declares ` +
            `no fields for it.`,
        });
      }

      // Enrichment by COMPOSITION -- the same operations the CLI calls, not a
      // second implementation of them.
      // The sample honours the caller's `limit`. It was a hard seven, and an
      // agent trying to establish whether ANY vanilla item emits light while
      // worn was handed "7 of 93" with no way to page -- it said so, and gave up
      // on the question. A sample nobody can widen is a wall, not a sample.
      // The same rule the rendered text uses, not a second one.
      const rows = declarerSampleSize(limit);
      let clipped = 0;
      const enriched = described.value.fields.map((f) => {
        const broken = brokenRefsFor(db, type, f.pointer);
        // A field that HOLDS other fields, which is not the same as a field whose
        // declared type is a union. `isContainer` answers the broader question --
        // it is what puts the CLI's `(container)` marker on `anyOf` rows, and that
        // marker is right -- but the note below asserts an IMPOSSIBILITY, and an
        // `anyOf` of scalars can and does carry values: `/EffectId` arrived
        // flagged beside its own `observed.count: 147`, and on
        // `common:AOECircleSelector./Range` the note told a reader to disregard
        // the seven observed values that were the only evidence of its units.
        const container = isContainer(f.declared?.type ?? null) && f.observed === null;
        const declarers =
          field === undefined
            ? null
            : {
                shown: assetsDeclaringField(db, type, f.pointer, rows),
                total: countAssetsDeclaringField(db, type, f.pointer),
              };
        if (declarers !== null && declarers.shown.length < declarers.total) {
          clipped = Math.max(clipped, declarers.total);
        }
        return {
          ...f,
          // Per FIELD, because the caveat is per call. In bulk mode a container
          // arrived as `observed: null` with no marker at all, which reads as
          // "no vanilla asset uses this" -- false for `EntityEffect./DamageResistance`,
          // which `Immunity_Fire` plainly sets. The same call with `field` set
          // added `container-no-observations` and the reading flipped. The CLI
          // encodes this as a `(container)` marker on every row; the served
          // shape had nowhere to put it.
          isContainer: container,
          ...(container
            ? {
                observedNote:
                  "Containers hold other fields and never a value of their own, so they " +
                  "CANNOT appear in the observed layer. Absence here says nothing about use.",
              }
            : {}),
          ...(broken.distinct > 0 ? { brokenReferences: broken } : {}),
          ...(declarers === null
            ? {}
            : {
                valueLink: valueLinkFor(db, type, f.pointer),
                // The sample and its total, together. Returned bare, seven rows
                // against `observed.assets: 11` looked like the whole set to
                // anything counting array lengths -- which is exactly what a
                // machine-readable payload invites.
                declaredBy: declarers,
              }),
        };
      });
      return {
        value: {
          ...described.value,
          fields: enriched,
          declaredFieldCount: declaredCount(db, type),
          observedOnlyFieldCount: undeclaredObserved(db, type),
        },
        // The sample is capped at seven rows and `limit` does not reach it, so
        // the cap has to be SAID. Four agents in one round re-ran with a larger
        // limit, got the identical seven rows, and had no way to tell a clipped
        // list from a whole one -- one of them needed the four assets that were
        // missing and could reach them by no call at all.
        caveats:
          clipped > 0
            ? [...described.caveats, caveat.truncated(rows, "declaring assets", clipped)]
            : described.caveats,
        ...(described.text === undefined ? {} : { text: described.text }),
      };
    }

    case "refs": {
      const id = text(args, "id");
      if (id === undefined) return miss("An 'id' is required.");
      // Every branch -- asset, wrong type, value, file, miss -- comes from one
      // operation now. Assembled here, each one diverged: the value branch was
      // served with `caveats: []` and one row more than the limit asked for.
      return refsAnyOp(db, id, text(args, "type"), limit ?? 40) as Result<unknown>;
    }

    case "search_schema": {
      const query = text(args, "query");
      if (query === undefined) return miss("A 'query' is required.");
      return searchSchemaOp(db, query, limit ?? 20);
    }

    case "search_lang": {
      const query = text(args, "query");
      if (query === undefined) return miss("A 'query' is required.");
      const found = langOp(db, query, limit ?? 20);
      // The operation's own miss text, which explains root stripping and the
      // literal-matching limit. This returned a paraphrase of it.
      return found.value.length === 0
        ? {
            value: { found: false, reason: found.text ?? "" },
            caveats: found.caveats,
            ...(found.text === undefined ? {} : { text: found.text }),
          }
        : found;
    }

    case "bench": {
      const id = text(args, "id");
      if (id === undefined) return benchesOp(db, limit ?? 200) as Result<unknown>;
      return benchOp(db, id, limit ?? 200) as Result<unknown>;
    }

    case "undocumented":
      return undocumentedOp(db, text(args, "type"), limit ?? 40);

    default:
      return miss(`No tool named '${name}'.`);
  }
}

export type { Caveat };
