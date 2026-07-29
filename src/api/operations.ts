import { existsSync } from "node:fs";

import { type Database, openDatabase, pipelineState } from "../db/open.ts";
import { craftableAt } from "../indexer/benches.ts";
import { type AssetLoader, type ResolvedAsset, resolveAsset } from "../query/asset.ts";
import {
  type FieldDescription,
  describeSchema,
  findUndocumented,
  isContainer,
  looksMangled,
  normalizeFieldPointer,
  pointersLike,
  searchSchemaDetailed,
} from "../query/schema.ts";
import { type SearchHit, searchAssets } from "../query/search.ts";
import { archiveStamp } from "../sources/archive.ts";
import { detectInstallation, detectProject } from "../sources/detect.ts";
import { referenceToKey } from "../sources/lang.ts";
import { scopes } from "../sources/schema-doc.ts";
import { formatCount, frozenDbPath, frozenKey } from "../util/paths.ts";
import {
  type Caveat,
  type Result,
  caveat,
  caveatBlock,
  clip,
  ok,
  rendered,
  truncationLine,
} from "./types.ts";

/**
 * Every question the tool can answer, once.
 *
 * The CLI and (later) the MCP server both call these and only render what comes
 * back. A front end that computes anything -- a limit, a fallback, a wording --
 * has reintroduced the divergence this layer exists to prevent.
 *
 * Over-fetching by one is done here rather than in each caller, because "there
 * is more" is part of the answer: a truncated list that does not say so reads as
 * complete, which is how `undocumented` came to show 40 rows out of 6 324 in
 * silence.
 */

export interface OpenOptions {
  readonly assets?: string;
  readonly patchline?: string;
}

/** Resolves and opens the frozen index, or explains precisely why it cannot. */
export async function openIndex(options: OpenOptions = {}): Promise<Database> {
  const archivePath = options.assets ?? detectInstallation(options.patchline)?.assetsZip;
  if (archivePath == null) {
    throw new Error("Assets.zip not found. Set HYTALE_ROOT, or pass an explicit path.");
  }
  const dbPath = frozenDbPath(frozenKey(archivePath, await archiveStamp(archivePath)));
  if (!existsSync(dbPath)) {
    throw new Error(`No index yet. Build it first.\n  expected: ${dbPath}`);
  }
  return openDatabase(dbPath, { readOnly: true });
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  return Number(
    (db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined)?.["n"] ?? 0,
  );
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * The next commands worth running, chosen from what the token actually IS.
 *
 * One suggester for every miss, reading one classification (`identify`). Each
 * command used to decide this for itself from a single fact, and the results
 * contradicted each other: `search` and `refs` forwarded to one another on a miss
 * with no exit, reported by four agents in one round.
 *
 * Phrased as command lines because that is what a person reads; the
 * machine-actionable form is `value` and the caveat codes. Every command named
 * here also exists as an MCP tool -- a suggestion the caller cannot act on is
 * precisely the defect these lines exist to remove.
 */
export function nextCommands(
  db: Database,
  token: string,
  exclude: "refs" | "search" | null = null,
  extra: readonly (readonly [string, string])[] = [],
): string {
  const id = identify(db, token);
  // Keyed by command, so a token that is several things at once -- a bench
  // category IS also a field value -- is offered one line per command with the
  // strongest reason, not the same command twice.
  const lines = new Map<string, string>();
  const add = (command: string, why: string): void => {
    if (!lines.has(command)) lines.set(command, why);
  };
  const refs = `hytale-atlas refs ${token}`;

  if (id.assets > 0 && exclude !== "refs") add(refs, "what references that asset");
  if (id.benchCategory && !id.benchId && exclude !== "refs") {
    add(refs, "it is a bench CATEGORY, not a bench id -- this shows what uses it");
  }
  if (id.valueOccurrences > 0 && exclude !== "refs") {
    add(
      refs,
      `where this VALUE is used (${formatCount(id.valueOccurrences)}x in ` +
        `${formatCount(id.valueAssets)} assets)`,
    );
  }
  if (id.files > 0 && exclude !== "refs") add(refs, "what references that file");
  if (id.langKey !== null) {
    add(`hytale-atlas search-lang ${token}`, "the localization key and its translations");
  }
  if (id.benchId) add(`hytale-atlas bench ${token}`, "what is crafted at that bench");
  if (id.assets > 0 && exclude !== "search") {
    add(`hytale-atlas get ${token}`, "its effective definition");
  }
  // Always last, and always available: it is the one command whose miss is
  // itself an answer about the schema.
  add("hytale-atlas search-schema <words>", "where a capability is declared");
  for (const [command, why] of extra) add(command, why);

  const width = Math.max(...[...lines.keys()].map((c) => c.length));
  return [...lines].map(([c, why]) => `  ${c.padEnd(width)}  ${why}\n`).join("");
}

export function searchAssetsOp(
  db: Database,
  query: string,
  limit = 20,
  type?: string,
): Result<SearchHit[]> {
  // `--type` was parsed, passed to `get`, and dropped here: `search stone
  // --type BlockSet` returned byte-identical output to no flag at all, silently.
  const found = searchAssets(db, query, { limit: limit + 1, ...(type ? { type } : {}) });
  const hits = found.slice(0, limit);
  const caveats: Caveat[] = [];
  if (found.length > limit) caveats.push(caveat.truncated(hits.length, "matches"));

  // Loosening is a QUALIFICATION, so it belongs in the caveats. The CLI marks
  // each row `~N` and prints a legend; the served answer carried a bare integer
  // named `relaxation` and an empty caveat array, so `search Burning` returned
  // four effects, none of them named Burning, with nothing saying the query had
  // been widened three times. `search_schema` has emitted `relaxed` for this all
  // along -- one surface qualified its guesses and the other did not.
  const loosened = Math.max(0, ...hits.map((h) => h.relaxation ?? 0));
  if (loosened > 0) caveats.push(caveat.relaxed(query, loosened, false));

  // A miss in the FTS index is not a miss in the corpus. `assets` holds 22 734
  // distinct identifiers and `assets_fts` 22 237: 497 of them -- 4 757 rows,
  // all worldgen under Server/World -- have no FTS row at all, so
  // `search 001_start.node` answered 'No asset is named ... in any indexed
  // locale' about eight assets that exist. Worse, the very next line offered
  // `refs 001_start.node`, because that suggestion consults `assets`.
  if (hits.length === 0) {
    // Honours --type. The first version of this fallback did not, so
    // `search Bench --type Nonexistent` started returning rows for a type that
    // does not exist -- turning a fixed defect back into a worse one.
    // Over-fetched by one, like the indexed path above. It was not, so this
    // branch could never tell that it had capped: `search brush --type
    // ScriptedBrushAsset` printed 20 rows and "these 20 row(s) come from a
    // literal identifier lookup", while --limit 45 returned 21. The withheld row
    // was a brush -- i.e. a mechanism -- and --help promises "every one says so
    // when it truncates". A rule kept by repeating it at each site is a rule
    // that holds until someone adds a site.
    const fetched = db
      .prepare(
        `SELECT DISTINCT logical_id, type FROM assets
          WHERE (logical_id = ?1 COLLATE NOCASE OR logical_id LIKE '%' || ?1 || '%')
            AND (?3 IS NULL OR type = ?3)
          ORDER BY length(logical_id), logical_id LIMIT ?2`,
      )
      .all(query, limit + 1, type ?? null) as unknown as {
      logical_id: string;
      type: string | null;
    }[];
    const literal = fetched.slice(0, limit);
    if (literal.length > 0) {
      const total = count(
        db,
        `SELECT count(*) AS n FROM (SELECT DISTINCT logical_id FROM assets
           WHERE (logical_id = ?1 COLLATE NOCASE OR logical_id LIKE '%' || ?1 || '%')
             AND (?2 IS NULL OR type = ?2))`,
        query,
        type ?? null,
      );
      const rows = literal.map((r) => ({
        logicalId: r.logical_id,
        type: r.type ?? "",
        locale: "",
        displayName: r.logical_id,
        relaxation: 0,
      })) as unknown as SearchHit[];
      const literalCaveats = [
        caveat.identifierOnly(
          literal.length,
          count(
            db,
            `SELECT count(*) AS n FROM (SELECT DISTINCT logical_id FROM assets
                 WHERE logical_id NOT IN (SELECT logical_id FROM assets_fts))`,
          ),
        ),
        ...(fetched.length > limit ? [caveat.truncated(literal.length, "matches", total)] : []),
      ];
      return rendered(rows, searchTable(rows, literalCaveats), literalCaveats);
    }
  }
  // Stated on a miss, because "no matches" reads as "this string appears
  // nowhere" when the index only ever held names.
  if (hits.length === 0) {
    caveats.push(caveat.namesNotValues());
    return rendered(hits, searchMiss(db, query, type, caveats), caveats);
  }
  return rendered(hits, searchTable(hits, caveats), caveats);
}

/**
 * The hit table, with its legend.
 *
 * Two markers used to be printed with no legend anywhere, and both are about the
 * QUERY rather than the asset -- which is how a reader concluded an item was only
 * translated into pt-BR after seeing `[pt-BR]` beside it. The bracket names the
 * locale the match was FOUND in; `~N` means the query had to be loosened N times
 * to reach the row.
 */
function searchTable(hits: readonly SearchHit[], caveats: readonly Caveat[]): string {
  // "name" was a promise the column cannot keep. Translation references are
  // recognised by SHAPE, not by an allowlist of field names -- they arrive under
  // at least eight, `Value` being the second most common -- so the text here is
  // whichever translated string the asset carries. `Burn` has no name at all and
  // its only translation is a DeathMessageKey, which the header then presented as
  // the effect's name.
  const header =
    `${"ASSET ID".padEnd(36)} ${"TYPE".padEnd(22)} [locale the match was ` +
    `found in] translated text\n\n`;
  const body = hits
    .map(
      (hit) =>
        // `??` never fired: the FTS table stores an empty string, not NULL, so
        // 14 198 of 45 449 rows printed a blank TYPE column and an empty `[]`
        // where the header promises a locale. `get` and `refs` print `(untyped)`
        // for the very same assets.
        `${hit.logicalId.padEnd(36)} ${(hit.type || "(untyped)").padEnd(22)} ` +
        // Falls back to the identifier: the column carries the translation alone,
        // so an asset whose translation resolves to an empty string would print a
        // bare `[en-US]` with nothing after it.
        `[${hit.locale || "id"}] ${hit.displayName || hit.logicalId}` +
        `${hit.relaxation > 0 ? `  ~${hit.relaxation}` : ""}\n`,
    )
    .join("");
  const loosened = hits.some((h) => h.relaxation > 0)
    ? `\n~N marks a row the query only reached after being loosened N time(s); ` +
      `those are weaker matches.\n`
    : "";
  return (
    header +
    body +
    loosened +
    `\n[id] means the match was on the identifier, not on a translation.\n` +
    `A locale here is where THIS query matched, not the only language the ` +
    `asset has.\nThe text is whichever translated string the asset carries -- ` +
    `usually its name, but\nan asset with no name shows another (a death ` +
    `message, a hint).\nUse 'search-lang <id>' for every translation of one asset.\n` +
    caveatBlock(caveats)
  );
}

/**
 * The miss, which is the answer that gets misread.
 *
 * "No matches." reads as "this string appears nowhere". The index holds
 * identifiers and localized names, not field VALUES. The `--type` scope was also
 * dropped from the sentence, so a scoped miss made a claim about the whole
 * corpus: `search Workbench --type BenchCategory` answered "No asset is named
 * 'Workbench', in any indexed locale" about a string that is an asset's own
 * en-US name. Five blind trials hit this and one nearly concluded a damage type
 * does not exist.
 */
function searchMiss(
  db: Database,
  query: string,
  type: string | undefined,
  caveats: readonly Caveat[],
): string {
  const unscoped = type === undefined ? 0 : searchAssetsOp(db, query, 1).value.length;
  const known =
    type === undefined ||
    (db.prepare("SELECT count(*) AS n FROM assets WHERE type = ?").get(type) as { n: number })
      .n > 0;
  return (
    (type === undefined
      ? `No asset is named "${query}", in any indexed locale.\n\n`
      : !known
        ? `No asset type '${type}' exists, so nothing could match. ` +
          `Drop the type filter, or check the spelling.\n\n`
        : `No asset of type '${type}' is named "${query}", in any indexed locale.` +
          (unscoped > 0
            ? ` Without the type filter there ARE matches -- run the same search without it.`
            : ` Without the type filter there are none either.`) +
          `\n\n`) +
    `${caveats.map((c) => c.message).join("\n")}\n\n`.replace(
      "not field values.",
      "NOT field values.",
    ) +
    // Built from what the token IS, not from one fact about it. Gating `refs` on
    // "is it an asset" was the inverse of the sentence printed just above --
    // which is about VALUES -- so the one command that answers the value case was
    // withheld exactly when it applied.
    nextCommands(db, query.split(/\s+/)[0] ?? query)
  );
}

export interface AssetCandidate {
  readonly type: string | null;
  readonly path: string;
}

/**
 * Ordering used everywhere an identifier must resolve to one asset.
 *
 * Shared deliberately: the disambiguation note and the loader once ordered
 * differently, so `get Plant_Bush` said "Showing the Item one" and printed the
 * ItemDropList.
 */
const PICK_ORDER = "ORDER BY is_effective DESC, type";

export function sameNamed(db: Database, logicalId: string): AssetCandidate[] {
  return db
    .prepare(`SELECT type, path FROM assets WHERE logical_id = ? ${PICK_ORDER} LIMIT 8`)
    .all(logicalId) as unknown as AssetCandidate[];
}

/**
 * How many assets carry this identifier, without the display cap.
 *
 * The note said '8 assets are named Entry.node' because it counted the SAMPLE:
 * 461 are. 442 identifiers have more than eight rows, and `refs` -- whose
 * target query has no LIMIT -- disagreed with `get` on every one of them.
 */
export function sameNamedCount(db: Database, logicalId: string): number {
  return count(db, "SELECT count(*) AS n FROM assets WHERE logical_id = ?", logicalId);
}

/**
 * The distinct types carrying an identifier.
 *
 * The ambiguity note wants types, not assets: built from the 8-row sample it
 * listed whatever that sample happened to hold, so 461 untyped `Entry.node`
 * rows produced eight repetitions of one word and no information.
 */
export function sameNamedTypes(db: Database, logicalId: string): string[] {
  return (
    db
      .prepare("SELECT DISTINCT type FROM assets WHERE logical_id = ? ORDER BY type")
      .all(logicalId) as unknown as { type: string | null }[]
  ).map((r) => r.type ?? "untyped");
}

export async function getAssetOp(
  db: Database,
  logicalId: string,
  load: AssetLoader,
  type?: string,
  raw = false,
): Promise<Result<ResolvedAsset | null>> {
  const candidates = sameNamed(db, logicalId);
  // The count comes from an unlimited query; `candidates` is the 8-row sample.
  // Deriving it here said '8 assets are named Entry.node' where 461 are -- the
  // CLI had already been fixed and this copy had not. The type list is likewise
  // the distinct set, not one entry per sampled row.
  const kinds = candidates.length > 1 ? sameNamedTypes(db, logicalId) : [];
  const total = candidates.length > 1 ? sameNamedCount(db, logicalId) : candidates.length;
  const resolved = await resolveAsset(db, logicalId, load);
  const caveats: Caveat[] =
    candidates.length > 1 && type === undefined
      ? [
          caveat.ambiguousIdentifier(
            logicalId,
            kinds.slice(0, 8),
            total,
            kinds.length,
            // The type actually RESOLVED, not the first candidate. The note and
            // the loader once ordered differently, so `get Plant_Bush` announced
            // "Showing the Item one" and printed the ItemDropList -- handing over
            // the wrong file while naming the right one. Read from the result and
            // that disagreement is not expressible.
            resolved?.type ?? "untyped",
          ),
        ]
      : [];
  if (resolved === null) {
    // Advice that actually works. The old message suggested searching for the
    // string as typed, which for a `Type:Id` guess meant searching for a syntax
    // that does not exist -- circular, and it sent a reader looking for a
    // disambiguation feature under the wrong command.
    let text: string;
    if (type !== undefined && candidates.length > 0) {
      text =
        `No '${logicalId}' of type '${type}'. It exists as: ` +
        `${candidates.map((s) => s.type ?? "untyped").join(", ")}\n`;
    } else if (benchIdExists(db, logicalId)) {
      // `get Farmingbench` sent readers to `search`, which sent them to `refs`,
      // which finally explained it is a value rather than an asset -- three hops
      // that never named the one command built for the question.
      text = `'${logicalId}' is a bench id, not an asset. Use: hytale-atlas bench ${logicalId}\n`;
    } else if (logicalId.includes(":")) {
      const [maybeType, ...rest] = logicalId.split(":");
      text =
        `No asset '${logicalId}'. Identifiers carry no namespace here.\n` +
        `Did you mean: hytale-atlas get ${rest.join(":")} --type ${maybeType}\n`;
    } else {
      text = `No asset '${logicalId}'.\n` + nextCommands(db, logicalId, "search");
    }
    return { value: null, caveats, text };
  }

  if (raw) {
    return { value: resolved, caveats, text: `${JSON.stringify(resolved.effective, null, 2)}\n` };
  }

  const header = [
    `${resolved.logicalId}   type=${resolved.type ?? "(untyped)"}`,
    `  ${resolved.path}`,
  ];
  if (resolved.parentChain.length > 0) {
    header.push(`  inherits: ${resolved.parentChain.join(" <- ")}`);
  }
  if (resolved.missingParent !== null) {
    header.push(`  BROKEN: parent '${resolved.missingParent}' does not exist`);
  }
  if (resolved.truncated) {
    header.push("  WARNING: parent chain is cyclic or deeper than the limit");
  }

  // Both numbers, because the one-sided version was false. `origins` records
  // declared/inherited/merged per pointer and nothing read it, so the line was
  // derived from the inherited count alone and asserted the rest.
  //
  // Counted over the TOP-LEVEL keys, which is the thing the reader can see and
  // check. `origins` records every pointer at every depth, so counting all of
  // them produced a pair reconcilable with nothing on screen: "13 declared in
  // this file, 12 from ancestors" above a document with 19 top-level keys and 40
  // leaves. Two blind trials tried to check those numbers and could not. The unit
  // is stated, and the two sides sum to what is printed below.
  const byOrigin = new Map<string, string>();
  for (const o of resolved.origins) {
    if (o.pointer.split("/").length !== 2) continue; // top level only
    // `merged` is recorded after the recursive call, so it must not overwrite the
    // per-key verdict already stored for the same pointer.
    if (o.via === "merged" && byOrigin.has(o.pointer)) continue;
    byOrigin.set(o.pointer, o.via);
  }
  const inherited = [...byOrigin.values()].filter((v) => v === "inherited").length;
  const merged = [...byOrigin.values()].filter((v) => v === "merged").length;
  const declaredHere = [...byOrigin.values()].filter((v) => v === "declared").length;
  if (byOrigin.size > 0) {
    header.push(
      `  of ${byOrigin.size} top-level field(s): ${declaredHere} declared here, ` +
        `${inherited} inherited whole, ${merged} merged with ` +
        `${resolved.parentChain[0] ?? "the parent"}`,
    );
  }
  return {
    value: resolved,
    caveats,
    text:
      // Caveats BEFORE the document. "Which of the 461 assets am I looking at"
      // has to be read before the content, and appending it put the sentence
      // after a five-hundred-line JSON dump, where nobody reaches it.
      `${header.join("\n")}\n${caveatBlock(caveats)}\n` +
      `${JSON.stringify(resolved.effective, null, 2)}\n`,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface UnionType {
  readonly branches: readonly string[];
  readonly discriminatorProperty: string;
  readonly discriminatorValues: readonly string[];
}

/**
 * The union at a pointer, or null when there is not one.
 *
 * `pointer` defaults to the TYPE row -- `Interaction` is 102 branches and no
 * fields of its own -- but a FIELD can be a union too, and that case had no
 * reader at all: `ScriptedBrushAsset./Operations/*` is 56 shapes chosen by `Id`,
 * `common:SelectInteraction./Selector` is 5, and both came back as a bare
 * `anyOf` with nothing to say what the legal operands were. An agent working
 * through MCP called this the single capability it most needed and reconstructed
 * the taxonomy by full-text searching a boilerplate phrase in the schema's own
 * prose -- an accident, not a route.
 *
 * More than one branch is required. A single-target `$ref` is an ordinary
 * crossing, and reporting it as a union of one produced "one of 1 shapes,
 * chosen by 'Type'" above a row whose discriminator column read `?`.
 */
export function unionOf(db: Database, assetType: string, pointer = ""): UnionType | null {
  const row = db
    .prepare(
      `SELECT ref_scope, discriminator_property, discriminator_values FROM schema_fields
        WHERE asset_type = ? AND json_pointer = ? AND ref_scope IS NOT NULL`,
    )
    .get(assetType, pointer) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const split = (v: unknown): string[] => String(v ?? "").split(" ").filter(Boolean);
  const branches = split(row["ref_scope"]);
  if (branches.length < 2) return null;
  return {
    branches,
    discriminatorProperty: (row["discriminator_property"] as string | null) ?? "Type",
    discriminatorValues: split(row["discriminator_values"]),
  };
}

export interface DescribeRequest {
  readonly assetType: string;
  readonly field?: string;
  readonly limit?: number;
}

export interface DescribeResult {
  /** Non-null when the type is nothing but a union of branches. */
  readonly union: UnionType | null;
  readonly fields: readonly FieldDescription[];
  readonly total: number;
  /** The pointer actually used, after repairing shell mangling. */
  readonly field: string | null;
  /** Set when the caller's pointer was rewritten by their shell. */
  readonly repairedFrom: string | null;
  /** On a miss: the deepest declared prefixes of the pointer that was asked for. */
  readonly nearestDeclared: readonly string[];
  /**
   * On a miss: where the schema tree CONTINUES, when a nearest prefix is a `$ref`.
   *
   * The single most-reported defect of the round, hit by all five agents on five
   * different pointers. `Item./Tool/Specs/*​/Power` -- the example in this tool's
   * own parameter documentation -- answered "'Item' has no field", which is true
   * of a flat pointer table and false about the game: the field is declared, one
   * crossing away, on `common:ItemTool`. The CLI computed this and printed it;
   * nothing carried it, so the served answer was a dead end that read as absence.
   */
  readonly continuesIn: readonly FieldCrossing[];
}

export interface FieldCrossing {
  /** The declared prefix that crosses. */
  readonly pointer: string;
  /** The type it crosses into. */
  readonly into: string;
  /** The pointer to ask for THERE -- the remainder, rebased. */
  readonly continueAt: string;
}

/**
 * Where a pointer's declared prefixes cross into another type.
 *
 * Only unambiguous crossings: a `ref_scope` naming several targets cannot say
 * which one the remainder belongs to, and guessing would be the kind of
 * confident-and-wrong sentence this project keeps removing.
 */
export function fieldCrossings(
  db: Database,
  assetType: string,
  field: string,
  nearest: readonly string[],
): FieldCrossing[] {
  const stmt = db.prepare(
    `SELECT ref_scope FROM schema_fields
      WHERE asset_type = ? AND json_pointer = ? AND ref_scope IS NOT NULL`,
  );
  const hopFrom = (type: string, pointer: string): { at: string; into: string } | null => {
    for (const at of nearestFields(db, type, pointer)) {
      const row = stmt.get(type, at) as { ref_scope: string } | undefined;
      const targets = scopes(row?.ref_scope ?? null);
      if (targets.length === 1) return { at, into: targets[0]! };
    }
    return null;
  };
  const rest = (pointer: string, prefix: string): string =>
    pointer.startsWith(prefix) ? pointer.slice(prefix.length) || "/" : "/";

  const out: FieldCrossing[] = [];
  for (const pointer of nearest) {
    const row = stmt.get(assetType, pointer) as { ref_scope: string } | undefined;
    const targets = scopes(row?.ref_scope ?? null);
    if (targets.length !== 1) continue;

    // FOLLOW THE CHAIN. One hop is not always enough, and stopping after one
    // hands back a command that fails: `Item /Tool/Specs/*/Power` crosses into
    // `common:ItemTool`, which does not declare `/Specs/*/Power` either -- it
    // crosses again, into `ItemToolSpec`, where the field finally lives. The
    // existing test could not see this, because the case it pins happens to
    // resolve in one. What a reader is handed has to answer.
    let into = targets[0]!;
    let continueAt = rest(field, pointer);
    for (let hop = 0; hop < MAX_CROSSING_HOPS; hop++) {
      if (describeSchema(db, into, continueAt).length > 0) break;
      const next = hopFrom(into, continueAt);
      if (next === null) break;
      continueAt = rest(continueAt, next.at);
      into = next.into;
    }
    out.push({ pointer, into, continueAt });
  }
  return out;
}

/** Deep enough for the corpus (the longest observed chain is 2) and bounded. */
const MAX_CROSSING_HOPS = 8;

/**
 * Renders one field row and everything hanging off it.
 *
 * Lives beside the data because every marker here is a CLAIM: `unused` is a
 * statement about this index rather than about the engine, `(container)` says an
 * absence means nothing, and a blind trial went through all nine commands looking
 * for prose defining them and found none. The legend at the foot explains exactly
 * the markers this answer used, so it can only be complete if the rows and the
 * legend are produced together.
 */
function describeField(
  db: Database,
  assetType: string,
  f: FieldDescription,
  single: boolean,
  markers: Set<string>,
): string {
  const d = f.declared;
  const o = f.observed;
  // A container holds no scalar of its own, so it can never appear in the
  // observed layer however heavily it is used. Calling that "unused" was a false
  // claim about the corpus dressed as a finding -- see isContainer().
  const container = isContainer(d?.type ?? null);
  const flags = [
    d?.optional === false ? "required" : null,
    d?.inheritsProperty ? "inherits" : null,
    d?.mergesProperties ? "merges" : null,
    d?.referenceTarget ? `-> ${d.referenceTarget}` : null,
    // 2 064 fields across 724 types declare a default, it was decoded into the
    // row being rendered, and no branch printed it -- while "what happens if I
    // omit this field" is the commonest schema question.
    d?.defaultValue != null ? `default ${clip(d.defaultValue, 40)}` : null,
    d === null ? "UNDECLARED" : null,
    o === null ? (container ? "(container)" : "unused") : null,
  ].filter(Boolean);

  for (const flag of flags) {
    if (typeof flag !== "string") continue;
    // `-> Target` and `default X` carry a value, so the marker recorded is the
    // symbol itself. `->` was excluded as "data, not a marker" and a blind trial
    // had to guess what the arrow meant on a container row.
    if (flag.startsWith("->")) markers.add("->");
    else if (flag.startsWith("default")) markers.add("default");
    else markers.add(flag);
  }
  if (d?.type == null) markers.add("?");

  let out = `${f.pointer.padEnd(46)} ${String(d?.type ?? "?").padEnd(16)} ${flags.join(" ")}\n`;
  if (d?.title) out += `    ${d.title}\n`;
  if (d?.description) {
    // A single-field request is already the narrowed view, so there is nothing to
    // protect the reader from: print all of it.
    out += `    ${single ? d.description.replace(/\s+/g, " ").trim() : clip(d.description, 140)}\n`;
  }

  // Values this field declares a target for that resolve to nothing. The marker
  // existed, was overwritten before it could be used, and no query read the
  // column: `describe BlockType --field HitboxType` printed '-> BlockBoundingBoxes'
  // and 214 distinct values without mentioning that one names nothing, 256 times.
  const broken = brokenRefsFor(db, assetType, f.pointer);
  for (const one of broken.shown) {
    out +=
      `    BROKEN: '${one.value}' names no ${d?.referenceTarget ?? "asset"} ` +
      `(${formatCount(one.occurrences)} occurrence(s))\n`;
  }
  // The list is capped at eight and said so nowhere.
  if (broken.distinct > broken.shown.length) {
    out +=
      `    BROKEN: ${formatCount(broken.shown.length)} of ` +
      `${formatCount(broken.distinct)} unresolved value(s) shown, ` +
      `${formatCount(broken.occurrences)} occurrence(s) in total\n`;
  }

  // Which assets declare it, in the single-field view. "used in 1 assets" with no
  // way to reach that one asset was a dead end on the exact field --help points at
  // for "what makes a tool faster" (common:ItemTool./Speed, used by one asset of
  // 35 074).
  if (single && o !== null && o.assets > 0) {
    const declarers = assetsDeclaringField(db, assetType, f.pointer, 7);
    if (declarers.length > 0) {
      const shown = declarers.slice(0, 6);
      // The TOTAL is counted, not inferred from the observed-value count: a
      // container has no observed values, so `observed.assets` reported zero
      // declarers for fields 67 assets plainly declare.
      const total = countAssetsDeclaringField(db, assetType, f.pointer);
      out +=
        `    declared by: ${shown.map((s) => s.logicalId).join(", ")}` +
        (total > shown.length ? ` ... and ${formatCount(total - shown.length)} more` : "") +
        `\n    e.g. hytale-atlas get ${shown[0]!.logicalId}` +
        (shown[0]!.type ? ` --type ${shown[0]!.type}` : "") +
        `\n`;
    }
  }

  // Where the legal values live, when the field declares a target type.
  if (single && d?.referenceTarget != null) {
    out +=
      `    the values are assets of type ${d.referenceTarget} -- ` +
      `hytale-atlas types ${d.referenceTarget}\n`;
  }
  // Absence of `required` is weak evidence, and silence looked like a fact. The
  // generated schema marks only 2 455 of 18 396 fields required.
  if (single && d !== null && d.optional) {
    out +=
      `    the schema does not mark this required -- and it marks few fields\n` +
      `    either way, so that is not evidence the field is optional\n`;
  }

  // A value link is the only kind of legal-value set JSON Schema cannot express,
  // so `describe` had nothing to say about the very fields whose values are
  // hardest to guess.
  const link = valueLinkFor(db, assetType, f.pointer);
  if (link !== null) {
    out +=
      `    value link '${link.link}': this field ${link.role} the value.\n` +
      `    ${formatCount(link.declared.length)} value(s) are declared: ` +
      `${link.declared.join(", ")}\n` +
      `    declared by ${formatCount(link.declaredByTotal)} asset(s), ` +
      `e.g. ${link.declaredBy.map((d2) => d2.logicalId).join(", ")}\n` +
      (link.unresolved.length > 0
        ? `    referenced but declared nowhere: ${link.unresolved.join(", ")}\n`
        : "");
  }

  // Declared enums are the complete legal set; observed values are only what
  // vanilla happens to use. Labelled differently on purpose.
  if (d?.typeConstant) {
    // A discriminator's own legal set is one value. The union's full list sat here
    // instead, one line under the sentence saying so, and following it selects a
    // different branch of the schema.
    out += `    legal here: "${d.typeConstant}" (this branch only)\n`;
    if (d.enumValues) {
      out +=
        `    the union allows ${d.enumValues.join(", ")} -- each selects a ` +
        `different shape\n`;
    }
  } else if (d?.enumValues) {
    out += `    legal: ${d.enumValues.join(", ")}\n`;
    // ...and which of them vanilla actually uses. Only worth printing when it is
    // narrower than the legal set.
    if (o?.values && o.values.length < d.enumValues.length) {
      out +=
        `    seen:  ${o.values.join(", ")}  (${o.values.length} of ` +
        `${d.enumValues.length} legal values occur in vanilla)\n`;
    }
  } else if (o?.values) {
    // Says how many of how many. The list was cut at 14 in silence, so a field
    // with 21 real bench ids showed 14 of them, ending mid-alphabet.
    const shown = single ? o.values : o.values.slice(0, 14);
    out += `    seen:  ${shown.join(", ")}\n`;
    if (shown.length < o.cardinality) {
      out +=
        `           (${shown.length} of ${formatCount(o.cardinality)} distinct` +
        `${single ? "" : "; use --field for the rest"})\n`;
    }
  }

  if (o) {
    if (o.targetTypes) markers.add("points at");
    out +=
      `    used in ${formatCount(o.assets)} assets` +
      (o.targetTypes ? `, points at ${o.targetTypes.join("/")}` : "") +
      // The JSON type, for a field the schema does not declare. Without a declared
      // row there is no type on the line at all, so 418 observed fields printed a
      // count and left the reader to infer from the sample values.
      (d === null && o.valueTypes ? `, holds ${o.valueTypes.join("/")}` : "") +
      "\n";
    // An UNDECLARED field is named to its sources, because a few of them are not
    // evidence of a capability at all. Asset type comes from the file's PATH, and
    // when a file sits in the wrong directory the mismatch is silent:
    // `Food_EffectCondition_Buff_Medium` lives under an EntityEffect directory
    // while its content is a plain EffectConditionInteraction, so /Match and /Next
    // appeared as EntityEffect capabilities.
    if (d === null && o.assets > 0 && o.assets <= 5) {
      const sources = db
        .prepare(
          `SELECT DISTINCT a.logical_id, a.path FROM candidates c
             JOIN assets a ON a.id = c.asset_id
            WHERE c.schema_scope = ? AND c.schema_pointer = ? LIMIT 3`,
        )
        .all(f.assetType, f.pointer) as unknown as { logical_id: string; path: string }[];
      for (const s of sources) out += `      from ${s.logical_id}  ${s.path}\n`;
    }
    // Above the enum threshold the values are not stored, so the line simply
    // vanished -- no list, no count, no caveat. Two agents independently read the
    // silence as "this field has no values".
    if (o.values === null && o.cardinality > 0 && d?.enumValues == null) {
      out +=
        `    ${formatCount(o.cardinality)} distinct values -- more than this index\n` +
        `    keeps. They are not stored, so --limit cannot show them. To ask the\n` +
        `    reverse question -- which assets name a particular one -- use\n` +
        `    'refs <id>'.\n`;
    }
  } else if (container && single) {
    // A union FIELD gets the same treatment a union TYPE does. `describe
    // ItemDropList --field Container` said only "(container)" and never mentioned
    // that `Type` picks Single or Multiple.
    const branches = db
      .prepare(
        `SELECT ref_scope, discriminator_property, discriminator_values
           FROM schema_fields WHERE asset_type = ? AND json_pointer = ?
            AND ref_scope IS NOT NULL`,
      )
      .get(assetType, f.pointer) as Record<string, unknown> | undefined;
    // A SINGLE-target crossing gets named too. `describe BlockType --field Farming`
    // printed a bare "(container)" and never mentioned common:FarmingData.
    const targets = scopes((branches?.["ref_scope"] as string | null) ?? null);
    if (targets.length === 1) {
      out += `    continues in ${targets[0]} -- hytale-atlas describe ${targets[0]}\n`;
    } else if (targets.length > 1) {
      // Only a real union gets the branch table. Printing it for a single target
      // produced "one of 1 shapes, chosen by 'Type'" above one row whose
      // discriminator column read '?' -- a choice that does not exist.
      const values = String(branches?.["discriminator_values"] ?? "").split(" ").filter(Boolean);
      const property = (branches?.["discriminator_property"] as string | null) ?? "Type";
      out += `    one of ${targets.length} shapes, chosen by '${property}':\n`;
      const width = Math.max(...values.map((v) => v.length), 8);
      for (const [i, target] of targets.entries()) {
        out += `      ${(values[i] ?? "?").padEnd(width)}  ${target}\n`;
      }
    }
    // Absence here means nothing, and saying nothing invited the opposite reading.
    out +=
      "    no observed values: this is a container, and only scalar leaves are\n" +
      "    counted. Absence here says nothing about whether the corpus uses it.\n";
  }
  return out;
}

/**
 * The legend, listing exactly the markers this answer used.
 *
 * `unused` is the load-bearing one: it is a statement about this INDEX, and the
 * bare word was read -- reasonably -- as "the engine ignores this field".
 */
function describeLegend(db: Database, markers: Set<string>): string {
  if (markers.size === 0) return "";
  const one = (sql: string): number =>
    Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
  // Counted over SCALAR declared fields only -- the population that can carry this
  // marker at all. The first version quoted 2 457 of 17 400, borrowed from
  // `undocumented`, where the denominator is the whole declared side. Here that is
  // wrong twice over: 7 959 of those 17 400 are containers, which the legend two
  // lines up says can NEVER appear in the observed layer, so counting them as
  // unmatched inflates the doubt roughly forty-fold. A blind trial discounted a
  // load-bearing `unused` field on the strength of it.
  const SCALAR = `ifnull(declared_type,'') NOT LIKE '%object%'
        AND ifnull(declared_type,'') NOT LIKE '%array%'
        AND ifnull(declared_type,'') NOT LIKE '$ref%'
        AND ifnull(declared_type,'') NOT IN ('anyOf','oneOf')`;
  const joined = markers.has("unused")
    ? one(`SELECT count(*) AS n FROM schema_fields sf
            WHERE sf.json_pointer <> '' AND ${SCALAR}
              AND EXISTS (SELECT 1 FROM field_stats fs
                           WHERE fs.asset_type = sf.asset_type
                             AND fs.json_pointer = sf.json_pointer)`)
    : 0;
  const declaredTotal = markers.has("unused")
    ? one(`SELECT count(*) AS n FROM schema_fields
            WHERE json_pointer <> '' AND ${SCALAR}`)
    : 0;
  const legend: Record<string, string> = {
    required: "the schema marks this field required",
    inherits: "declared with hytale.inheritsProperty: a child takes it from its parent",
    merges: "values of this type combine field by field instead of replacing wholesale",
    UNDECLARED:
      "the corpus uses this field and the schema never declares it -- so there is\n" +
      "               no type, default or legal set to show",
    "(container)":
      "holds other fields, never a value of its own, so it CANNOT appear in the\n" +
      "               observed layer -- absence here says nothing about use",
    unused:
      "no vanilla asset sets it. A statement about this index, not the engine.\n" +
      "               Of the " +
      formatCount(declaredTotal) +
      " declared fields that CAN be observed (containers cannot),\n" +
      "               " +
      formatCount(joined) +
      " are; the rest are either genuinely unused or missed by the join",
    "?": "no declared type, because the schema does not describe this field",
    "->": "the asset TYPE this field declares it points at (hytale.hytaleAssetRef)",
    default: "the value the game uses when the field is absent",
    "points at":
      "types the corpus was OBSERVED to resolve this field to. Where it lists\n" +
      "               more than the declared target, the extras are same-named assets\n" +
      "               of other types -- 'refs' grades those, this line does not",
  };
  let out = "\nmarkers in this answer:\n";
  for (const m of [
    "required",
    "inherits",
    "merges",
    "->",
    "points at",
    "default",
    "?",
    "UNDECLARED",
    "(container)",
    "unused",
  ]) {
    if (markers.has(m) && legend[m] !== undefined) out += `  ${m.padEnd(12)} ${legend[m]}\n`;
  }
  return out;
}

export function describeOp(db: Database, request: DescribeRequest): Result<DescribeResult> {
  // A pure union declares no field of its own, so describing it row by row
  // returns a wall of UNDECLARED observations -- 213 of them for `Interaction`,
  // every one with `declared === null`. The CLI intercepts this and prints the
  // branches; this copy did not, and `unionOf` sat thirty lines above it unused.
  const limit = request.limit ?? 60;
  const field = request.field === undefined ? undefined : normalizeFieldPointer(request.field);
  // A union at the TYPE when no field was asked for, at the FIELD when one was.
  // The field case returned null unconditionally, so the legal operands of a
  // polymorphic field were unreachable through the field that declares them.
  const union = unionOf(db, request.assetType, field ?? "");
  const caveats: Caveat[] = [];

  const all = describeSchema(db, request.assetType, field);
  const fields = all.slice(0, limit);
  if (all.length > limit) caveats.push(caveat.truncated(fields.length, "fields"));

  // A union declares nothing of its own, and the zero says so nowhere. For
  // `Interaction` -- 1 341 assets -- the payload read `declaredFieldCount: 0`
  // beside 213 observed-only rows, which states that the game declares nothing
  // about interactions. It declares a great deal, in the 102 branches, and this
  // is the line that points at them.
  if (union !== null) {
    caveats.push({
      code: "container-no-observations",
      message:
        `This is a union of ${union.branches.length} shapes, chosen by ` +
        `'${union.discriminatorProperty}'. It declares no field of its own -- the ` +
        `declarations live on the branches, so describe one of them ` +
        `(e.g. '${union.branches[0]}') rather than reading this as "nothing is declared".`,
    });
  }
  if (fields.some((f) => f.observed !== null)) caveats.push(caveat.preInheritance());
  for (const f of fields) {
    if (f.observed === null && isContainer(f.declared?.type ?? null) && field !== undefined) {
      caveats.push(caveat.containerNoObservations());
    } else if (
      f.observed !== null &&
      f.observed.values === null &&
      f.observed.cardinality > 0 &&
      f.declared?.enumValues == null
    ) {
      caveats.push(caveat.cardinalityElided(f.observed.cardinality));
    }
  }

  // Computed HERE, on the miss, so both front ends have it. The CLI grew its own
  // copy of this query and the served answer had none, which is how the same
  // question got a route out on one surface and a flat denial on the other.
  const nearestDeclared =
    all.length === 0 && field !== undefined ? nearestFields(db, request.assetType, field) : [];
  const continuesIn =
    nearestDeclared.length === 0
      ? []
      : fieldCrossings(db, request.assetType, field!, nearestDeclared);
  for (const c of continuesIn) caveats.push(caveat.crossesInto(c.pointer, c.into, c.continueAt));
  if (request.field !== undefined && looksMangled(request.field) && field !== undefined) {
    caveats.unshift(caveat.pointerRepaired(request.field, field));
  }

  const value = {
    fields,
    union,
    total: all.length,
    field: field ?? null,
    repairedFrom:
      request.field !== undefined && looksMangled(request.field) ? request.field : null,
    nearestDeclared,
    continuesIn,
  };
  const type = request.assetType;

  // A type that is nothing but a union of branches has no fields of its own, so
  // describing it row by row printed a wall of `UNDECLARED` observed-only rows --
  // while `describe common:ApplyEffectInteraction` showed the same fields fully
  // declared. Two commands contradicting each other.
  if (union !== null && field === undefined) {
    const values = union.discriminatorValues;
    const width = Math.max(...values.map((v: string) => v.length), 8);
    return rendered(
      value,
      `'${type}' is a union of ${union.branches.length} shapes, chosen by the ` +
        `'${union.discriminatorProperty}' field.\nIt declares no field of its own -- ` +
        `describe a branch to see fields.\n\n` +
        union.branches
          .map((b, i) => `${(values[i] ?? "?").padEnd(width)}  hytale-atlas describe ${b}\n`)
          .join("") +
        `\nThose ${values.length} values are the complete legal set for ` +
        `'${union.discriminatorProperty}' here: the schema declares them, they are ` +
        `not inferred from the corpus.\n`,
      caveats,
    );
  }

  if (fields.length === 0) {
    // Order matters. Checking the type first reported a missing FIELD as a
    // missing TYPE, producing "No type 'Item'. Did you mean: describe Item" -- a
    // suggestion identical to what had just been typed.
    if (typeExists(db, type) && field !== undefined) {
      // A union declares no field of its own, so sending the reader to
      // `describe X` "to list its fields" lands them on 102 branches and no
      // fields at all. Name what they will actually get.
      // The union AT THE TYPE, not at the field. `union` above is resolved at the
      // pointer that was asked for, and on a miss there is no such pointer -- so
      // it is null exactly when this sentence is needed, and the fallback promised
      // a field list for `Interaction`, which declares none.
      const typeUnion = unionOf(db, type, "");
      const fallback =
        typeUnion !== null
          ? `'${type}' is a union: its fields live on the branches, not on it.\n` +
            `Run 'hytale-atlas describe ${type}' to list the branches, then describe one.\n`
          : `Run 'hytale-atlas describe ${type}' to list its fields.\n`;
      return rendered(
        value,
        `'${type}' has no field '${field}'.\n` +
          (nearestDeclared.length > 0
            ? `Nearest declared:\n` +
              nearestDeclared.map((p) => `  ${p}\n`).join("") +
              continuesIn
                .map(
                  (c) =>
                    `  ${c.pointer} continues in ${c.into} -- ` +
                    `hytale-atlas describe ${c.into} --field ${c.continueAt}\n`,
                )
                .join("")
            : fallback),
        caveats,
      );
    }

    // A type with assets but no declared fields is a real type the schema is
    // silent about, not a typo. Saying "No type" sent readers looking for a
    // spelling mistake that does not exist.
    const carried = assetsOfType(db, type);
    if (carried > 0) {
      return rendered(
        value,
        `'${type}' is a real asset type -- ${formatCount(carried)} assets carry ` +
          `it -- but the generated schema declares no fields for it, so there is\n` +
          `nothing to describe. Its contents are reachable per asset: ` +
          `hytale-atlas get <id> --type ${type}\n`,
        caveats,
      );
    }
    // Shared definitions live in a namespace, and which types need one is not
    // guessable: ItemToolSpec and CraftingRecipe do not, ItemTool and
    // BenchRequirement do. Suggestions go both ways, because both mistakes happen.
    const alternatives = typeAlternatives(db, type);
    return rendered(
      value,
      alternatives.length > 0
        ? `No type '${type}'. Did you mean:\n` +
          alternatives
            .map((a) => `  hytale-atlas describe ${a}${field ? ` --field ${field}` : ""}\n`)
            .join("")
        : `No type '${type}'. Try: hytale-atlas search-schema "${type}"\n`,
      caveats,
    );
  }

  const markers = new Set<string>();
  const rows = fields
    .map((f) => describeField(db, type, f, field !== undefined, markers))
    .join("");

  return rendered(
    value,
    rows +
      (all.length > limit
        ? `\n... showing ${limit} of ${formatCount(all.length)} fields. ` +
          `Use --limit ${all.length} for all, or --field <pointer> for one.\n`
        : "") +
      // The observed layer counts what files LITERALLY contain. `get` resolves the
      // parent chain first, so a field every crop appears to set can show two
      // occurrences here -- and an agent reasonably read that as this command
      // being wrong.
      (fields.some((f) => f.observed !== null)
        ? "\n'used in N assets' counts files that declare the field themselves.\n" +
          "'get' resolves inheritance first, so it can show a value on assets that\n" +
          "are not counted here.\n" +
          // A shape can be embedded in a file of another type, so the count is not
          // a count of assets OF this type: `EntityEffect./Duration` reports 146
          // while `types EntityEffect` lists 140, because 19 are inline literals
          // inside Items. Both numbers were right and the pair read as a plain
          // contradiction.
          "A file of any type counts if it carries this shape, inline or as its\n" +
          "own asset -- so this can exceed the number of assets OF this type.\n"
        : "") +
      describeLegend(db, markers) +
      caveatBlock(caveats),
    caveats,
  );
}

/** Nearest declared pointers, walking up from a miss. */
export function nearestFields(db: Database, assetType: string, field: string): string[] {
  let probe = field;
  while (probe.length > 1) {
    const near = pointersLike(db, assetType, probe);
    if (near.length > 0) return near;
    probe = probe.slice(0, probe.lastIndexOf("/")) || "/";
  }
  return [];
}

/**
 * Namespaced or bare spellings of a type that do exist, then near misses.
 *
 * Exact respelling alone was not enough. Two rounds of blind trials ended with
 * an agent asking for `common:FarmingBlock` and `common:Shape`; neither exists,
 * and each is one word away from one that does (`common:FarmingData`,
 * `common:ConnectedBlockShape`). Those misses fell through to a `search-schema`
 * suggestion, which searches field text and finds nothing for a type name
 * nobody ever wrote -- so the reader concluded the type was undocumented.
 */
export function typeAlternatives(db: Database, assetType: string): string[] {
  const bare = assetType.includes(":") ? assetType.slice(assetType.indexOf(":") + 1) : null;
  const exact = (
    db
      .prepare(
        `SELECT DISTINCT asset_type FROM schema_fields
          WHERE asset_type LIKE '%:' || ?1 OR asset_type = ?2
          ORDER BY asset_type LIMIT 5`,
      )
      .all(assetType, bare ?? " -no-such-type") as unknown as { asset_type: string }[]
  ).map((r) => r.asset_type);
  if (exact.length > 0) return exact;

  // Split the request into CamelCase words and rank every declared type by how
  // many it shares. Words shorter than three letters are dropped: 'Id' and 'To'
  // match most of the corpus and would rank noise above the real neighbour.
  const words = (bare ?? assetType)
    .match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g)
    ?.filter((w) => w.length >= 3);
  if (words === undefined || words.length === 0) return [];
  const lower = words.map((w) => w.toLowerCase());
  return (
    db.prepare("SELECT DISTINCT asset_type FROM schema_fields").all() as unknown as {
      asset_type: string;
    }[]
  )
    .map((r) => {
      const name = r.asset_type.slice(r.asset_type.indexOf(":") + 1).toLowerCase();
      const hit = lower.filter((w) => name.includes(w));
      // Coverage, not word count alone: for 'FarmingBlock' every Block* type
      // scores one word, and ordering those by name length put BlockSet and
      // BlockGroup above common:FarmingData, which is the answer. Measuring how
      // much of the candidate the match accounts for ranks it back up.
      return {
        type: r.asset_type,
        score: hit.length,
        coverage: hit.reduce((n, w) => n + w.length, 0) / Math.max(name.length, 1),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.type.length - b.type.length)
    .slice(0, 5)
    .map((c) => c.type);
}

export interface BrokenRef {
  readonly value: string;
  readonly occurrences: number;
}

export interface BrokenRefs {
  readonly shown: readonly BrokenRef[];
  /** Distinct broken values, before the display cap. */
  readonly distinct: number;
  /** Occurrences across all of them, shown or not. */
  readonly occurrences: number;
}

/**
 * Values on a field that declares a reference target and resolve to nothing.
 *
 * 2 674 occurrences corpus-wide: `Item./Categories/*` names 38 ItemCategory ids
 * that do not exist, 2 175 times; `BlockType./HitboxType` names a
 * BlockBoundingBoxes called 'Full' 256 times. The marker for these was computed
 * and then overwritten by the generic dangling pass, and nothing read the
 * column in any case. These are the findings `validate` will report.
 */
export function brokenRefsFor(
  db: Database,
  assetType: string,
  pointer: string,
  limit = 8,
): BrokenRefs {
  const shown = db
    .prepare(
      `SELECT raw_value AS value, count(*) AS occurrences
         FROM candidates
        WHERE dangling = 2 AND schema_scope = ? AND schema_pointer = ?
        GROUP BY raw_value ORDER BY occurrences DESC, raw_value LIMIT ?`,
    )
    .all(assetType, pointer, limit) as unknown as BrokenRef[];

  // The cap announces itself, like every other one in this file.
  // `common:BlockTypeFarmingStageData./Block` names 63 BlockTypes that do not
  // exist and printed the first eight, in alphabetical order, with nothing to
  // say the list ended early -- the shape of finding this project keeps
  // rediscovering as "a truncated list that does not say so reads as complete".
  return {
    shown,
    distinct: count(
      db,
      `SELECT count(*) AS n FROM (SELECT 1 FROM candidates
         WHERE dangling = 2 AND schema_scope = ? AND schema_pointer = ? GROUP BY raw_value)`,
      assetType,
      pointer,
    ),
    occurrences: count(
      db,
      `SELECT count(*) AS n FROM candidates
        WHERE dangling = 2 AND schema_scope = ? AND schema_pointer = ?`,
      assetType,
      pointer,
    ),
  };
}

export interface FieldDeclarer {
  readonly logicalId: string;
  readonly type: string | null;
  readonly pointer: string;
}

/**
 * The assets that actually declare a field, with a real document position.
 *
 * `describe` could say a field is "used in 1 assets" and offer no way to find
 * which one. `common:ItemTool./Speed` is exactly that — one asset in 35 074, and
 * `--help` steers readers to this very command for the question "what makes a
 * tool faster". `refs` covers VALUES and value links name their declarers, so a
 * plain scalar field was the one shape with no route from the field to an
 * example of it.
 *
 * Ordered by identifier so the sample is stable between runs, and over-fetched
 * by one so the caller can say there are more.
 */
export function assetsDeclaringField(
  db: Database,
  scope: string,
  pointer: string,
  limit = 6,
): FieldDeclarer[] {
  return db
    .prepare(
      `SELECT DISTINCT a.logical_id AS logicalId, a.type, min(c.json_pointer) AS pointer
         FROM candidates c JOIN assets a ON a.id = c.asset_id
        WHERE c.schema_scope = ? AND c.schema_pointer = ?
        GROUP BY a.logical_id, a.type
        ORDER BY a.logical_id LIMIT ?`,
    )
    .all(scope, pointer, limit) as unknown as FieldDeclarer[];
}

/**
 * How many assets declare a field -- the total the sample above is a sample OF.
 *
 * Counted from `candidates`, the same table the sample reads, because the
 * obvious substitute is wrong: `observed.assets` counts assets with an observed
 * VALUE, and a container has none. `EntityEffect./StatModifiers` was served as
 * "declared by 0 assets" beside its own child counted in 67, which reconciles
 * with nothing.
 */
export function countAssetsDeclaringField(db: Database, scope: string, pointer: string): number {
  return count(
    db,
    `SELECT count(DISTINCT a.logical_id || char(31) || coalesce(a.type, '')) AS n
       FROM candidates c JOIN assets a ON a.id = c.asset_id
      WHERE c.schema_scope = ? AND c.schema_pointer = ?`,
    scope,
    pointer,
  );
}

/**
 * Every asset carrying a type, so a legal-value set can be enumerated.
 *
 * `describe BlockType --field /BlockSoundSetId` reports 48 distinct values and
 * cannot list them (the storage ceiling is 40), then suggests `refs <id>` --
 * which needs the id the reader is trying to find. There was no command that
 * answers "what are the BlockSoundSets", and the only route was a query that
 * happens to match everything, which relies on tokenizer behaviour nobody
 * promised.
 */
export function assetsOfTypeList(
  db: Database,
  assetType: string,
  limit = 200,
): { logicalId: string; path: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT logical_id AS logicalId, min(path) AS path FROM assets
        WHERE type = ? GROUP BY logical_id ORDER BY logical_id LIMIT ?`,
    )
    .all(assetType, limit) as unknown as { logicalId: string; path: string }[];
}

export function typeExists(db: Database, assetType: string): boolean {
  return count(db, "SELECT count(*) AS n FROM schema_fields WHERE asset_type = ?", assetType) > 0;
}

/**
 * How many assets carry a type, whatever the schema knows about it.
 *
 * Existence was tested against `schema_fields` alone, so `describe NPCRole`
 * answered "No type 'NPCRole'" about a type 975 assets carry and `search`
 * prints in its own TYPE column -- then suggested `other:NPC:Role`, a
 * different concept. The generated schema simply declares no fields for it,
 * and all 44 938 of its candidates are unaligned, so `field_stats` is empty
 * too. 'The schema says nothing about this type' and 'this type does not
 * exist' are different answers and the reader needs the first one.
 */
export function assetsOfType(db: Database, assetType: string): number {
  return count(db, "SELECT count(*) AS n FROM assets WHERE type = ?", assetType);
}

export function searchSchemaOp(db: Database, query: string, limit = 20) {
  const detailed = searchSchemaDetailed(db, query, limit + 1);
  const hits = detailed.hits.slice(0, limit);
  const caveats: Caveat[] = [];
  if (detailed.hits.length > limit) caveats.push(caveat.truncated(hits.length, "fields"));
  if (detailed.relaxation > 0 || detailed.widened) {
    caveats.push(caveat.relaxed(query, detailed.relaxation, detailed.widened));
  }
  // On a loosened match too, not only on an empty one. A loosened result IS a
  // miss by its own first sentence ("nothing matched as written"), and it is the
  // branch where a wrong conclusion is likeliest: `search-schema "mining speed"`
  // returned seven NPC walk-speed fields and no hedge, reading as "the game has
  // no mining-speed field" -- while `search-schema "tool power"` finds it.
  // `--help` promises the caveat for a miss unconditionally.
  if (hits.length === 0 || detailed.relaxation > 0 || detailed.widened) {
    caveats.push(caveat.lexicalOnly());
  }

  if (hits.length === 0) {
    return rendered(
      hits,
      `No schema field matches "${query}".\n` +
        caveatBlock(caveats) +
        "\nBefore concluding it does not exist:\n" +
        "  - try the words the game might use instead (Radius, Shape, Extent)\n" +
        "  - list the types that would own it: describe <Type> --limit 200\n" +
        "  - check for declared-but-unused fields: undocumented <Type>\n",
      caveats,
    );
  }
  // A loosened match is a different kind of answer and must not look like an
  // exact one, so its caveat is printed BEFORE the rows rather than after.
  const loosened = caveats.filter((c) => c.code === "relaxed");
  const rest = caveats.filter((c) => c.code !== "relaxed");
  return rendered(
    hits,
    (loosened.length > 0 ? `${loosened.map((c) => c.message).join("\n")}\n\n` : "") +
      hits
        .map(
          (h) =>
            `${(h.assetType + h.pointer).padEnd(56)} ${h.title ?? ""}\n` +
            (h.description ? `    ${clip(h.description, 130)}\n` : ""),
        )
        .join("") +
      caveatBlock(rest),
    caveats,
  );
}

export function undocumentedOp(db: Database, type: string | undefined, limit = 40) {
  const found = findUndocumented(db, type, limit + 1);
  // The unlimited total. This command's own docstring records the original
  // defect as '40 rows out of 6 324 in silence'; the silence became the word
  // 'more' and never became a number.
  const total = findUndocumented(db, type, Number.MAX_SAFE_INTEGER).length;
  const fields = found.slice(0, limit);
  const declared = type === undefined ? 0 : declaredCount(db, type);

  // Containers are NOT in this list, and that had to become a sentence.
  //
  // The exclusion is deliberate and defensible: this index observes scalar
  // leaves, and 7 538 of 7 959 declared container fields have no evidence in
  // either direction, so listing them would bury the real leads under eight
  // thousand unknowns. The defect was the SILENCE. An agent looking for an
  // area-mining primitive found `common:SelectInteraction./HitBlock` -- declared,
  // used by no vanilla asset, exactly what this command promises -- absent with
  // nothing to say why, while the tool description says "fields the schema
  // declares that appear in zero vanilla assets".
  const containers = count(
    db,
    `SELECT count(*) AS n FROM schema_fields sf
      WHERE sf.json_pointer <> ''
        AND (ifnull(sf.declared_type,'') LIKE '%object%'
          OR ifnull(sf.declared_type,'') LIKE '%array%'
          OR ifnull(sf.declared_type,'') LIKE '$ref%'
          OR ifnull(sf.declared_type,'') IN ('anyOf','oneOf'))
        ${type === undefined ? "" : "AND sf.asset_type = ?"}`,
    ...(type === undefined ? [] : [type]),
  );

  const caveats: Caveat[] = [
    caveat.joinIncomplete(
      count(
        db,
        `SELECT count(*) AS n FROM field_stats fs JOIN schema_fields sf
           ON sf.asset_type = fs.asset_type AND sf.json_pointer = fs.json_pointer`,
      ),
      count(db, "SELECT count(*) AS n FROM schema_fields WHERE json_pointer <> ''"),
      "declared",
    ),
  ];
  if (containers > 0) {
    caveats.push({
      code: "container-no-observations",
      message:
        `${containers} declared field(s) here are containers and are NOT in this list: ` +
        `this index observes scalar leaves, so a container's use can be neither ` +
        `confirmed nor denied. Ask about one directly with describe <Type> ` +
        `--field <pointer>, which reports the assets that declare it.`,
    });
  }
  if (found.length > limit) caveats.push(caveat.truncated(fields.length, "fields", total));

  const header =
    `Fields the schema permits that appear in zero vanilla assets` +
    `${type ? `, scoped to ${type}` : ""}.\n` +
    "These are leads, not features: a field may be deprecated, engine-internal,\n" +
    "set programmatically rather than from JSON, or a debug hook.\n" +
    // Beside the heading, not only in the caveat block at the foot. The heading
    // states a negative and this is what weakens it; a reader who acts on the
    // first two lines has already drawn the conclusion by the time they reach the
    // bottom of a forty-row list.
    `AND it may simply have failed to join:\n${caveats
      .filter((c) => c.code === "join-incomplete")
      .map((c) => `  ${c.message}`)
      .join("\n")}\n` +
    "Treat this list as a starting point and confirm with\n" +
    "'describe <Type> --field <pointer>'.\n";
  const body =
    fields.length === 0
      ? "None across the whole schema.\n"
      : fields
          .map(
            (f) =>
              `${(f.assetType + f.pointer).padEnd(56)} ${f.declaredType ?? ""}` +
              `${f.referenceTarget ? ` -> ${f.referenceTarget}` : ""}\n` +
              (f.description ? `    ${clip(f.description, 130)}\n` : ""),
          )
          .join("");
  return rendered(
    { fields, total, declared, containersExcluded: containers },
    `${header}\n${body}${caveatBlock(caveats)}`,
    caveats,
  );
}

export function declaredCount(db: Database, assetType: string): number {
  // Excludes the empty-pointer TYPE row, the same way describe does. They
  // disagreed by exactly one for every type that has one -- describe listing 8
  // fields under a header saying 9 were declared.
  return count(
    db,
    "SELECT count(*) AS n FROM schema_fields WHERE asset_type = ? AND json_pointer <> ''",
    assetType,
  );
}

export interface AssetTypeInfo {
  readonly type: string;
  readonly assets: number;
  readonly declaredFields: number;
  /** Where files of this type live inside the archive. */
  readonly path: string | null;
}

/**
 * Every asset type the game declares.
 *
 * `asset_types` holds 102 rows and had no reader anywhere in the project, so
 * no command could list the types -- while `describe` and `undocumented` both
 * require you to already know the name, and `search-schema` searches field
 * prose rather than the type list. Every blind trial asked for this.
 */
/**
 * `types`, both of its questions, rendered.
 *
 * The first operation to carry its own `text`. The CLI writes it and the MCP
 * server returns it, so the two cannot describe the same corpus differently --
 * which they did until now: the CLI printed a footnote about `common:`
 * definitions not being asset types, and MCP omitted it, so an agent reported
 * "types claims 'Every asset type' and silently omits an entire namespace".
 */
export function typesOp(
  db: Database,
  request: { type?: string; limit?: number } = {},
): Result<
  | { kind: "types"; types: readonly AssetTypeInfo[]; total: number }
  | { kind: "assets"; type: string; assets: readonly { logicalId: string; path: string }[]; total: number }
  | { kind: "miss"; type: string; reason: string }
> {
  const limit = request.limit ?? 200;

  if (request.type !== undefined) {
    const type = request.type;
    const carried = assetsOfType(db, type);
    if (carried === 0) {
      const declared = typeExists(db, type);
      const reason = declared
        ? `The schema declares this type but no vanilla asset carries it.`
        : `No such type. Run 'hytale-atlas types' for the list.`;
      return rendered(
        { kind: "miss" as const, type, reason },
        `No assets of type '${type}'.\n${reason}\n`,
      );
    }
    const fetched = assetsOfTypeList(db, type, limit + 1);
    const shown = fetched.slice(0, limit);
    const capped = fetched.length > limit;
    return rendered(
      { kind: "assets" as const, type, assets: shown, total: carried },
      `${formatCount(carried)} asset(s) of type '${type}':\n\n` +
        shown.map((r) => `${r.logicalId.padEnd(44)} ${r.path}\n`).join("") +
        (capped ? truncationLine(shown.length, "assets", carried) : ""),
      capped ? [caveat.truncated(shown.length, "assets", carried)] : [],
    );
  }

  const all = assetTypesOp(db).value;
  const shown = all.slice(0, limit);
  return rendered(
    { kind: "types" as const, types: shown, total: all.length },
    `${"TYPE".padEnd(34)} ${"ASSETS".padStart(7)} ${"FIELDS".padStart(7)}  WHERE\n\n` +
      shown
        .map(
          (r) =>
            `${r.type.padEnd(34)} ${formatCount(r.assets).padStart(7)} ` +
            `${formatCount(r.declaredFields).padStart(7)}  ${r.path ?? ""}\n`,
        )
        .join("") +
      (all.length > limit ? truncationLine(shown.length, "types", all.length) : "") +
      `\nFIELDS 0 means the generated schema declares nothing for that type, not ` +
      `that it is empty.\nShared definitions ('common:...') are not asset types ` +
      `and are not listed; describe accepts them.\n`,
    all.length > limit ? [caveat.truncated(shown.length, "types", all.length)] : [],
  );
}

export function assetTypesOp(db: Database): Result<AssetTypeInfo[]> {
  const rows = db
    .prepare(
      // `lo`/`hi` are the lexicographic extremes of this type's real paths; the
      // prefix they share is the prefix every path shares, which is what the
      // column claims to be. Taken from the corpus rather than from
      // `hytale.path`, which is pack-root-relative (`Item/Items`) while every
      // path printed elsewhere carries the root
      // (`Server/Item/Items/Tool/Pickaxe/...`), so a mod author reading this as
      // "where its files live" creates the file one level too high.
      `SELECT t.id AS type, t.schema_path AS declaredPath,
              (SELECT min(a.path) FROM assets a WHERE a.type = t.id) AS lo,
              (SELECT max(a.path) FROM assets a WHERE a.type = t.id) AS hi,
              (SELECT count(*) FROM assets a WHERE a.type = t.id) AS assets,
              (SELECT count(*) FROM schema_fields sf
                WHERE sf.asset_type = t.id AND sf.json_pointer <> '') AS declaredFields
         FROM asset_types t
        ORDER BY assets DESC, t.id`,
    )
    .all() as unknown as (Omit<AssetTypeInfo, "path"> & {
    declaredPath: string | null;
    lo: string | null;
    hi: string | null;
  })[];

  /** The directory prefix two paths share, cut at a slash. */
  const sharedDirectory = (a: string, b: string): string => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const cut = a.lastIndexOf("/", i);
    return cut < 0 ? "" : a.slice(0, cut + 1);
  };

  return ok(
    rows.map(({ declaredPath, lo, hi, ...rest }) => ({
      ...rest,
      path:
        lo === null || hi === null
          ? declaredPath
          : (sharedDirectory(lo, hi) || declaredPath),
    })),
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface Reference {
  readonly logicalId: string;
  readonly type: string | null;
  readonly kind: string;
  readonly pointer: string | null;
  readonly confidence: string;
}

export function refsOp(
  db: Database,
  logicalId: string,
  type: string | undefined,
  limit = 40,
): Result<{
  references: Reference[];
  total: number;
  /** Row ids carried through: callers need them to ask what the edges did NOT cover. */
  targets: (AssetCandidate & { id: number })[];
}> {
  const targets = db
    .prepare("SELECT id, type, path FROM assets WHERE logical_id = ?1 AND (?2 IS NULL OR type = ?2)")
    .all(logicalId, type ?? null) as unknown as ({ id: number } & AssetCandidate)[];

  if (targets.length === 0) return ok({ references: [], total: 0, targets: [] });

  const ids = targets.map((t) => t.id);
  const holes = ids.map(() => "?").join(",");

  /**
   * Drops edges the schema contradicts.
   *
   * Heuristic edges are built to EVERY asset sharing a name, so
   * `Alchemy_Cauldron_Big`'s `PhysicalMaterialId: "Stone"` produced four edges --
   * one per Stone. Only the one matching the declared target became `high`; the
   * other three stayed `medium` in buckets they have nothing to do with. Scoping
   * to a type therefore did not narrow: the four type-scoped totals summed to
   * 5 087 against an unscoped 2 262, while the footer claimed the opposite had
   * happened.
   *
   * Filtered here rather than at index time because the index-time forms -- a
   * correlated DELETE, then a temp table -- took the build from 42 seconds past
   * six minutes without finishing.
   */
  // Parameterised by alias because it has to be applied to BOTH sides of the
  // overlap test below. Applying it only to the outer edge counted an edge as
  // 'shared' with a sibling target that the same filter had already dropped:
  // `refs Stone --type PhysicalMaterial` claimed 644 of 644 where 285 overlap,
  // and `refs Burn --type EntityEffect` claimed 7 of 7 against an observable 3.
  // A wrong number attached to a correct warning is worse than no warning.
  const contradictedFor = (edge: string): string => `NOT EXISTS (
    SELECT 1 FROM candidates c
      JOIN schema_fields sf
            ON sf.asset_type = c.schema_scope
           AND sf.json_pointer = c.schema_pointer
           AND sf.reference_target IS NOT NULL
     WHERE c.asset_id = ${edge}.src AND c.json_pointer = ${edge}.json_pointer
       AND sf.reference_target <> (SELECT type FROM assets WHERE id = ${edge}.dst)
       -- The right answer must exist UNDER THIS NAME. Requiring only that the
       -- declared type exist somewhere deleted Seed_Place -> Rock_Stone:
       -- BlockTypeToPlace declares '-> BlockType', exactly one asset of 35 074
       -- carries that type, and no Rock_Stone does -- so the declaration cannot
       -- be discharged and the name match is still the best evidence there is.
       AND EXISTS (SELECT 1 FROM assets t
                    WHERE t.logical_id = (SELECT logical_id FROM assets WHERE id = ${edge}.dst)
                      AND t.type = sf.reference_target))`;
  const contradicted = contradictedFor("e");
  // DISTINCT across targets. Four assets are named Rock_Stone; a world-gen entry
  // naming that string produces an edge to each, so the unfiltered list counted
  // 303 references where 162 exist -- the Item view plus the ResourceType view,
  // concatenated, 141 rows appearing in both. Internally consistent with the rows
  // printed, and answering a subtly different question than the reader asked.
  const rows = db
    .prepare(
      `SELECT DISTINCT s.logical_id, s.type, e.kind, e.json_pointer, e.confidence
         FROM edges e JOIN assets s ON s.id = e.src
        WHERE e.dst_kind = 'asset' AND e.dst IN (${holes}) AND ${contradicted}
        ORDER BY CASE e.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 s.logical_id
        LIMIT ?`,
    )
    .all(...ids, limit + 1) as unknown as {
    logical_id: string;
    type: string | null;
    kind: string;
    json_pointer: string | null;
    confidence: string;
  }[];

  const references = rows.slice(0, limit).map((r) => ({
    logicalId: r.logical_id,
    type: r.type,
    kind: r.kind,
    pointer: r.json_pointer,
    confidence: r.confidence,
  }));

  const total = count(
    db,
    // Counted over the SAME projection the list uses. The rows collapse two
    // same-named sources into one and the total kept them apart, so
    // `refs Adventure` announced 96 above 85 printed rows -- with no truncation
    // notice, because nothing had been truncated. 95 identifiers were affected.
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT s.logical_id, s.type, e.kind, e.json_pointer, e.confidence
         FROM edges e JOIN assets s ON s.id = e.src
        WHERE e.dst_kind = 'asset' AND e.dst IN (${holes}) AND ${contradicted})`,
    ...ids,
  );

  const caveats: Caveat[] = [
    caveat.untypedBlindSpot(count(db, "SELECT count(*) AS n FROM assets WHERE type IS NULL")),
    // Edges are built from files as written, so an asset that INHERITS a
    // reference is not among them: `refs Drops_Plant_Crop_Carrot_Stage1` lists
    // the two files that name it and not `Plant_Crop_Apple_Block`, whose
    // effective definition -- printed by `get` -- also points there. Both
    // answers are right about different questions, and `--help` calls this one
    // "the inverse of get", which is the reading that makes the pair look like
    // a missing edge. `describe` has carried this caveat all along.
    caveat.preInheritance(),
  ];
  if (rows.length > limit) caveats.push(caveat.truncated(references.length, "references"));
  if (targets.length > 1 && type === undefined) {
    // Distinct types, capped -- not one entry per asset. `targets` is every row
    // sharing the identifier, so `refs Entry.node` rendered the word "untyped"
    // 461 times inside a single sentence. `getAssetOp` already passes a sample
    // plus a separate total; this site passed the whole list as if it were the
    // sample.
    const kinds = [...new Set(targets.map((t) => t.type ?? "untyped"))];
    caveats.push(
      caveat.ambiguousIdentifier(logicalId, kinds.slice(0, 8), targets.length, kinds.length),
    );
  } else if (type !== undefined) {
    // Naming what was excluded. Scoping to one type legitimately changes the edge
    // set -- a BlockSet inheriting from the BlockSet named Stone has no bearing on
    // the PhysicalMaterial of the same name -- but the totals then vary between
    // runs with nothing to explain why, which reads as edges being dropped.
    const others = (
      db
        .prepare("SELECT DISTINCT type FROM assets WHERE logical_id = ? AND type IS NOT ?")
        .all(logicalId, type) as unknown as { type: string | null }[]
    ).map((r) => r.type ?? "untyped");
    if (others.length > 0) {
      // How many of these edges are shared with a same-named asset of another
      // type -- i.e. come from a field that never declared what it points at,
      // so the name alone cannot choose between them.
      //
      // This is why scoped totals can still sum to more than the unscoped one:
      // 'Stone' names four assets, and a field with no declared target produces
      // an edge to each. The previous wording claimed the opposite -- that
      // scoping only excludes -- which made the arithmetic look like a bug in
      // the tool rather than ambiguity in the data.
      const shared = count(
        db,
        `SELECT count(*) AS n FROM (
           SELECT DISTINCT e.src, e.json_pointer, e.kind FROM edges e
            WHERE e.dst_kind = 'asset' AND e.dst IN (${holes}) AND ${contradicted}
              AND EXISTS (SELECT 1 FROM edges e2 JOIN assets d2 ON d2.id = e2.dst
                           WHERE e2.dst_kind = 'asset' AND e2.src = e.src
                             AND e2.json_pointer IS e.json_pointer
                             AND d2.logical_id = ?
                             AND e2.dst NOT IN (${holes})
                             AND ${contradictedFor("e2")}))`,
        ...ids,
        logicalId,
        ...ids,
      );
      caveats.push({
        code: "ambiguous-identifier",
        message:
          `Scoped to '${type}'. ${others.length} other asset(s) share this name ` +
          `(${others.join(", ")}).` +
          (shared > 0
            ? ` ${shared} of these ${total} references also point at one of those: the` +
              ` field does not declare which type it means, so the same source` +
              ` line appears under each. Type-scoped totals therefore overlap and` +
              ` can sum to more than the unscoped total.`
            : ` References to those are excluded, so this total is a subset of the` +
              ` unscoped one.`),
      });
    }
  }

  return ok(
    {
      references,
      total,
      targets,
    },
    caveats,
  );
}

/**
 * Everything a bare string turns out to be, asked once.
 *
 * Every command grew its own answer to "what did the user just type", each from
 * a different single fact, and the disagreements were the most-reported class in
 * the blind trials:
 *
 * - `search <miss>` prints "to find what uses a value, ask for references to it
 *   instead" and then offers `refs` **only when the string IS an asset** -- the
 *   exact inverse of the sentence above it. Three agents followed the printed
 *   advice into `search-schema`, which answers a different question, and one
 *   nearly filed a capability gap because the value's sole vanilla use was
 *   sitting behind the `refs` it was never offered.
 * - `refs <langKey>` -> `search` -> `search-schema`, three misses in a row, while
 *   `search-lang` answers instantly and is suggested by neither.
 * - `bench <categoryId>` says "no bench" and sends the reader to a list that
 *   cannot contain a category, though `refs` will happily say it is one.
 *
 * The loop those comments describe -- `search` pointing at `refs`, `refs`
 * pointing back -- exists because neither command could say what the token was.
 * Asking that question in one place is the fix; suppressing one arm of the loop
 * was the symptom's fix and cost the value case.
 */
export interface TokenIdentity {
  readonly assets: number;
  readonly assetTypes: readonly string[];
  /** Occurrences as a field value, whatever else it may also be. */
  readonly valueOccurrences: number;
  readonly valueAssets: number;
  readonly files: number;
  /** The stored key spelling, when the token names a localization key. */
  readonly langKey: string | null;
  readonly benchId: boolean;
  readonly benchCategory: boolean;
}

/**
 * Occurrences of a string as a field value that produced NO edge to these assets.
 *
 * The number that means something when the token is BOTH an asset and a value.
 * Edges are built FROM candidates, so for an asset every inbound reference is
 * also an occurrence of its name as a value: reporting the raw occurrence count
 * as an additional set said "10 occurrences, not listed above" directly beneath
 * the same ten rows. Four of five blind trials caught it, with counts matching
 * exactly (10/10, 22/22, 164/164, 4/4) -- which is what makes it a double count
 * rather than a coincidence.
 *
 * The residue is real and worth naming: a value can appear where no edge was
 * built -- filtered as noise, inside an unaligned type, or contradicted by a
 * declared target. `refs 5` has 4 edges and 4 756 occurrences, and that gap is
 * the whole answer to "which blocks require Quality 5".
 */
export function valueOccurrencesWithoutEdges(
  db: Database,
  token: string,
  targetIds: readonly number[],
): { occurrences: number; assets: number } {
  if (targetIds.length === 0) return { occurrences: 0, assets: 0 };
  const holes = targetIds.map(() => "?").join(",");
  const where = `c.raw_value = ?
      AND NOT EXISTS (SELECT 1 FROM edges e
                       WHERE e.src = c.asset_id
                         AND e.json_pointer = c.json_pointer
                         AND e.dst_kind = 'asset'
                         AND e.dst IN (${holes}))`;
  return {
    occurrences: count(db, `SELECT count(*) AS n FROM candidates c WHERE ${where}`, token, ...targetIds),
    assets: count(
      db,
      `SELECT count(DISTINCT c.asset_id) AS n FROM candidates c WHERE ${where}`,
      token,
      ...targetIds,
    ),
  };
}

export function identify(db: Database, token: string): TokenIdentity {
  const stored = referenceToKey(token);
  const langRow = db
    .prepare("SELECT key FROM lang_keys WHERE key = ?1 OR key = ?2 LIMIT 1")
    .get(token, stored) as { key: string } | undefined;

  return {
    assets: count(db, "SELECT count(*) AS n FROM assets WHERE logical_id = ?", token),
    assetTypes: (
      db
        .prepare("SELECT DISTINCT type FROM assets WHERE logical_id = ? ORDER BY type")
        .all(token) as unknown as { type: string | null }[]
    ).map((r) => r.type ?? "untyped"),
    valueOccurrences: count(
      db,
      "SELECT count(*) AS n FROM candidates WHERE raw_value = ?",
      token,
    ),
    valueAssets: count(
      db,
      "SELECT count(DISTINCT asset_id) AS n FROM candidates WHERE raw_value = ?",
      token,
    ),
    files: count(
      db,
      "SELECT count(*) AS n FROM files WHERE path = ?1 OR path LIKE '%/' || ?1",
      token,
    ),
    langKey: langRow?.key ?? null,
    benchId: count(db, "SELECT count(*) AS n FROM benches WHERE id = ?", token) > 0,
    benchCategory:
      count(db, "SELECT count(*) AS n FROM bench_categories WHERE category_id = ?", token) > 0,
  };
}

export interface ValueUsage {
  /** Total occurrences, across every field and asset. */
  readonly occurrences: number;
  /** Distinct assets carrying it -- always <= occurrences. */
  readonly assets: number;
  readonly byField: readonly { scope: string; pointer: string; count: number }[];
  /** Distinct fields, so a shown-3-of-N breakdown can say the N. */
  readonly fields: number;
  /** How many byField rows are display rows rather than the over-fetch. */
  readonly fieldsShown: number;
  /**
   * Occurrences the breakdown cannot place, because the candidate never
   * aligned to a declared field.
   *
   * 45 319 of 479 117 candidates carry no `schema_scope`, 44 938 of them
   * NPCRole -- a type the schema declares nothing for. So `refs Variant`
   * printed '466 time(s) in 465 asset(s):' and then an EMPTY breakdown under
   * the colon, and `refs State` accounted for 21 of 1 509.
   */
  readonly unattributed: number;
  readonly examples: readonly { logicalId: string; type: string | null; pointer: string }[];
}

/**
 * Where a plain string appears as a field VALUE rather than an asset id.
 *
 * Three separate defects lived in the old inline version of this query.
 *
 * It said "N **assets** carry it as a VALUE" while counting occurrences:
 * `refs HarvestCrop` claimed 29 assets where `describe` counted 25, and
 * `refs Necromancy_Bones` claimed 2 for a single asset holding the value
 * twice. Both numbers are worth having, so both are returned.
 *
 * Its breakdown was capped at three rows but the total was the sum of those
 * three, so a truncated list added up perfectly and read as exhaustive --
 * `refs 50` reported 389 across three fields while `Item/ItemLevel`, which the
 * index does not store values for, was missing entirely.
 *
 * And it named no assets at all. It pointed at `describe <Type> --field <p>`,
 * which for a high-cardinality field answers "more values than this index
 * keeps -- use refs", pointing straight back. Every one of five blind trials
 * hit that loop; two called it the single biggest gap in the tool.
 */
export function valueUsage(db: Database, value: string, limit = 10): ValueUsage {
  // Both lists move with --limit. Capping the field breakdown at a separate
  // hard-coded 6 while telling the reader to raise --limit produced a page
  // that named a remedy it did not honour, at every limit they tried.
  const fieldLimit = Math.max(6, Math.ceil(limit / 2));
  const byField = db
    .prepare(
      `SELECT schema_scope AS scope, schema_pointer AS pointer, count(*) AS count
         FROM candidates
        WHERE raw_value = ? AND schema_scope IS NOT NULL
        GROUP BY schema_scope, schema_pointer
        ORDER BY count DESC LIMIT ?`,
    )
    .all(value, fieldLimit + 1) as unknown as { scope: string; pointer: string; count: number }[];

  const examples = db
    .prepare(
      `SELECT a.logical_id AS logicalId, a.type, c.json_pointer AS pointer
         FROM candidates c JOIN assets a ON a.id = c.asset_id
        WHERE c.raw_value = ?
        ORDER BY a.logical_id LIMIT ?`,
    )
    .all(value, limit + 1) as unknown as {
    logicalId: string;
    type: string | null;
    pointer: string;
  }[];

  return {
    occurrences: count(db, "SELECT count(*) AS n FROM candidates WHERE raw_value = ?", value),
    assets: count(
      db,
      "SELECT count(DISTINCT asset_id) AS n FROM candidates WHERE raw_value = ?",
      value,
    ),
    byField,
    fieldsShown: Math.min(byField.length, fieldLimit),
    fields: count(
      db,
      `SELECT count(*) AS n FROM (SELECT 1 FROM candidates WHERE raw_value = ?
         AND schema_scope IS NOT NULL GROUP BY schema_scope, schema_pointer)`,
      value,
    ),
    examples,
    unattributed: count(
      db,
      "SELECT count(*) AS n FROM candidates WHERE raw_value = ? AND schema_scope IS NULL",
      value,
    ),
  };
}

/**
 * Where a string is DECLARED as a legal constant, even though nothing uses it.
 *
 * The difference between "there is no such thing" and "vanilla never does it",
 * which `refs` could not tell apart: `refs AOECylinder` answered "is not an
 * asset, carries no value, and no referenced file has that name" about a shape
 * the schema declares as a selector discriminator, while `refs AOECircle`
 * returned 17 occurrences. Read side by side the pair says exists / does not
 * exist, when it says used / unused -- and for someone asking whether the engine
 * can do a thing, that inverts the answer.
 */
export function declaredConstant(
  db: Database,
  value: string,
): { assetType: string; pointer: string } | null {
  const row = db
    .prepare(
      `SELECT asset_type AS assetType, json_pointer AS pointer FROM schema_fields
        WHERE type_constant = ?1
           OR (enum_values IS NOT NULL
               AND (enum_values = ?1
                 OR enum_values LIKE ?1 || char(31) || '%'
                 OR enum_values LIKE '%' || char(31) || ?1 || char(31) || '%'
                 OR enum_values LIKE '%' || char(31) || ?1))
        LIMIT 1`,
    )
    .get(value) as { assetType: string; pointer: string } | undefined;
  return row ?? null;
}

/**
 * `valueUsage`, capped and qualified -- what a front end should actually serve.
 *
 * `valueUsage` over-fetches by one so a caller can DETECT the cap, and returns
 * the lists unsliced; the CLI slices and prints "... 11 more". The served answer
 * did neither: it returned `limit + 1` rows with `caveats: []`, so eleven rows
 * arrived for a limit of ten and a clipped reference list was indistinguishable
 * from a whole one. Four agents in one round re-ran with a larger limit to find
 * out, and one of them needed the rows that had been dropped.
 */
export function valueRefsOp(db: Database, value: string, limit = 40): Result<ValueUsage> {
  const usage = valueUsage(db, value, limit);
  const fieldLimit = Math.max(6, Math.ceil(limit / 2));
  const caveats: Caveat[] = [caveat.preInheritance()];
  if (usage.examples.length > limit) {
    caveats.push(caveat.truncated(limit, "assets carrying this value", usage.assets));
  }
  if (usage.byField.length > fieldLimit) {
    caveats.push(caveat.truncated(fieldLimit, "fields carrying it", usage.fields));
  }
  return ok(
    {
      ...usage,
      examples: usage.examples.slice(0, limit),
      byField: usage.byField.slice(0, fieldLimit),
    },
    caveats,
  );
}

export interface FileUsage {
  readonly path: string;
  readonly references: readonly {
    logicalId: string;
    type: string | null;
    pointer: string | null;
  }[];
  /** Edges pointing at the file. One asset can hold several. */
  readonly total: number;
  /** Distinct assets, which is the smaller and more useful number. */
  readonly assets: number;
}

/**
 * Who references a non-JSON file: a model, texture, icon, sound or animation.
 *
 * `refsOp` filters `dst_kind = 'asset'`, so 33 782 REFERENCES_FILE edges over
 * 24 923 files were unreachable: `refs Glow.png` answered 'nothing carries it
 * as a value' about a texture 221 edges point at. The schema names 'file' as a
 * first-class destination kind; nothing joined the table.
 *
 * Matched on the basename as well as the full path, because the stored value
 * is a pack-relative path the reader has no reason to know.
 */
/**
 * `refs`, whole: the one entry both front ends call.
 *
 * The command answers four different questions depending on what the string turns
 * out to be, and each branch used to be assembled separately in the CLI and again
 * in the MCP server. They diverged in every branch: the value branch was served
 * with `caveats: []` and `limit + 1` rows, and the final miss said "is not an
 * asset, carries no value" about strings the schema declares as legal constants.
 */
export function refsAnyOp(
  db: Database,
  logicalId: string,
  type: string | undefined,
  limit = 40,
): Result<Record<string, unknown>> {
  const asAsset = refsOp(db, logicalId, type, limit);

  if (asAsset.value.targets.length === 0) {
    // Before treating it as a plain string: does it exist as an asset of ANOTHER
    // type? `refs Wood --type Item` answered "'Wood' is not an asset" about a name
    // four assets carry, while `get` has always got this right.
    if (type !== undefined) {
      const elsewhere = sameNamed(db, logicalId);
      if (elsewhere.length > 0) {
        return rendered(
          { kind: "wrong-type", found: false, logicalId, existsAs: elsewhere.map((c) => c.type) },
          `No '${logicalId}' of type '${type}'. It exists as: ` +
            `${elsewhere.map((c) => c.type ?? "untyped").join(", ")}\n` +
            `Try: hytale-atlas refs ${logicalId} --type ${elsewhere[0]!.type ?? ""}\n`,
          [],
        );
      }
    }

    const usage = valueRefsOp(db, logicalId, limit);
    if (usage.value.occurrences > 0) {
      const u = usage.value;
      // stdout and exit 0: this is an ANSWER, not a miss. It went to stderr with
      // exit 1 -- a successful lookup reported as a failure, unusable in a
      // pipeline -- and once `search` began suggesting this exact command for a
      // value, the suggestion led somewhere that printed nothing to stdout.
      return rendered(
        { kind: "value", found: true, ...u },
        `'${logicalId}' is not an asset. It appears as a VALUE ` +
          `${formatCount(u.occurrences)} time(s) in ${formatCount(u.assets)} asset(s):\n` +
          u.byField.map((r) => `  ${formatCount(r.count)}x  ${r.scope} :: ${r.pointer}\n`).join("") +
          // What the remainder actually is: occurrences whose pointer never
          // resolved to a field position at all, because the owning type declares
          // no fields to resolve against (44 938 of them are NPCRole).
          (u.unattributed > 0
            ? `  ${formatCount(u.unattributed)} occurrence(s) sit in assets whose ` +
              `type declares no fields, so their position could not be resolved ` +
              `and the breakdown above does not sum to the total.\n`
            : "") +
          `\nCarried by:\n` +
          u.examples
            .map(
              (e) =>
                `  ${e.logicalId.padEnd(38)} ${(e.type ?? "untyped").padEnd(18)} ${e.pointer}\n`,
            )
            .join("") +
          caveatBlock(usage.caveats),
        usage.caveats,
      );
    }

    // It may be a FILE. Models, textures, icons, sounds and animations are
    // indexed with their own edge kind, and `refs` filtered them out -- so a
    // texture with 221 inbound references answered "nothing carries it as a value".
    const asFile = fileRefsOp(db, logicalId, limit);
    if (asFile.value.length > 0) {
      return rendered(
        { kind: "file", found: true, files: asFile.value },
        asFile.value
          .map(
            (file) =>
              `${file.path}\n` +
              `  ${formatCount(file.assets)} asset(s) reference this file, ` +
              `${formatCount(file.total)} time(s):\n` +
              file.references
                .map(
                  (r) =>
                    `    ${r.logicalId.padEnd(36)} ${(r.type ?? "untyped").padEnd(18)} ` +
                    `${r.pointer ?? ""}\n`,
                )
                .join(""),
          )
          .join("") + caveatBlock(asFile.caveats),
        asFile.caveats,
      );
    }

    // Declared-but-unused is not the same as non-existent, and the flat negative
    // said the second about strings that are the first.
    const declared = declaredConstant(db, logicalId);
    const caveats: Caveat[] =
      declared === null
        ? []
        : [
            {
              code: "container-no-observations" as const,
              message:
                `'${logicalId}' IS declared by the schema, as a legal value of ` +
                `${declared.assetType}${declared.pointer}. No vanilla asset uses it, which ` +
                `is why nothing references it -- that is "unused", not "does not exist".`,
            },
          ];
    // "no file by that name" was asserted about anything the file-reference index
    // did not hold -- including `Tool_Pickaxe_Iron.json`, a path this very tool
    // prints in the header of `get`. Only asset documents are absent from `files`,
    // so say which index was consulted rather than making a claim about the archive.
    return rendered(
      {
        kind: "miss",
        found: false,
        reason:
          `No asset '${logicalId}'${type ? ` of type '${type}'` : ""}, and nothing carries ` +
          `it as a value. No file of that name is REFERENCED by any asset (asset ` +
          `documents themselves are not in the file index).`,
        ...(declared === null ? {} : { declaredAs: declared }),
        alsoKnownAs: identify(db, logicalId),
      },
      `No asset '${logicalId}'${type ? ` of type '${type}'` : ""}, ` +
        "and nothing carries it as a value. No file of that name is REFERENCED by\n" +
        "any asset (asset documents themselves are not in the file index).\n" +
        caveatBlock(caveats) +
        nextCommands(db, logicalId),
      caveats,
    );
  }

  // A bench is referenced by the id it DECLARES, not by the id of the asset
  // declaring it, so `refs Bench_WorkBench` returned one unrelated edge while 49
  // recipes required that bench.
  const declares = benchDeclaredBy(db, logicalId);
  const beyond = valueOccurrencesWithoutEdges(
    db,
    logicalId,
    asAsset.value.targets.map((t) => t.id),
  );
  const v = asAsset.value;
  const text =
    (declares !== null
      ? `note: this asset declares the bench id '${declares}'. Recipes reference that\n` +
        `      id rather than this asset, so they are NOT listed below.\n` +
        `      Use: hytale-atlas bench ${declares}\n\n`
      : "") +
    (v.total === 0
      ? `Nothing references '${logicalId}'.\n`
      : `${formatCount(v.total)} references to '${logicalId}':\n\n` +
        v.references
          .map(
            (r) =>
              `${r.confidence.padEnd(7)} ${r.logicalId.padEnd(34)} ` +
              `${(r.type ?? "(untyped)").padEnd(20)} ${r.kind} ${r.pointer ?? ""}\n`,
          )
          .join("")) +
    // The asset branch is chosen silently when the token is BOTH an asset and a
    // field value, and the value report is then unreachable. Every Quality value
    // in the game (1-6) is also the name of a BlockMigration asset.
    (beyond.occurrences > 0
      ? `\n'${logicalId}' also appears ${formatCount(beyond.occurrences)} time(s) in ` +
        `${formatCount(beyond.assets)} asset(s) as a value that produced no edge above ` +
        `(filtered as\ngeneric, or in a type the schema declares no fields for).\n`
      : "") +
    // Confidence is not decoration. A declared reference is a fact the schema
    // states; a heuristic one is a name that happens to collide, and 'Stone'
    // collides with a great many things.
    "\nhigh   = declared by the schema AND this target IS of the declared type,\n" +
    "         or inheritance the engine resolves itself\n" +
    "medium = the schema declares this field a reference, but this target is not\n" +
    "         of the declared type (some other asset shares the name), or the\n" +
    "         field declares no target and its name follows a convention\n" +
    "low    = the value merely collides with an identifier; often coincidence\n" +
    // Wrapped so no line begins with a confidence word: those start a result row,
    // and prose that opens with one is indistinguishable from data to anything
    // reading this output -- including this project's own tests.
    "\nA field can be declared '-> X', have no X of that name, and still show\n" +
    "an edge of medium confidence to a same-named asset of another type.\n" +
    "'describe' calls that value BROKEN; both are true, about different things.\n" +
    caveatBlock(asAsset.caveats);

  return rendered(
    {
      kind: "asset",
      found: true,
      ...v,
      ...(beyond.occurrences > 0 ? { alsoAValueElsewhere: beyond } : {}),
      ...(declares === null ? {} : { declaresBenchId: declares }),
    },
    text,
    asAsset.caveats,
  );
}

export function fileRefsOp(db: Database, needle: string, limit = 40): Result<FileUsage[]> {
  // Bounded by --limit like every other list here. It was a hard 5, and the
  // truncation notice this function now emits ends "Use --limit <n> for more" --
  // a remedy the caller could not honour, which is the defect `valueUsage`
  // records having fixed one screen above.
  const files = db
    .prepare(
      `SELECT id, path FROM files
        WHERE path = ?1 OR path LIKE '%/' || ?1
        ORDER BY length(path), path LIMIT ?2`,
    )
    .all(needle, limit) as unknown as { id: number; path: string }[];
  if (files.length === 0) return ok([]);

  // A basename is rarely unique: 291 of them name more than five files, and
  // `Model.blockymodel` names 173. Five groups were printed and the other 168
  // went unmentioned, so the answer read as "these are the files with this
  // name".
  const matching = count(
    db,
    "SELECT count(*) AS n FROM files WHERE path = ?1 OR path LIKE '%/' || ?1",
    needle,
  );

  const rows = db.prepare(
    `SELECT a.logical_id AS logicalId, a.type, e.json_pointer AS pointer
       FROM edges e JOIN assets a ON a.id = e.src
      WHERE e.dst_kind = 'file' AND e.dst = ?
      ORDER BY a.logical_id LIMIT ?`,
  );

  const usage = files.map((file) => ({
    path: file.path,
    references: rows.all(file.id, limit) as unknown as {
      logicalId: string;
      type: string | null;
      pointer: string | null;
    }[],
    total: count(
      db,
      "SELECT count(*) AS n FROM edges WHERE dst_kind = 'file' AND dst = ?",
      file.id,
    ),
    // Both, because they differ and the label was wrong about which it was:
    // Frown.blockyanim showed '148 asset(s)' where 38 assets hold 148 pointers.
    // 1 534 of 19 497 referenced files are affected.
    assets: count(
      db,
      "SELECT count(DISTINCT src) AS n FROM edges WHERE dst_kind = 'file' AND dst = ?",
      file.id,
    ),
  }));

  const caveats: Caveat[] = [];
  const shown = usage.reduce((n, u) => n + u.references.length, 0);
  const all = usage.reduce((n, u) => n + u.total, 0);
  if (all > shown) caveats.push(caveat.truncated(shown, "references", all));
  if (matching > files.length) {
    caveats.push(caveat.truncated(files.length, `files named '${needle}'`, matching));
  }
  return ok(usage, caveats);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

export interface LangEntry {
  readonly key: string;
  /**
   * What an asset must actually contain: the key with its root prefix.
   *
   * Printing the stored key alone made a modder who searched successfully
   * paste a dead reference -- `items.Foo.name` where the asset needs
   * `server.items.Foo.name`. Four blind trials in a row reported it, and the
   * rule was only ever explained on a MISS.
   */
  readonly reference: string;
  readonly translations: readonly { locale: string; value: string }[];
  readonly usedBy: readonly { logicalId: string; pointer: string | null }[];
  /** Every asset referencing the key, before the display cap. */
  readonly usedByTotal: number;
  /**
   * The .lang files this key lives in, per locale -- the files you edit.
   *
   * A blind trial could derive the key, the reference spelling and every
   * translation, and still could not finish: "where do the display names live so
   * I can add my own" had no answer anywhere in the ten tools. Not derivable from
   * `root`, since the avatar files sit under
   * Common/Languages/<locale>/avatarCustomization/.
   */
  readonly files: readonly { locale: string; path: string }[];
}

export function langOp(db: Database, query: string, limit = 20): Result<LangEntry[]> {
  // Both spellings, because a caller pastes whichever they have: assets
  // reference `server.items.X.name`, the table stores `items.X.name`.
  const stripped = referenceToKey(query);
  // A third spelling: strip whatever the caller's first segment is and see if
  // the remainder is a key under exactly that root. `referenceToKey` only knows
  // 'server.' and 'common.', so `wordlists.runes.algas` -- the full path the
  // schema's own WordList documentation gives -- was reported as a real miss,
  // while the wrong `server.runes.algas` resolved.
  const dot = query.indexOf(".");
  const anyRoot = dot < 0 ? null : query.slice(0, dot);
  const anyRest = dot < 0 ? null : query.slice(dot + 1);
  const keys = db
    .prepare(
      `SELECT DISTINCT key FROM lang_keys
        WHERE key = ?1 OR key = ?2 OR key LIKE '%' || ?2 || '%'
           OR value LIKE '%' || ?1 || '%'
           OR (?4 IS NOT NULL AND key = ?4 AND root = ?5)
        ORDER BY length(key), key LIMIT ?3`,
    )
    .all(query, stripped, limit + 1, anyRest, anyRoot) as unknown as { key: string }[];

  const translations = db.prepare(
    "SELECT locale, value FROM lang_keys WHERE key = ? ORDER BY locale",
  );
  const users = db.prepare(
    `SELECT DISTINCT a.logical_id, e.json_pointer FROM edges e
       JOIN lang_keys l ON l.id = e.dst JOIN assets a ON a.id = e.src
      WHERE e.dst_kind = 'lang_key' AND l.key = ? LIMIT ?`,
  );

  const rootOf = db.prepare(
    "SELECT root FROM lang_keys WHERE key = ? AND root IS NOT NULL LIMIT 1",
  );

  const filesOf = db.prepare(
    `SELECT DISTINCT locale, source_path AS path FROM lang_keys
      WHERE key = ? AND source_path IS NOT NULL ORDER BY locale`,
  );

  const entries = keys.slice(0, limit).map(({ key }) => ({
    key,
    reference: (() => {
      const row = rootOf.get(key) as { root: string } | undefined;
      return row === undefined ? key : `${row.root}.${key}`;
    })(),
    translations: translations.all(key) as unknown as { locale: string; value: string }[],
    usedByTotal: count(
      db,
      `SELECT count(DISTINCT e.src) AS n FROM edges e JOIN lang_keys l ON l.id = e.dst
        WHERE e.dst_kind = 'lang_key' AND l.key = ?`,
      key,
    ),
    usedBy: (
      // Capped at a hard 5 with no signal, so `interactionHints.openDoor`
      // showed 5 of 91 users and looked complete. --limit did not move it.
      users.all(key, limit + 1) as unknown as {
        logical_id: string;
        json_pointer: string | null;
      }[]
    ).map((u) => ({ logicalId: u.logical_id, pointer: u.json_pointer })),
    files: filesOf.all(key) as unknown as { locale: string; path: string }[],
  }));

  const caveats: Caveat[] = [];
  if (keys.length > limit) caveats.push(caveat.truncated(entries.length, "keys"));

  if (entries.length === 0) {
    return rendered(
      entries,
      `No localization key or value matches "${query}".\n\n\n\n` +
        // "Any root is accepted" was false, and false in the one direction that
        // misleads: 'server.' and 'common.' are stripped, and any other first
        // segment is only tried as a literal root against lang_keys.root.
        // 'emotes.general.deathCause.burn' missed while the 'server.' spelling
        // resolved -- the root WAS the problem, under a sentence saying it could
        // not be.
        "Keys are stored WITHOUT their root: an asset referencing\n" +
        "'server.items.Foo.name' is stored as 'items.Foo.name'. 'server.' and\n" +
        "'common.' are stripped automatically; any other first segment is tried\n" +
        "as a literal root, so try the key without its root as well.\n\n" +
        // The one command that had no coverage hedge, while its siblings all
        // carry one -- and the command a reader uses to ask whether a language
        // exists at all.
        "This is evidence, not proof: it covers the locales this index holds\n" +
        "(see 'hytale-atlas status'), and matching is literal -- a string spelt\n" +
        "differently would not match.\n",
      caveats,
    );
  }

  const body = entries
    .map((entry) => {
      // Both forms. The stored key is what the table holds; the reference is what
      // an asset must contain, and printing only the former sent modders to paste
      // a key the game will not resolve.
      const shownUsers = entry.usedBy.slice(0, limit);
      return (
        `${entry.key}\n` +
        (entry.reference === entry.key
          ? ""
          : `    write this in an asset: ${entry.reference}\n`) +
        entry.translations.map((t) => `    ${t.locale.padEnd(7)} ${t.value}\n`).join("") +
        // The file, which is the half of "where does this live" a modder has to
        // edit. Every other half was already answerable, and this one had no
        // answer anywhere in the ten tools.
        entry.files.map((f) => `    in ${f.locale.padEnd(7)} ${f.path}\n`).join("") +
        shownUsers.map((u) => `    used by ${u.logicalId} ${u.pointer ?? ""}\n`).join("") +
        (entry.usedByTotal > shownUsers.length
          ? `    ... and ${formatCount(entry.usedByTotal - shownUsers.length)} more ` +
            `of ${formatCount(entry.usedByTotal)}. Raise the limit for more.\n`
          : "") +
        // Said rather than left blank: a key with no inbound edge is normal (UI
        // text, or referenced by something the index does not type), and silence
        // would read as "nothing uses this".
        (entry.usedBy.length === 0
          ? "    used by nothing indexed (UI text, or referenced dynamically)\n"
          : "")
      );
    })
    .join("");
  return rendered(entries, body + caveatBlock(caveats), caveats);
}

export interface ValueLink {
  readonly link: string;
  /** 'declares' names the value; 'references' uses it. */
  readonly role: string;
  /** Values declared at the OTHER end of the link. */
  readonly declared: readonly string[];
  /** Where those declarations live, for a follow-up command. */
  readonly declaredBy: readonly { logicalId: string; pointer: string }[];
  /** How many assets declare values for this link, before the display cap. */
  readonly declaredByTotal: number;
  /** Referenced values nothing declares -- vanilla ships some. */
  readonly unresolved: readonly string[];
}

/**
 * The value link a field takes part in, if any.
 *
 * Pass 4 fills `value_links` -- 5 287 rows across three links -- and until now
 * nothing read it. An entire indexing pass with no reader, holding exactly the
 * answers blind trials kept failing to get: `gather-type` records 14 values
 * declared by tools against 16 referenced by blocks, which one agent could only
 * reconstruct by merging three commands and still missed three; another
 * reported flatly that the tool 'cannot define or extend GatherType'.
 *
 * A value link is a string whose legal values are declared somewhere else in
 * the corpus. JSON Schema has no vocabulary for that, so neither `enum` nor a
 * reference target can express it and `describe` had nothing to show.
 */
export function valueLinkFor(
  db: Database,
  assetType: string,
  pointer: string,
): ValueLink | null {
  const site = db
    .prepare(
      `SELECT vl.link, vl.role FROM value_links vl
         JOIN candidates c ON c.asset_id = vl.asset_id AND c.json_pointer = vl.json_pointer
        WHERE c.schema_scope = ? AND c.schema_pointer = ? LIMIT 1`,
    )
    .get(assetType, pointer) as { link: string; role: string } | undefined;
  if (site === undefined) return null;

  const other = site.role === "declares" ? "references" : "declares";
  const declared = (
    db
      .prepare(
        "SELECT DISTINCT value FROM value_links WHERE link = ? AND role = 'declares' ORDER BY value",
      )
      .all(site.link) as unknown as { value: string }[]
  ).map((r) => r.value);

  const declaredBy = db
    .prepare(
      // DISTINCT by asset. Grouping by row listed the same debug asset six times,
      // once per array index, which looks like six sources and names none.
      `SELECT a.logical_id AS logicalId, min(vl.json_pointer) AS pointer
         FROM value_links vl JOIN assets a ON a.id = vl.asset_id
        WHERE vl.link = ? AND vl.role = 'declares'
        GROUP BY a.logical_id ORDER BY a.logical_id LIMIT 6`,
    )
    .all(site.link) as unknown as { logicalId: string; pointer: string }[];

  const unresolved = (
    db
      .prepare(
        `SELECT DISTINCT value FROM value_links
          WHERE link = ? AND role = 'references' AND resolved = 0 ORDER BY value`,
      )
      .all(site.link) as unknown as { value: string }[]
  ).map((r) => r.value);

  void other;
  return {
    link: site.link,
    role: site.role,
    declared,
    declaredBy,
    // Six of 27 read as the complete set. Every other cap in this file
    // announces itself.
    declaredByTotal: count(
      db,
      "SELECT count(DISTINCT asset_id) AS n FROM value_links WHERE link = ? AND role = 'declares'",
      site.link,
    ),
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// Benches
// ---------------------------------------------------------------------------

/**
 * Every bench, including the ones no asset declares.
 *
 * The list was built from declarations alone, so `Fieldcraft` -- hand-crafting,
 * with no physical block to declare it -- was absent from a table titled "all
 * benches" while `bench Fieldcraft` worked and listed nine real recipes, and
 * vanilla's own Workbench recipe requires it. A summary that silently omits a
 * row is the same failure as a truncated list that does not say so.
 */
export function benchesOp(db: Database, limit = 200) {
  const all =
    db
      .prepare(
        `SELECT ids.id,
                (SELECT bench_type FROM benches b WHERE b.id = ids.id) bench_type,
                (SELECT group_concat(a.logical_id, ', ') FROM bench_declarations d
                   JOIN assets a ON a.id = d.asset_id WHERE d.bench_id = ids.id) declared_by,
                (SELECT count(*) FROM bench_categories c WHERE c.bench_id = ids.id) cats,
                (SELECT count(*) FROM bench_requirements r WHERE r.bench_id = ids.id) reqs,
                -- Fall back to the Type the RECIPES declare. Six ids have no
                -- declaring asset and printed TYPE '?', though every one of
                -- their 78 requirements carries Type 'Crafting' -- the tool had
                -- the answer and showed a question mark.
                (SELECT c.raw_value FROM bench_requirements r
                   JOIN candidates c
                     ON c.asset_id = r.asset_id
                    AND c.json_pointer = r.json_pointer || '/Type'
                  WHERE r.bench_id = ids.id LIMIT 1) req_type,
                -- Whether the id is a declared BenchCategory rather than a bench.
                -- 'Furniture_Misc' is one, typo'd into an Id slot, and the tool
                -- listed it under 'BENCH ID (use this)' with a confident gloss.
                EXISTS (SELECT 1 FROM bench_categories bc WHERE bc.category_id = ids.id)
                  AS is_category
           FROM (SELECT id FROM benches
                 UNION
                 SELECT bench_id FROM bench_requirements) ids
          ORDER BY reqs DESC`,
      )
      .all() as unknown as {
      id: string;
      bench_type: string | null;
      req_type: string | null;
      is_category: number;
      declared_by: string | null;
      cats: number;
      reqs: number;
    }[];

  const rows = all.slice(0, limit);
  const caveats: Caveat[] = [];
  if (all.length > limit) caveats.push(caveat.truncated(rows.length, "benches", all.length));

  // Headed, and the key column is named. Two ids sit on every row and only one
  // of them works anywhere: 'Workbench' is what `bench <id>` takes AND what a
  // recipe's BenchRequirement.Id must say, while 'Bench_WorkBench' is the asset
  // that declares it. An agent reading the unlabelled form assumed the rightmost
  // token was the key and would have written the wrong id into a recipe, where it
  // fails silently at runtime.
  const header =
    `${"BENCH ID".padEnd(18)} ${"TYPE".padEnd(18)} ${"RECIPES".padStart(7)} ` +
    `${"CAT".padStart(3)}  DECLARED BY\n` +
    `${"(use this)".padEnd(18)} ${"".padEnd(18)} ${"".padStart(7)} ` +
    `${"".padStart(3)}  (the asset, not the id)\n` +
    // CAT counts what the BENCH ASSET declares. The bracketed groups in
    // 'bench <id>' are what the RECIPES name, which is a different set --
    // Weapon_Bench declares 5 and its recipes name 8. Unlabelled, the two read as
    // the same number disagreeing with itself.
    `\nCAT counts categories the bench ASSET declares. The [groups] under\n` +
    `'bench <id>' are the categories its RECIPES name -- a different set,\n` +
    `so the two numbers differ by design.\n\n`;
  const body = rows
    .map((r) => {
      // Report, do not interpret. '(no declaring asset -- hand crafting)' was an
      // invented causal story: no such concept exists in the schema, and one of
      // the six ids it labelled that way is a declared BenchCategory typo'd into
      // an Id slot. All the index knows is that nothing declares the id.
      const origin =
        r.declared_by ??
        (r.is_category === 1
          ? "(no bench declares this id; it IS a declared bench category)"
          : "(no bench declares this id)");
      return (
        `${r.id.padEnd(18)} ${String(r.bench_type ?? r.req_type ?? "?").padEnd(18)} ` +
        `${String(r.reqs).padStart(7)} ${String(r.cats).padStart(3)}  ${origin}\n`
      );
    })
    .join("");
  return rendered(rows, header + body + caveatBlock(caveats), caveats);
}

export function benchOp(db: Database, benchId: string, limit = 200) {
  const categories = db
    .prepare(
      `SELECT c.category_id, c.parent_id, c.name_key, l.value
         FROM bench_categories c
         LEFT JOIN lang_keys l ON l.key = c.name_key AND l.locale = 'en-US'
        WHERE c.bench_id = ?
        ORDER BY coalesce(c.parent_id, c.category_id), c.parent_id IS NOT NULL, c.category_id`,
    )
    .all(benchId) as unknown as {
    category_id: string;
    parent_id: string | null;
    name_key: string | null;
    value: string | null;
  }[];
  // Over-fetch and total, exactly as the CLI does. This copy called
  // `craftableAt(db, benchId, limit)` and returned no total and no caveat --
  // i.e. it reproduced verbatim the defect `cmdBench`'s own comment records as
  // fixed ('said 200 craftable here while the bench table said 911'). An MCP
  // server reading this layer would have shipped it.
  const fetched = craftableAt(db, benchId, limit + 1);
  const items = fetched.slice(0, limit);
  const total = benchRecipeCount(db, benchId);
  // Whether any asset provides a station carrying this id. The CLI prints this
  // as a NOTE and the served answer had it nowhere, so a bench nothing declares
  // -- a recipe that can never be crafted, which is the runtime silence this
  // command exists to prevent -- arrived looking exactly like a working one.
  const declaredBy = benchDeclarers(db, benchId);
  const found = categories.length > 0 || items.length > 0;
  const caveats: Caveat[] = [
    ...(fetched.length > limit ? [caveat.truncated(items.length, "recipes", total)] : []),
    ...(declaredBy === null && found
      ? [
          {
            code: "bench-undeclared" as const,
            message:
              `No asset declares the bench id '${benchId}'. Recipes require it, but ` +
              `nothing in vanilla provides a station carrying it, so a recipe naming ` +
              `it cannot be crafted as things stand.`,
          },
        ]
      : []),
    // This list is built from recipes as WRITTEN. An item that inherits its
    // Recipe from a parent is not in it: Tool_Pickaxe_Onyxium, Wood and Scrap are
    // all craftable at the Workbench through Tool_Pickaxe_Crude and none of them
    // appear. `describe` and `refs` have carried this caveat for rounds; the one
    // command whose whole purpose is "what can I make here" did not.
    ...(found ? [caveat.preInheritance()] : []),
  ];

  if (!found) {
    // The most likely mistake is passing the declaring asset instead of the bench
    // id, so name the right one rather than only rejecting the wrong one.
    const viaAsset = benchDeclaredBy(db, benchId);
    return rendered(
      { categories, items, total, declaredBy, found: false as const },
      viaAsset !== null
        ? `'${benchId}' is the asset that declares a bench, not the bench id.\n` +
            `Use: hytale-atlas bench ${viaAsset}\n` +
            `(that same id is what a recipe's BenchRequirement.Id must carry)\n`
        : // A bench CATEGORY is the mistake this command exists to catch -- it is
          // the id sitting one field away, in `Bench.Categories[].Id`, and the
          // listing itself annotates the case elsewhere. Sending the reader to a
          // list that by construction cannot contain what they typed is the one
          // dead end left in this family.
          `No bench '${benchId}'.\n` +
            nextCommands(db, benchId, null, [["hytale-atlas bench", "list every bench id"]]),
      caveats,
    );
  }

  // Headed, because column 2 is a trap. It is the category's translated NAME, and
  // it routinely collides with a real identifier of something else:
  // `Workbench_Tools` displays as `Tools`, and `Tools` is separately a
  // FieldcraftCategory asset used by nine Fieldcraft recipes. A modder copying
  // column 2 into BenchRequirement.Categories writes a category belonging to a
  // different bench and gets exactly the runtime silence they are avoiding.
  let text =
    (declaredBy === null
      ? `  NOTE: no asset declares the bench id '${benchId}'. Recipes require it,\n` +
        `  but nothing in vanilla provides a station carrying it.\n\n`
      : `  declared by: ${declaredBy}\n\n`) +
    (categories.length > 0
      ? `  ${"CATEGORY ID (use this)".padEnd(24)} DISPLAY NAME (do not use)\n`
      : "") +
    categories
      .map((c) => {
        const indent = c.parent_id === null ? "  " : "      ";
        return `${indent}${c.category_id.padEnd(26 - indent.length)} ${c.value ?? c.name_key ?? ""}\n`;
      })
      .join("") +
    `\n${formatCount(total)} craftable here:\n`;

  let current: string | null | undefined;
  for (const it of items) {
    if (it.category !== current) {
      current = it.category;
      text += `\n  [${current ?? "no category"}]\n`;
    }
    text += `    ${it.logicalId}\n`;
  }
  return rendered(
    { categories, items, total, declaredBy, found: true as const },
    `${text}\n${caveatBlock(caveats)}`,
    caveats,
  );
}

/** The bench id declared by an asset, for the "you passed the asset" hint. */
export function benchDeclaredBy(db: Database, logicalId: string): string | null {
  const row = db
    .prepare(
      `SELECT d.bench_id FROM bench_declarations d JOIN assets a ON a.id = d.asset_id
        WHERE a.logical_id = ? LIMIT 1`,
    )
    .get(logicalId) as Record<string, unknown> | undefined;
  return (row?.["bench_id"] as string | undefined) ?? null;
}

/**
 * The other direction: which assets provide a station carrying this bench id.
 *
 * Null means none does -- the id exists only in recipes. Six vanilla ids are in
 * that state.
 */
export function benchDeclarers(db: Database, benchId: string): string | null {
  const row = db
    .prepare(
      `SELECT group_concat(a.logical_id, ', ') AS ids FROM bench_declarations d
         JOIN assets a ON a.id = d.asset_id WHERE d.bench_id = ?`,
    )
    .get(benchId) as { ids: string | null } | undefined;
  return row?.ids ?? null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface IndexStats {
  readonly assets: number;
  readonly typed: number;
  readonly declaredFields: number;
  readonly observedFields: number;
  readonly joinedFields: number;
  readonly edges: number;
  /**
   * Named, never counted.
   *
   * This operation returned `count(DISTINCT locale)` while the CLI, one file
   * over, had already replaced its own count with the names -- because '5
   * locales' led a reader to work out which five by inference and conclude
   * Ukrainian was absent. It is not. An MCP server reading this layer would
   * have shipped the regression the CLI had already fixed.
   */
  readonly locales: readonly string[];
  readonly epoch: number;
}

export interface StatusValue {
  readonly project: { kind: string; root: string };
  readonly install: {
    readonly found: boolean;
    readonly root: string | null;
    readonly patchline: string | null;
    readonly otherPatchlines: readonly string[];
    readonly assetsZip: string | null;
    readonly serverJar: string | null;
    readonly bundledJava: string | null;
    readonly uiLanguage: string | null;
    /** Which paths came from a flag rather than from detection. */
    readonly overridden: readonly string[];
  };
  readonly tiers: readonly number[];
  readonly index: IndexStats | null;
  /** Why there are no index stats, when there are none. */
  readonly indexState:
    | "ready"
    | "not-built"
    | "no-archive"
    | "unreadable"
    /** The file exists and opens, but the build never reached its last stage. */
    | "incomplete"
    /** Whole, but written by indexer logic that produced different content. */
    | "stale";
  readonly databasePath: string | null;
}

/**
 * `status`, whole: where the game is, which sources are available, and what the
 * index holds.
 *
 * The two halves used to live apart. Detection, tiers and paths were rendered in
 * `main.ts`, while `statsOp` returned index counts and nothing else -- so the
 * MCP tool, reading the operation, could not answer the question its own
 * description promised, and two agents reported the gap. A third read
 * `Tier: 1 + 2` printed above `no Assets.zip, nothing to index`, because the
 * tier was asserted from a path that detection had merely expected.
 *
 * Answerable on a cold cache by design: an agent that finds the tool unready
 * must be able to diagnose why rather than guess.
 */
export async function statusOp(
  options: { assets?: string; patchline?: string; jar?: string } = {},
): Promise<Result<StatusValue>> {
  const detected = detectInstallation(options.patchline);
  const project = detectProject();
  const overridden = [
    ...(options.assets === undefined ? [] : ["assetsZip"]),
    ...(options.jar === undefined ? [] : ["serverJar"]),
  ];
  const install =
    detected === null
      ? null
      : {
          ...detected,
          ...(options.assets === undefined ? {} : { assetsZip: options.assets }),
          ...(options.jar === undefined ? {} : { serverJar: options.jar }),
        };

  const lines: string[] = [`Project:     ${project.kind}  (${project.root})`];
  if (install === null) {
    lines.push(
      "Hytale:      not found",
      "",
      "Set HYTALE_ROOT, or pass --assets to point at an archive directly.",
    );
    return rendered(
      {
        project,
        install: {
          found: false,
          root: null,
          patchline: null,
          otherPatchlines: [],
          assetsZip: null,
          serverJar: null,
          bundledJava: null,
          uiLanguage: null,
          overridden,
        },
        tiers: [],
        index: null,
        indexState: "no-archive" as const,
        databasePath: null,
      },
      `${lines.join("\n")}\n`,
    );
  }

  const others = install.availablePatchlines.filter((p) => p !== install.patchline);
  const mark = (name: string): string =>
    overridden.includes(name) ? `  (from --${name === "assetsZip" ? "assets" : "jar"})` : "";
  lines.push(
    `Install:     ${install.root}`,
    `Patchline:   ${install.patchline}${others.length > 0 ? `  (also present: ${others.join(", ")})` : ""}`,
    `Assets.zip:  ${install.assetsZip ?? "not found"}${mark("assetsZip")}`,
    `Server JAR:  ${install.serverJar ?? "not found"}${mark("serverJar")}`,
    `Bundled JVM: ${install.bundledJava ?? "not found"}`,
    `UI language: ${install.uiLanguage ?? "unknown"}  (display only; search covers every indexed locale)`,
  );

  // A source counts only if the file is actually there. Detection returns a path
  // it expects and an override is whatever the caller typed, so asserting a tier
  // from a path alone produced "Tier: 1 + 2" above "no Assets.zip".
  const present = (path: string | null): boolean => path !== null && existsSync(path);
  const tier1 = present(install.assetsZip);
  const tier2 = tier1 && present(install.serverJar) && present(install.bundledJava);
  const tier3 = project.kind !== "none";
  const tiers = [tier1 ? 1 : 0, tier2 ? 2 : 0, tier3 ? 3 : 0].filter((n) => n > 0);

  lines.push(
    `Tier:        ${tiers.join(" + ") || "none — no sources found"}  (which sources are available)`,
    `             1 = Assets.zip  2 = + the game's schema generator  3 = + a project here`,
  );
  if (tier1 && !tier2) {
    lines.push("             schema answers unavailable; pass --jar to enable tier 2");
  }

  // The index half, from the cache itself rather than from a constant. This line
  // read "not built (indexing is not implemented yet)" long after indexing
  // worked, so status contradicted every other command.
  let stats: IndexStats | null = null;
  let state: StatusValue["indexState"] = "no-archive";
  let dbPath: string | null = null;
  let summary = "no Assets.zip, nothing to index";

  const archivePath = options.assets ?? install.assetsZip;
  if (archivePath !== null && existsSync(archivePath)) {
    dbPath = frozenDbPath(frozenKey(archivePath, await archiveStamp(archivePath)));
    if (!existsSync(dbPath)) {
      state = "not-built";
      summary = "not built — run 'hytale-atlas index'";
    } else {
      const db = openDatabase(dbPath, { readOnly: true });
      try {
        stats = statsOp(db).value;
        // Counts first, THEN the completion marker. A partial index still has
        // numbers worth showing -- an author needs to see 35 074 assets and zero
        // edges to understand why the answers were wrong -- but it must not be
        // called ready. `pipelineState` is the same check the MCP bootstrap runs.
        state = pipelineState(db);
        summary =
          `${formatCount(stats.assets)} assets ` +
          `(${formatCount(stats.typed)} typed, ` +
          `${Math.round((stats.typed / Math.max(stats.assets, 1)) * 100)}%), ` +
          `${formatCount(stats.declaredFields)} schema fields, ` +
          `${formatCount(stats.edges)} edges\n` +
          // Named and attributed. "5 locales" led an agent to infer the list and
          // conclude Ukrainian was absent; an unlabelled list of five codes then
          // read as the languages the GAME ships rather than this archive.
          `             locales in this Assets.zip: ${stats.locales.join(", ")}\n` +
          `             observed/declared join: ${formatCount(stats.joinedFields)} of ` +
          `${formatCount(stats.observedFields)} observed fields match a declared one ` +
          `(${Math.round((stats.joinedFields / Math.max(stats.observedFields, 1)) * 100)}%)\n` +
          // Stated as a fact about the CLI, not as an instruction. Three agents
          // in one round read "rebuild with 'index --force'" as their next step
          // and had no way to take it: indexing is deliberately not an MCP tool,
          // so the one action the server suggested was the one it does not
          // expose. A server that starts itself rebuilds when it must anyway.
          `             epoch ${stats.epoch} -- one per index build. ` +
          `The command line rebuilds with 'index --force'; over MCP the server does it ` +
          `at startup when the index is missing, incomplete or out of date.\n` +
          `             ${dbPath}`;
        if (state !== "ready") {
          summary =
            `${
              state === "incomplete"
                ? "INCOMPLETE — the build did not reach its last stage"
                : "OUT OF DATE — built by an older indexer, contents differ from a fresh build"
            }; rerun 'hytale-atlas index --force'\n             ` + summary;
        }
      } catch (err) {
        state = "unreadable";
        summary = `unreadable (${err instanceof Error ? err.message : String(err)})`;
      } finally {
        db.close();
      }
    }
  }
  lines.push(`Index:       ${summary}`);

  return rendered(
    {
      project,
      install: {
        found: true,
        root: install.root,
        patchline: install.patchline,
        otherPatchlines: others,
        assetsZip: install.assetsZip,
        serverJar: install.serverJar,
        bundledJava: install.bundledJava,
        uiLanguage: install.uiLanguage,
        overridden,
      },
      tiers,
      index: stats,
      indexState: state,
      databasePath: dbPath,
    },
    `${lines.join("\n")}\n`,
    // Both sides, because `status` is where a reader calibrates the whole index
    // and the two ratios are an order of magnitude apart -- 85% one way, 14% the
    // other. One of them alone reads as the confidence of the pair.
    stats === null
      ? []
      : [
          caveat.joinIncomplete(stats.joinedFields, stats.observedFields, "observed"),
          caveat.joinIncomplete(stats.joinedFields, stats.declaredFields, "declared"),
        ],
  );
}

export function statsOp(db: Database): Result<IndexStats> {
  const stats: IndexStats = {
    assets: count(db, "SELECT count(*) AS n FROM assets"),
    typed: count(db, "SELECT count(*) AS n FROM assets WHERE type IS NOT NULL"),
    declaredFields: count(
      db,
      "SELECT count(*) AS n FROM schema_fields WHERE json_pointer <> ''",
    ),
    observedFields: count(db, "SELECT count(*) AS n FROM field_stats"),
    joinedFields: count(
      db,
      `SELECT count(*) AS n FROM field_stats fs JOIN schema_fields sf
         ON sf.asset_type = fs.asset_type AND sf.json_pointer = fs.json_pointer`,
    ),
    edges: count(db, "SELECT count(*) AS n FROM edges"),
    locales: (
      db
        .prepare("SELECT DISTINCT locale FROM lang_keys ORDER BY locale")
        .all() as unknown as { locale: string }[]
    ).map((r) => r.locale),
    epoch: count(db, "SELECT CAST(ifnull(value,'0') AS INTEGER) AS n FROM meta WHERE key='epoch'"),
  };
  return ok(stats, [
    caveat.joinIncomplete(stats.joinedFields, stats.observedFields, "observed"),
  ]);
}

/** True when a string names a crafting bench rather than an asset. */
/**
 * Whether the corpus knows this bench id AT ALL -- declared by a station, or
 * merely required by a recipe.
 *
 * Declarations alone are the wrong test, and the two sides genuinely differ:
 * six ids are required by recipes that nothing in vanilla provides. `Fieldcraft`
 * is one, it has nine recipes including two pickaxes, the CLI lists it and
 * annotates it -- and the served answer was a flat "No bench 'Fieldcraft'",
 * which reads as "the game has no such bench" while `refs` reports nine
 * occurrences of it. The bench a recipe names is exactly what a modder needs to
 * see, whether or not a station carries it.
 */
export function benchIdExists(db: Database, id: string): boolean {
  return (
    count(
      db,
      `SELECT (SELECT count(*) FROM benches WHERE id = ?1)
            + (SELECT count(*) FROM bench_requirements WHERE bench_id = ?1) AS n`,
      id,
    ) > 0
  );
}

/** How many recipes name this bench, before any display cap. */
export function benchRecipeCount(db: Database, benchId: string): number {
  return count(db, "SELECT count(*) AS n FROM bench_requirements WHERE bench_id = ?", benchId);
}

/**
 * Fields the corpus shows for a type that its schema never declares.
 *
 * `describe Item` lists 96 rows while `undocumented Item` says 95 are declared.
 * Both are right -- describe unions the observed layer -- but printed side by
 * side with no explanation the pair reads as an off-by-one, and a blind trial
 * filed it as one.
 */
export function undeclaredObserved(db: Database, assetType: string): number {
  return count(
    db,
    `SELECT count(*) AS n FROM field_stats fs
      WHERE fs.asset_type = ?1
        AND NOT EXISTS (SELECT 1 FROM schema_fields sf
                         WHERE sf.asset_type = ?1 AND sf.json_pointer = fs.json_pointer)`,
    assetType,
  );
}
