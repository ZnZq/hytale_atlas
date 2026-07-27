import { existsSync, readFileSync, rmSync } from "node:fs";

import { openDatabase } from "../db/open.ts";
import { buildSearchIndex } from "../indexer/corpus.ts";
import { craftableAt, indexBenches } from "../indexer/benches.ts";
import { VALUE_LINKS, indexValueLinks } from "../indexer/value-links.ts";
import { resolveCandidates } from "../indexer/references.ts";
import { computeFieldStats } from "../indexer/stats.ts";
import { TypeResolver, applyTypes, assetSuffixes, ingestSchemas } from "../indexer/schema.ts";
import { type AssetLoader, resolveAsset } from "../query/asset.ts";
import { searchAssets } from "../query/search.ts";
import {
  describeSchema,
  findUndocumented,
  isContainer,
  looksMangled,
  normalizeFieldPointer,
  pointersLike,
} from "../query/schema.ts";
import { AssetArchive, archiveStamp } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { TELEMETRY_DISCLOSURE, withGeneratedSchemas } from "../sources/schema-gen.ts";
import { readGeneratedSchemas } from "../sources/schema-doc.ts";
import {
  benchDeclaredBy,
  langOp,
  refsOp,
  searchAssetsOp,
  searchSchemaOp,
  undocumentedOp,
} from "../api/operations.ts";
import type { Caveat } from "../api/types.ts";
import { referenceToKey } from "../sources/lang.ts";
import { formatCount, frozenDbPath, frozenKey } from "../util/paths.ts";
import { askConsent } from "./consent.ts";

/**
 * Strips ANSI colour codes.
 *
 * The server colours its log output, and the escape sequences survive being piped
 * into our own output, where they corrupt alignment and leak into log files.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

/**
 * A value no asset type can equal, for the "match nothing" arm of a suggestion
 * query. Spelled out rather than left as a literal, because the literal that sat
 * here was an invisible control character.
 */
const NO_SUCH_TYPE = "\u0000-no-such-type";

/**
 * Shortens prose for a list, and says so when it does.
 *
 * Silent truncation is the failure this whole surface keeps making in different
 * costumes. Here it cut a field description mid-word with no ellipsis and no
 * flag to disable it, and the cut sentence was the one that would have settled
 * whether an area-mining primitive exists. The row-count truncation next to it
 * announced itself correctly, which made the inconsistency worse.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Announces that a result list was capped.
 *
 * Every list command had a default limit and only `describe` said so. `search`
 * showed 10 of many while --help claimed 20, and unscoped `undocumented` showed
 * 40 rows out of 6 324 in silence -- the command `search-schema` points readers
 * at to firm up a negative. Over-fetching by one is what makes "there is more"
 * knowable without a second query.
 */
/**
 * Prints the caveats an operation returned.
 *
 * The CLI does not decide what qualifies an answer -- it renders decisions made
 * in `src/api`. That is the point of the split: an MCP server serialising the
 * same `Caveat[]` cannot drift from what the CLI says, and nearly every defect
 * this tool has had was a statement rather than a computation.
 */
function renderCaveats(caveats: readonly Caveat[]): void {
  if (caveats.length === 0) return;
  process.stdout.write("\n");
  for (const c of caveats) {
    process.stdout.write(`${c.code === "truncated" ? "... " : "note: "}${c.message}\n`);
  }
}

function noticeTruncated(shown: number, hadMore: boolean, what: string): void {
  if (!hadMore) return;
  process.stdout.write(
    `
... showing the first ${formatCount(shown)} ${what}. Use --limit <n> for more.
`,
  );
}

/** Resolves the archive to index, honouring an explicit override. */
async function resolveArchive(
  assetsOverride: string | undefined,
  patchline: string | undefined,
): Promise<string> {
  if (assetsOverride) return assetsOverride;
  const install = detectInstallation(patchline);
  if (install?.assetsZip == null) {
    throw new Error(
      "Assets.zip not found. Set HYTALE_ROOT, or pass --assets <path>.",
    );
  }
  return install.assetsZip;
}

export interface GenerateSchemaArgs {
  readonly assets?: string;
  readonly jar?: string;
  readonly patchline?: string;
  /** Consent pre-granted, e.g. by `--yes`. */
  readonly yes?: boolean;
  /** Keep the generated files here instead of discarding them. */
  readonly keep?: string;
  readonly dryRun?: boolean;
}

/**
 * Generates schemas by running the game's own batch mode, then ingests them.
 *
 * Consent is required before anything runs: the generator reports telemetry that
 * cannot be disabled (`docs/init/05-CODEC-EXTRACTION.md` Hazards).
 */
export async function cmdGenerateSchema(args: GenerateSchemaArgs): Promise<number> {
  const install = detectInstallation(args.patchline);
  const serverJar = args.jar ?? install?.serverJar;
  const assetsZip = args.assets ?? install?.assetsZip;
  const java = install?.bundledJava ?? "java";

  if (!serverJar || !assetsZip) {
    process.stderr.write(
      "Need both HytaleServer.jar and Assets.zip. Pass --jar and --assets, or set HYTALE_ROOT.\n",
    );
    return 1;
  }

  if (args.dryRun) {
    process.stdout.write(
      [
        "Would run:",
        `  ${java} -jar ${serverJar} \\`,
        "    --bare --disable-sentry \\",
        `    --assets ${assetsZip} \\`,
        "    --generate-asset-schema <fresh temp directory>",
        "",
        TELEMETRY_DISCLOSURE,
        "",
      ].join("\n"),
    );
    return 0;
  }

  const consented = await askConsent({
    ...(args.yes === true ? { granted: true } : {}),
    disclosure: TELEMETRY_DISCLOSURE,
    question: "Generate asset schemas now?",
  });
  if (!consented) {
    process.stdout.write("Cancelled. Nothing was run.\n");
    return 1;
  }

  const stamp = await archiveStamp(assetsZip);
  const dbPath = frozenDbPath(frozenKey(assetsZip, stamp));
  const db = openDatabase(dbPath);
  let generatorWarnings = 0;

  try {
    const { result, value } = await withGeneratedSchemas(
      {
        serverJar,
        assetsZip,
        java,
        consent: true,
        ...(args.keep !== undefined ? { keepAt: args.keep } : {}),
        // The generator emits hundreds of routine warnings -- 437 of 444 lines on
        // the release corpus -- so echoing anything matching /WARN/ buries the
        // result it is supposed to surface. Count them, show only what a user
        // could act on.
        onLine: (line) => {
          if (/\bWARN\b/.test(line)) {
            generatorWarnings++;
            return;
          }
          if (/\bERROR\b|Exception|shutdownReason/.test(line)) {
            process.stdout.write(`  ${stripAnsi(line).trim()}\n`);
          }
        },
      },
      (outDir) => {
        const set = readGeneratedSchemas(outDir);
        return { set, ingested: ingestSchemas(db, set) };
      },
    );

    if (result.shutdownReason !== "schemaGenerated") {
      process.stderr.write(
        `Generator stopped with '${result.shutdownReason ?? "unknown reason"}' ` +
          `(exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}).\n`,
      );
      return 1;
    }

    process.stdout.write(
      [
        `Generated ${result.schemaCount} schema files in ${(result.elapsedMs / 1000).toFixed(1)}s`,
        `Ingested ${value.ingested.types} types, ` +
          `${formatCount(value.ingested.fields)} fields, ` +
          `${formatCount(value.ingested.definitions)} shared definitions`,
        `Generator warnings: ${formatCount(generatorWarnings)} (routine; the game reports` +
          ` duplicate assets and dangling block references in its own corpus)`,
        `Telemetry was sent to Hypixel Studios; this could not be disabled.`,
        args.keep === undefined ? "Temporary files removed." : `Kept at ${args.keep}`,
        "",
      ].join("\n"),
    );

    const assigned = applyTypes(db, new TypeResolver(value.set.types));
    if (assigned > 0) {
      process.stdout.write(`Typed ${formatCount(assigned)} already-indexed assets.\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export interface IndexArgs {
  readonly assets?: string;
  readonly patchline?: string;
  readonly force?: boolean;
  /** Directory produced by `--generate-asset-schema`. */
  readonly schema?: string;
  readonly dryRun?: boolean;
}

/**
 * Default location for a previously generated schema set.
 *
 * Hytale-derived and therefore gitignored. The subprocess driver that produces it
 * automatically is not built yet; until then this is where a manual run is
 * expected to land (`docs/init/05-CODEC-EXTRACTION.md`).
 */
const DEFAULT_SCHEMA_DIR = "local/schema-release";

export async function cmdIndex(args: IndexArgs): Promise<number> {
  const archivePath = await resolveArchive(args.assets, args.patchline);
  const stamp = await archiveStamp(archivePath);
  const key = frozenKey(archivePath, stamp);
  const dbPath = frozenDbPath(key);

  // --dry-run is documented as a global option and was read only by
  // generate-schema. `index --force --dry-run` therefore ran the real 40-second
  // pipeline and rewrote the cache, having promised to "print the command that
  // would run, and exit".
  if (args.dryRun) {
    process.stdout.write(
      `Would ${existsSync(dbPath) && !args.force ? "reuse" : "build"} the index:\n` +
        `  source: ${archivePath}\n` +
        `  target: ${dbPath}\n` +
        `  schema: ${args.schema ?? DEFAULT_SCHEMA_DIR}` +
        `${existsSync(args.schema ?? DEFAULT_SCHEMA_DIR) ? "" : " (absent -- assets would be untyped)"}\n` +
        (existsSync(dbPath) && !args.force ? "Already built; --force would rebuild it.\n" : ""),
    );
    return 0;
  }

  if (existsSync(dbPath) && !args.force) {
    process.stdout.write(`Index already built: ${dbPath}\nUse --force to rebuild.\n`);
    return 0;
  }
  if (args.force && existsSync(dbPath)) rmSync(dbPath, { force: true });

  process.stdout.write(
    `Indexing vanilla assets (one-time, cached globally)\n  ${archivePath}\n`,
  );

  const archive = await AssetArchive.open(archivePath);
  process.stdout.write(`  ${formatCount(archive.size)} entries\n`);

  const db = openDatabase(dbPath);
  try {
    // Schema first: it supplies the path -> type map, and an asset indexed without
    // a type cannot later be told apart from a worldgen prefab or an animation.
    let resolver: TypeResolver | undefined;
    let suffixes: string[] | undefined;
    const schemaDir = args.schema ?? DEFAULT_SCHEMA_DIR;
    if (existsSync(schemaDir)) {
      const set = readGeneratedSchemas(schemaDir);
      const ingested = ingestSchemas(db, set);
      resolver = new TypeResolver(set.types);
      suffixes = assetSuffixes(set.types);
      process.stdout.write(
        `  schema: ${ingested.types} types, ${formatCount(ingested.fields)} fields, ` +
          `${formatCount(ingested.definitions)} shared definitions\n`,
      );
      for (const warning of set.warnings) process.stdout.write(`  note: ${warning}\n`);
    } else {
      process.stdout.write(
        `  schema: not found at ${schemaDir} -- assets will be untyped (tier 1)\n`,
      );
    }

    const result = await buildSearchIndex(archive, db, {
      ...(resolver ? { types: resolver } : {}),
      ...(suffixes ? { assetSuffixes: suffixes } : {}),
      onProgress: (done, total) => {
        process.stdout.write(`\r  parsed ${formatCount(done)} / ${formatCount(total)}`);
      },
    });
    process.stdout.write("\r".padEnd(48) + "\r");

    // Pass 2 resolution: one indexed join per edge kind, now that the symbol
    // table is complete.
    const edges = resolveCandidates(db);

    // Pass 3: aggregate candidates into per-field statistics, which is what
    // gives describe_schema its observed layer and infers enums for the
    // 13,677 fields the schema declares none for.
    const stats = computeFieldStats(db);

    // Pass 4: value links -- strings whose legal values are declared elsewhere in
    // the corpus. The schema has no vocabulary for these joins, so without them
    // "what can I craft here" and "which tool gathers this" have no answer.
    const links = indexValueLinks(db);
    const benches = indexBenches(db);

    process.stdout.write(
      [
        `Indexed ${formatCount(result.assets)} assets ` +
          `(${formatCount(result.typed)} typed, ${formatCount(result.localized)} localized), ` +
          `${formatCount(result.files)} files`,
        `Edges: ${formatCount(edges.references)} references ` +
          `(${formatCount(edges.ambiguous)} low-confidence), ` +
          `${formatCount(edges.fileReferences)} to files, ` +
          `${formatCount(edges.inherits)} inherits, ` +
          `${formatCount(edges.localizedBy)} localized-by`,
        `Fields: ${formatCount(stats.rows)} observed across ${stats.typesCovered} types, ` +
          `${formatCount(stats.enumCandidates)} inferred enums, ` +
          `${formatCount(stats.schemaOnlyFields)} declared-but-unused`,
        `Unions: ${formatCount(stats.resolvedUnions)} resolved by discriminator, ` +
          `${formatCount(stats.unresolvedUnions)} left in place`,
        `Candidates: ${formatCount(edges.candidates)} recorded, ` +
          `${formatCount(edges.dangling)} unresolved`,
        ...links.map(
          (l) =>
            `Link ${l.name}: ${l.distinctValues} values from ${formatCount(l.declared)} ` +
            `declarations, ${formatCount(l.resolved)} / ${formatCount(l.references)} references resolved` +
            (l.unresolvedValues.length > 0
              ? `\n  note: ${VALUE_LINKS.find((v) => v.name === l.name)?.unresolvedMeans} -- ` +
                l.unresolvedValues.join(", ")
              : ""),
        ),
        `Benches: ${benches.benches} ids from ${benches.declarations} declarations, ` +
          `${benches.categories} categories (+${benches.nestedCategories} nested), ` +
          `${formatCount(benches.resolved)} / ${formatCount(benches.requirements)} requirements resolved` +
          (benches.duplicateIds.length > 0
            ? `\n  note: bench id declared more than once: ${benches.duplicateIds.join(", ")}`
            : "") +
          (benches.unresolvedIds.length > 0
            ? `\n  note: requirements name ${benches.unresolvedIds.length} undeclared bench id(s): ` +
              benches.unresolvedIds.join(", ")
            : ""),
        `Localization: ${result.locales.length} locales, ` +
          `${formatCount(result.langKeys)} keys, ` +
          `${formatCount(result.ftsRows)} search rows`,
        `Locales: ${result.locales.join(", ")}`,
        `Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`,
        `Cache:   ${dbPath}`,
        "",
      ].join("\n"),
    );
  } finally {
    db.close();
    archive.close();
  }
  return 0;
}

function openFrozen(assets: string | undefined, patchline: string | undefined) {
  const archivePath = assets ?? detectInstallation(patchline)?.assetsZip;
  if (!archivePath) throw new Error("Assets.zip not found; run with --assets <path>.");
  return archivePath;
}

async function frozenDb(assets: string | undefined, patchline: string | undefined) {
  const archivePath = openFrozen(assets, patchline);
  const dbPath = frozenDbPath(frozenKey(archivePath, await archiveStamp(archivePath)));
  if (!existsSync(dbPath)) {
    throw new Error(`No index yet. Run 'hytale-atlas index' first.\n  expected: ${dbPath}`);
  }
  return openDatabase(dbPath, { readOnly: true });
}

/**
 * One line describing the cached index, read from the cache itself.
 *
 * `status` used to print a constant -- "not built (indexing is not implemented
 * yet)" -- which stayed there long after indexing worked. Every other command
 * contradicted it, so the first thing a new user saw was the tool calling itself
 * broken. Never state capability from a literal when the artifact can be read.
 */
export async function indexSummary(
  assets: string | undefined,
  patchline: string | undefined,
): Promise<string> {
  let dbPath: string;
  try {
    const archivePath = openFrozen(assets, patchline);
    dbPath = frozenDbPath(frozenKey(archivePath, await archiveStamp(archivePath)));
  } catch {
    return "no Assets.zip, nothing to index";
  }
  if (!existsSync(dbPath)) return "not built — run 'hytale-atlas index'";

  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const one = (sql: string): number =>
      Number((db.prepare(sql).get() as Record<string, unknown> | undefined)?.["n"] ?? 0);
    const assets = one("SELECT count(*) AS n FROM assets");
    const typed = one("SELECT count(*) AS n FROM assets WHERE type IS NOT NULL");
    const declared = one("SELECT count(*) AS n FROM schema_fields");
    const joined = one(
      `SELECT count(*) AS n FROM field_stats fs
        JOIN schema_fields sf ON sf.asset_type = fs.asset_type
                             AND sf.json_pointer = fs.json_pointer`,
    );
    const observed = one("SELECT count(*) AS n FROM field_stats");
    // Coverage is stated because --help promised it and the line did not carry
    // it, and because both numbers are the honest caveat on every negative this
    // tool gives: an unjoined field reads as unused when it may only be unmatched.
    return (
      `${formatCount(assets)} assets ` +
      `(${formatCount(typed)} typed, ${Math.round((typed / Math.max(assets, 1)) * 100)}%), ` +
      `${formatCount(declared)} schema fields, ` +
      `${formatCount(one("SELECT count(*) AS n FROM edges"))} edges, ` +
      `${one("SELECT count(DISTINCT locale) AS n FROM lang_keys")} locales\n` +
      `             observed/declared join: ${formatCount(joined)} of ` +
      `${formatCount(observed)} observed fields match a declared one ` +
      `(${Math.round((joined / Math.max(observed, 1)) * 100)}%)\n` +
      `             epoch ${one("SELECT CAST(ifnull(value,'0') AS INTEGER) AS n FROM meta WHERE key = 'epoch'")}` +
      `   ${dbPath}`
    );
  } catch (err) {
    return `unreadable (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    db.close();
  }
}

export async function cmdSearch(
  query: string,
  args: { assets?: string; patchline?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const { value: hits, caveats } = searchAssetsOp(db, query, args.limit ?? 20);
    if (hits.length === 0) {
      // Said "No matches." and stopped, which reads as "this string appears
      // nowhere". It indexes identifiers and localized names, not field VALUES:
      // searching a sound-set id returned the set itself and none of the three
      // items referencing it, and searching a literal interaction value returned
      // nothing at all. Both agents inferred the limitation from repeated empty
      // results rather than being told.
      process.stdout.write(
        `No asset is named "${query}", in any indexed locale.\n\n` +
          // Wording comes from the operation layer, so the MCP server states the
          // same limitation rather than a paraphrase of it.
          `${caveats.map((c) => c.message).join("\n")}\n\n`.replace(
            "not field values.",
            "NOT field values.",
          ) +
          `  hytale-atlas refs ${query.split(/\s+/)[0]}    what references that asset\n` +
          "  hytale-atlas search-schema <words>   where a capability is declared\n",
      );
      return 1;
    }
    // The asset type is printed, not just the id. Searching "pickaxe" returns
    // Goblin_Pickaxe and Outlander_Pickaxe, which are ItemPlayerAnimations rather
    // than items -- without the type they are indistinguishable from real tools
    // and cost a `get` each to rule out.
    for (const hit of hits) {
      const relaxed = hit.relaxation > 0 ? `  ~${hit.relaxation}` : "";
      process.stdout.write(
        `${hit.logicalId.padEnd(36)} ${(hit.type ?? "(untyped)").padEnd(22)} ` +
          `[${hit.locale}] ${hit.displayName}${relaxed}\n`,
      );
    }
    renderCaveats(caveats);
  } finally {
    db.close();
  }
  return 0;
}

/**
 * Prints an asset's effective definition, with the parent chain resolved.
 *
 * The only high-token command, and the tool description must say so: everything
 * else returns summaries (`docs/init/04-MCP-SURFACE.md` Context discipline).
 */
export async function cmdGet(
  logicalId: string,
  args: { assets?: string; patchline?: string; raw?: boolean; type?: string },
): Promise<number> {
  const archivePath = openFrozen(args.assets, args.patchline);
  const db = await frozenDb(args.assets, args.patchline);
  const archive = await AssetArchive.open(archivePath);

  try {
    // `--type` picks among same-named assets; without it the first effective one
    // wins.
    //
    // The ORDER BY must match the disambiguation note's exactly. It did not: the
    // note ordered by (is_effective, type) and the loader by is_effective alone,
    // leaving SQLite to break the tie by rowid. So `get Plant_Bush` announced
    // "Showing the Item one" and then printed the ItemDropList -- handing over the
    // wrong file while stating the right one.
    const PICK_ORDER = "ORDER BY is_effective DESC, type";
    const byId = db.prepare(
      "SELECT path, type FROM assets WHERE logical_id = ?1" +
        ` AND (?2 IS NULL OR type = ?2) ${PICK_ORDER} LIMIT 1`,
    );

    // Identifiers are not unique across types. `get Pickaxe_Mine` returned a
    // CameraEffect to an agent chasing an Interaction, with nothing to say a
    // choice had been made -- so it concluded the interaction chain was broken.
    const sameName = db
      .prepare(`SELECT type, path FROM assets WHERE logical_id = ? ${PICK_ORDER} LIMIT 8`)
      .all(logicalId) as unknown as { type: string | null; path: string }[];
    if (sameName.length > 1 && args.type === undefined) {
      process.stderr.write(
        `note: ${sameName.length} assets are named '${logicalId}'. Showing the ` +
          `${sameName[0]!.type ?? "untyped"} one.\n` +
          sameName
            .slice(1)
            .map((s) => `      also: ${s.type ?? "untyped"}  ${s.path}\n`)
            .join(""),
      );
    }

    const load: AssetLoader = async (id) => {
      const row = byId.get(id, args.type ?? null) as
        | { path: string; type: string | null }
        | undefined;
      if (row === undefined) return null;
      try {
        return { path: row.path, type: row.type, document: JSON.parse(await archive.readText(row.path)) };
      } catch {
        return null;
      }
    };

    const resolved = await resolveAsset(db, logicalId, load);
    if (resolved === null) {
      // Advice that actually works. The old message suggested searching for the
      // string as typed, which for a `Type:Id` guess meant searching for a
      // syntax that does not exist -- circular, and it sent a reader looking for
      // a disambiguation feature under the wrong command.
      if (args.type !== undefined && sameName.length > 0) {
        process.stderr.write(
          `No '${logicalId}' of type '${args.type}'. It exists as: ` +
            `${sameName.map((s) => s.type ?? "untyped").join(", ")}\n`,
        );
      } else if (logicalId.includes(":")) {
        const [maybeType, ...rest] = logicalId.split(":");
        process.stderr.write(
          `No asset '${logicalId}'. Identifiers carry no namespace here.\n` +
            `Did you mean: hytale-atlas get ${rest.join(":")} --type ${maybeType}\n`,
        );
      } else {
        process.stderr.write(
          `No asset '${logicalId}'. Try 'hytale-atlas search ${logicalId}'.\n`,
        );
      }
      return 1;
    }

    if (args.raw) {
      process.stdout.write(`${JSON.stringify(resolved.effective, null, 2)}\n`);
      return 0;
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

    const inherited = resolved.origins.filter((o) => o.via !== "declared");
    if (inherited.length > 0) {
      header.push(
        `  ${inherited.length} field(s) come from ancestors; the file on disk declares fewer`,
      );
    }
    process.stdout.write(`${header.join("\n")}\n\n`);
    process.stdout.write(`${JSON.stringify(resolved.effective, null, 2)}\n`);
    return 0;
  } finally {
    archive.close();
    db.close();
  }
}

/** Renders both schema layers for one asset type, or one field of it. */
/**
 * Benches, or what a named bench crafts.
 *
 * The reverse lookup `Recipe.BenchRequirement[].Id` could not answer before,
 * because those ids name benches rather than assets and nothing joined the two.
 */
export async function cmdBench(
  benchId: string | undefined,
  args: { assets?: string; patchline?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    if (benchId === undefined) {
      const rows = db
        .prepare(
          `SELECT b.id, b.bench_type,
                  (SELECT group_concat(a.logical_id, ', ') FROM bench_declarations d
                     JOIN assets a ON a.id = d.asset_id WHERE d.bench_id = b.id) declared_by,
                  (SELECT count(*) FROM bench_categories c WHERE c.bench_id = b.id) cats,
                  (SELECT count(*) FROM bench_requirements r WHERE r.bench_id = b.id) reqs
             FROM benches b
            ORDER BY reqs DESC`,
        )
        .all() as unknown as {
        id: string;
        bench_type: string | null;
        declared_by: string | null;
        cats: number;
        reqs: number;
      }[];
      // Headed, and the key column is named. Two ids sit on every row and only
      // one of them works anywhere: 'Workbench' is what `bench <id>` takes AND
      // what a recipe's BenchRequirement.Id must say, while 'Bench_WorkBench' is
      // the asset that declares it. An agent reading the unlabelled form assumed
      // the rightmost token was the key and would have written the wrong id into
      // a recipe, where it fails silently at runtime.
      process.stdout.write(
        `${"BENCH ID".padEnd(18)} ${"TYPE".padEnd(18)} ${"RECIPES".padStart(7)} ` +
          `${"CAT".padStart(3)}  DECLARED BY\n` +
          `${"(use this)".padEnd(18)} ${"".padEnd(18)} ${"".padStart(7)} ` +
          `${"".padStart(3)}  (the asset, not the id)\n\n`,
      );
      for (const r of rows) {
        process.stdout.write(
          `${r.id.padEnd(18)} ${String(r.bench_type ?? "?").padEnd(18)} ` +
            `${String(r.reqs).padStart(7)} ${String(r.cats).padStart(3)}  ` +
            `${r.declared_by ?? ""}\n`,
        );
      }
      return 0;
    }

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

    const items = craftableAt(db, benchId, args.limit ?? 200);
    if (categories.length === 0 && items.length === 0) {
      // The most likely mistake is passing the declaring asset instead of the
      // bench id, so name the right one rather than only rejecting the wrong one.
      const viaAsset = db
        .prepare(
          `SELECT d.bench_id FROM bench_declarations d JOIN assets a ON a.id = d.asset_id
            WHERE a.logical_id = ? LIMIT 1`,
        )
        .get(benchId) as Record<string, unknown> | undefined;
      process.stderr.write(
        viaAsset
          ? `'${benchId}' is the asset that declares a bench, not the bench id.\n` +
              `Use: hytale-atlas bench ${viaAsset["bench_id"]}\n` +
              `(that same id is what a recipe's BenchRequirement.Id must carry)\n`
          : `No bench '${benchId}'. Run 'hytale-atlas bench' to list them.\n`,
      );
      return 1;
    }

    for (const c of categories) {
      const indent = c.parent_id === null ? "  " : "      ";
      process.stdout.write(
        `${indent}${c.category_id.padEnd(26 - indent.length)} ${c.value ?? c.name_key ?? ""}\n`,
      );
    }
    process.stdout.write(`\n${formatCount(items.length)} craftable here:\n`);
    let current: string | null | undefined;
    for (const it of items) {
      if (it.category !== current) {
        current = it.category;
        process.stdout.write(`\n  [${current ?? "no category"}]\n`);
      }
      process.stdout.write(`    ${it.logicalId}\n`);
    }
    process.stdout.write("\n");
    return 0;
  } finally {
    db.close();
  }
}

/**
 * What references an asset -- the inbound half of the graph.
 *
 * The index built 162 899 edges and exposed none of them. `status` reported the
 * count, so the graph was visibly there and unreachable, and the only substitute
 * was `search`, which indexes NAMES rather than values: searching for a sound-set
 * id returned the set itself and none of the three items that reference it, with
 * no indication anything was missing. A clean single result for a widely-used
 * value functionally asserts "nothing else uses this", which was false.
 */
export async function cmdRefs(
  logicalId: string,
  args: { assets?: string; patchline?: string; type?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const { value, caveats } = refsOp(db, logicalId, args.type, args.limit ?? 40);

    if (value.targets.length === 0) {
      // Not every string is an asset. `search-schema` says "use refs <id>" for a
      // value list, but a bench category or a bench id is a plain string nested in
      // another asset's field -- so `refs Workbench_Tools` failed and suggested
      // `search`, which suggested `refs` back. Two commands handing off to each
      // other, neither able to say the thing is not an asset at all.
      const asValue = db
        .prepare(
          `SELECT c.schema_scope, c.schema_pointer, count(*) AS n
             FROM candidates c
            WHERE c.raw_value = ? AND c.schema_scope IS NOT NULL
            GROUP BY c.schema_scope, c.schema_pointer
            ORDER BY n DESC LIMIT 3`,
        )
        .all(logicalId) as unknown as {
        schema_scope: string;
        schema_pointer: string;
        n: number;
      }[];

      if (asValue.length > 0) {
        const total = asValue.reduce((sum, r) => sum + r.n, 0);
        process.stderr.write(
          `'${logicalId}' is not an asset. ${formatCount(total)} assets carry it as a VALUE:\n` +
            asValue
              .map((r) => `  ${formatCount(r.n)}x  ${r.schema_scope} :: ${r.schema_pointer}\n`)
              .join("") +
            "\nReferences track asset ids. For a value like this, describe the field\n" +
            `that holds it: hytale-atlas describe ${asValue[0]!.schema_scope} ` +
            `--field ${asValue[0]!.schema_pointer}\n`,
        );
        return 1;
      }

      process.stderr.write(
        `No asset '${logicalId}'${args.type ? ` of type '${args.type}'` : ""}, ` +
          "and nothing carries it as a value.\n" +
          `Try 'hytale-atlas search ${logicalId}'.\n`,
      );
      return 1;
    }

    // A bench is referenced by the id it DECLARES, not by the id of the asset
    // declaring it, so `refs Bench_WorkBench` returned one unrelated edge while 49
    // recipes required that bench. Say so rather than let a complete-looking
    // answer stand.
    const declares = benchDeclaredBy(db, logicalId);
    if (declares !== null) {
      process.stdout.write(
        `note: this asset declares the bench id '${declares}'. Recipes reference that\n` +
          `      id rather than this asset, so they are NOT listed below.\n` +
          `      Use: hytale-atlas bench ${declares}\n\n`,
      );
    }

    if (value.total === 0) {
      process.stdout.write(`Nothing references '${logicalId}'.\n`);
    } else {
      process.stdout.write(`${formatCount(value.total)} references to '${logicalId}':\n\n`);
      for (const r of value.references) {
        process.stdout.write(
          `${r.confidence.padEnd(7)} ${r.logicalId.padEnd(34)} ` +
            `${(r.type ?? "(untyped)").padEnd(20)} ${r.kind} ${r.pointer ?? ""}\n`,
        );
      }
    }

    // Confidence is not decoration. A declared reference is a fact the schema
    // states; a heuristic one is a name that happens to collide, and 'Stone'
    // collides with a great many things.
    process.stdout.write(
      "\nhigh   = declared by the schema, or inheritance the engine resolves itself\n" +
        "medium = the field name follows a reference convention\n" +
        "low    = the value merely collides with an identifier; often coincidence\n",
    );
    renderCaveats(caveats);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdLang(
  query: string,
  args: { assets?: string; patchline?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const { value: entries, caveats } = langOp(db, query, args.limit ?? 20);
    if (entries.length === 0) {
      process.stdout.write(
        `No localization key or value matches "${query}".\n\n` +
          "Keys are stored WITHOUT their root: an asset referencing\n" +
          "'server.items.Foo.name' is stored as 'items.Foo.name'. Both forms are\n" +
          "accepted here, so this is a real miss rather than a prefix problem.\n",
      );
      return 1;
    }
    for (const entry of entries) {
      process.stdout.write(`${entry.key}\n`);
      for (const t of entry.translations) {
        process.stdout.write(`    ${t.locale.padEnd(7)} ${t.value}\n`);
      }
      for (const u of entry.usedBy) {
        process.stdout.write(`    used by ${u.logicalId} ${u.pointer ?? ""}\n`);
      }
      // Said rather than left blank: a key with no inbound edge is normal (UI
      // text, or referenced by something the index does not type), and silence
      // would read as "nothing uses this".
      if (entry.usedBy.length === 0) {
        process.stdout.write("    used by nothing indexed (UI text, or referenced dynamically)\n");
      }
    }
    renderCaveats(caveats);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdDescribe(
  assetType: string,
  args: { assets?: string; patchline?: string; field?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const field = args.field === undefined ? undefined : normalizeFieldPointer(args.field);
    if (args.field !== undefined && looksMangled(args.field)) {
      process.stderr.write(
        `note: your shell rewrote the pointer to '${args.field}'. ` +
          `Reading it as '${field}'.\n` +
          `      Under Git Bash, write --field ${field?.slice(1)} without the leading slash.\n`,
      );
    }

    // A type that is nothing but a union of branches has no fields of its own, so
    // describing it printed a wall of `UNDECLARED` observed-only rows -- while
    // `describe common:ApplyEffectInteraction` showed the same fields fully
    // declared. Two commands contradicting each other, and the "did you mean"
    // steered readers toward the worse view. The schema states the branches and
    // the discriminator; print those instead.
    const union = db
      .prepare(
        `SELECT ref_scope, discriminator_property, discriminator_values
           FROM schema_fields
          WHERE asset_type = ? AND json_pointer = '' AND ref_scope IS NOT NULL`,
      )
      .get(assetType) as Record<string, unknown> | undefined;

    if (union !== undefined && field === undefined) {
      const branches = String(union["ref_scope"] ?? "").split(" ").filter(Boolean);
      const values = String(union["discriminator_values"] ?? "").split(" ").filter(Boolean);
      const property = (union["discriminator_property"] as string | null) ?? "Type";
      process.stdout.write(
        `'${assetType}' is a union of ${branches.length} shapes, chosen by the ` +
          `'${property}' field.\nIt declares no field of its own -- describe a branch ` +
          `to see fields.\n\n`,
      );
      const width = Math.max(...values.map((v) => v.length), 8);
      for (const [i, branch] of branches.entries()) {
        process.stdout.write(`${(values[i] ?? "?").padEnd(width)}  hytale-atlas describe ${branch}\n`);
      }
      process.stdout.write(
        `\nThose ${values.length} values are the complete legal set for '${property}' here: ` +
          `the schema declares them, they are not inferred from the corpus.\n`,
      );
      return 0;
    }

    const fields = describeSchema(db, assetType, field);
    if (fields.length === 0) {
      // Order matters. Checking the type first reported a missing FIELD as a
      // missing TYPE, producing "No type 'Item'. Did you mean: describe Item" --
      // a suggestion identical to what had just been typed.
      const typeExists =
        (
          db
            .prepare("SELECT count(*) AS n FROM schema_fields WHERE asset_type = ?")
            .get(assetType) as Record<string, unknown>
        )["n"] !== 0;

      if (typeExists && field !== undefined) {
        // Walk up the pointer to find the deepest prefix that does exist, which
        // is usually where the user's mental model and the schema diverge.
        let probe = field;
        let near: string[] = [];
        while (probe.length > 1 && near.length === 0) {
          near = pointersLike(db, assetType, probe);
          if (near.length === 0) probe = probe.slice(0, probe.lastIndexOf("/")) || "/";
        }
        process.stderr.write(
          `'${assetType}' has no field '${field}'.\n` +
            (near.length > 0
              ? `Nearest declared:\n` + near.map((p) => `  ${p}\n`).join("")
              : `Run 'hytale-atlas describe ${assetType}' to list its fields.\n`),
        );
        return 1;
      }

      // Shared definitions live in a namespace, and which types need one is not
      // guessable: ItemToolSpec and CraftingRecipe do not, ItemTool and
      // BenchRequirement do. Suggestions go both ways, because both mistakes
      // happen: adding a prefix that does not belong, and omitting one that does.
      const bare = assetType.includes(":") ? assetType.slice(assetType.indexOf(":") + 1) : null;
      const alternatives = db
        .prepare(
          `SELECT DISTINCT asset_type FROM schema_fields
            WHERE asset_type LIKE '%:' || ?1 OR asset_type = ?2
            ORDER BY asset_type LIMIT 5`,
        )
        .all(assetType, bare ?? NO_SUCH_TYPE) as unknown as { asset_type: string }[];

      if (alternatives.length > 0) {
        process.stderr.write(
          `No type '${assetType}'. Did you mean:\n` +
            alternatives
              .map((a) => `  hytale-atlas describe ${a.asset_type}${field ? ` --field ${field}` : ""}\n`)
              .join(""),
        );
      } else {
        process.stderr.write(
          `No type '${assetType}'. Try: hytale-atlas search-schema "${assetType}"\n`,
        );
      }
      return 1;
    }
    const limit = args.limit ?? 60;
    for (const f of fields.slice(0, limit)) {
      const d = f.declared;
      const o = f.observed;
      // A container holds no scalar of its own, so it can never appear in the
      // observed layer however heavily it is used. Calling that "unused" was a
      // false claim about the corpus dressed as a finding -- see isContainer().
      const container = isContainer(d?.type ?? null);
      const flags = [
        d?.optional === false ? "required" : null,
        d?.inheritsProperty ? "inherits" : null,
        d?.mergesProperties ? "merges" : null,
        d?.referenceTarget ? `-> ${d.referenceTarget}` : null,
        d === null ? "UNDECLARED" : null,
        o === null ? (container ? "(container)" : "unused") : null,
      ].filter(Boolean);

      process.stdout.write(
        `${f.pointer.padEnd(46)} ${String(d?.type ?? "?").padEnd(16)} ${flags.join(" ")}\n`,
      );
      if (d?.title) process.stdout.write(`    ${d.title}\n`);
      if (d?.description) {
        process.stdout.write(
          // A single-field request is already the narrowed view, so there is
          // nothing to protect the reader from: print all of it.
          `    ${args.field === undefined ? clip(d.description, 140) : d.description.replace(/\s+/g, " ").trim()}\n`,
        );
      }
      // Declared enums are the complete legal set; observed values are only what
      // vanilla happens to use. Labelled differently on purpose.
      if (d?.enumValues) {
        process.stdout.write(`    legal: ${d.enumValues.join(", ")}\n`);
      } else if (o?.values) {
        // Says how many of how many. The list was cut at 14 in silence, so a
        // field with 21 real bench ids showed 14 of them, ending mid-alphabet at
        // `Furniture_Bench` and never reaching `Workbench` -- readable as the
        // complete set by anyone who did not already know better.
        const shown = args.field === undefined ? o.values.slice(0, 14) : o.values;
        process.stdout.write(`    seen:  ${shown.join(", ")}\n`);
        if (shown.length < o.cardinality) {
          process.stdout.write(
            `           (${shown.length} of ${formatCount(o.cardinality)} distinct` +
              `${args.field === undefined ? "; use --field for the rest" : ""})\n`,
          );
        }
      }
      if (o) {
        process.stdout.write(
          `    used in ${formatCount(o.assets)} assets` +
            (o.targetTypes ? `, points at ${o.targetTypes.join("/")}` : "") + "\n",
        );
        // Above the enum threshold the values are not stored, so the line simply
        // vanished -- no list, no count, no caveat, while a neighbouring field
        // with 33 values printed all of them. Two agents independently read the
        // silence as "this field has no values", on the two fields that mattered
        // most to them: MaterialQuantity/ItemId (1,194 uses) and
        // ApplyEffectInteraction/EffectId (123 uses).
        if (o.values === null && o.cardinality > 0 && d?.enumValues == null) {
          process.stdout.write(
            `    ${formatCount(o.cardinality)} distinct values -- too many to list. ` +
              `Use 'refs <id>' to ask the\n    reverse question: which assets name a ` +
              `particular one.\n`,
          );
        }
      } else if (container && args.field !== undefined) {
        // Absence here means nothing, and saying nothing invited the opposite
        // reading: a sibling container that HAD been used as a string reference
        // showed usage, so this one looked genuinely unused, and
        // `find_undocumented` -- which excludes containers -- did not list it
        // either. Two consistent outputs that read as a contradiction.
        process.stdout.write(
          "    no observed values: this is a container, and only scalar leaves are\n" +
            "    counted. Absence here says nothing about whether the corpus uses it.\n",
        );
      }
    }
    if (fields.length > limit) {
      // Naming the flag matters: the earlier message printed only the total, so a
      // reader had no way to know the rest was reachable and concluded the type
      // simply stopped mid-alphabet.
      process.stdout.write(
        `\n... showing ${limit} of ${formatCount(fields.length)} fields. ` +
          `Use --limit ${fields.length} for all, or --field <pointer> for one.\n`,
      );
    }
    // The observed layer counts what files LITERALLY contain. `get` resolves the
    // parent chain first. So a field every crop appears to set can show two
    // occurrences here, because the other crops inherit it -- and an agent
    // reasonably read that as this command being wrong.
    if (fields.some((f) => f.observed !== null)) {
      process.stdout.write(
        "\n'used in N assets' counts files that declare the field themselves.\n" +
          "'get' resolves inheritance first, so it can show a value on assets that\n" +
          "are not counted here.\n",
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/** Searches the schema itself: where does a capability live, and does it exist. */
export async function cmdSearchSchema(
  query: string,
  args: { assets?: string; patchline?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const { value: hits, caveats } = searchSchemaOp(db, query, args.limit ?? 20);
    if (hits.length === 0) {
      // "That is itself an answer: nothing declares this capability" was a
      // semantic claim drawn from a lexical match. The hedge now travels as a
      // caveat, so an MCP client receives the same qualification rather than a
      // paraphrase of it.
      process.stdout.write(`No schema field matches "${query}".\n\n`);
      renderCaveats(caveats);
      process.stdout.write(
        "\nBefore concluding it does not exist:\n" +
          "  - try the words the game might use instead (Radius, Shape, Extent)\n" +
          "  - list the types that would own it: describe <Type> --limit 200\n" +
          "  - check for declared-but-unused fields: undocumented <Type>\n",
      );
      return 1;
    }
    // A loosened match is a different kind of answer and must not look like an
    // exact one, so the caveat is printed BEFORE the rows rather than after.
    const relaxed = caveats.filter((c) => c.code === "relaxed");
    if (relaxed.length > 0) {
      process.stdout.write(`${relaxed.map((c) => c.message).join("\n")}\n\n`);
    }
    for (const h of hits) {
      process.stdout.write(`${(h.assetType + h.pointer).padEnd(56)} ${h.title ?? ""}\n`);
      if (h.description) {
        process.stdout.write(`    ${clip(h.description, 130)}\n`);
      }
    }
    renderCaveats(caveats.filter((c) => c.code !== "relaxed"));
    return 0;
  } finally {
    db.close();
  }
}

/** Fields the schema permits that no vanilla asset uses. */
export async function cmdUndocumented(args: {
  assets?: string;
  patchline?: string;
  type?: string;
  limit?: number;
}): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    // A type name is checked before it is used, because the two outcomes this
    // command conflates are the two a reader most needs told apart: "this type
    // has nothing unused" and "you misspelled the type". Both printed the same
    // sentence and exited 0, and `search-schema` sends people here specifically
    // to firm up a negative -- so a typo returned a confident, wrong answer.
    if (args.type !== undefined) {
      const declared = Number(
        (
          db
            .prepare("SELECT count(*) AS n FROM schema_fields WHERE asset_type = ?")
            .get(args.type) as Record<string, unknown>
        )["n"],
      );
      if (declared === 0) {
        const bare = args.type.includes(":") ? args.type.slice(args.type.indexOf(":") + 1) : null;
        const alternatives = (
          db
            .prepare(
              `SELECT DISTINCT asset_type FROM schema_fields
                WHERE asset_type LIKE '%:' || ?1 OR asset_type = ?2
                ORDER BY asset_type LIMIT 5`,
            )
            .all(args.type, bare ?? " none") as unknown as { asset_type: string }[]
        ).map((a) => a.asset_type);
        process.stderr.write(
          `No type '${args.type}' in the schema.\n` +
            (alternatives.length > 0
              ? `Did you mean:\n` + alternatives.map((a) => `  ${a}\n`).join("")
              : `Try: hytale-atlas search-schema "${args.type}"\n`),
        );
        return 1;
      }
      const fields = findUndocumented(db, args.type, args.limit ?? 40);
      if (fields.length === 0) {
        process.stdout.write(
          `'${args.type}' declares ${formatCount(declared)} fields and every one of ` +
            `them appears in at least one vanilla asset.\n` +
            `Nothing here is unused. (The type exists -- this is a real negative, ` +
            `not a name that failed to resolve.)\n`,
        );
        return 0;
      }
    }

    const undocumented = undocumentedOp(db, args.type, args.limit ?? 40);
    const fields = undocumented.value.fields;
    process.stdout.write(
      `Fields the schema permits that appear in zero vanilla assets` +
        `${args.type ? `, scoped to ${args.type}` : ""}.\n` +
        "These are leads, not features: a field may be deprecated, engine-internal,\n" +
        "set programmatically rather than from JSON, or a debug hook.\n" +
        // Stated because the alternative is a false negative presented as a
        // finding. Under half of declared fields currently join their observed
        // counterpart, so absence here is weaker evidence than it reads as.
        // The join figure comes from the operation layer, measured rather than
        // written down, so it cannot drift from reality or from what MCP reports.
        `AND it may simply have failed to join:\n${undocumented.caveats
          .filter((c) => c.code === "join-incomplete")
          .map((c) => `  ${c.message}`)
          .join("\n")}\n` +
        "Treat this list as a starting point and confirm with\n" +
        "'describe <Type> --field <pointer>'.\n\n",
    );
    if (fields.length === 0) {
      // Only reachable unscoped now; the scoped case is answered above, where the
      // type is known to exist and the negative can be stated as a fact.
      process.stdout.write("None across the whole schema.\n");
      return 0;
    }
    for (const f of fields) {
      process.stdout.write(
        `${(f.assetType + f.pointer).padEnd(56)} ${f.declaredType ?? ""}` +
          `${f.referenceTarget ? ` -> ${f.referenceTarget}` : ""}\n`,
      );
      if (f.description) {
        process.stdout.write(`    ${clip(f.description, 130)}\n`);
      }
    }
    renderCaveats(undocumented.caveats.filter((c) => c.code === "truncated"));
    return 0;
  } finally {
    db.close();
  }
}

interface EvalCase {
  readonly phrase: string;
  readonly tier: string;
  readonly locale?: string;
  readonly overlap?: string;
  readonly expected_any: readonly string[];
  /** Assets that must appear too, for disambiguation cases. */
  readonly expected_also?: readonly string[];
  /** Assets that must not be the top result -- noise, prototypes, test fixtures. */
  readonly must_not_rank_first?: readonly string[];
}

/**
 * Runs the search evaluation set.
 *
 * Reports recall@5 **per tier**, never as one number: the aggregate is dominated
 * by `lexical-id`, which passes under every configuration, and would mask total
 * failure on `lexical-name` -- the tier the whole localization design rests on.
 */
export async function cmdEval(args: {
  assets?: string;
  patchline?: string;
  set?: string;
}): Promise<number> {
  const setPath = args.set ?? "docs/evaluation/search-phrases.json";
  const cases = (JSON.parse(readFileSync(setPath, "utf8")) as { cases: EvalCase[] }).cases;

  const db = await frozenDb(args.assets, args.patchline);
  try {
    const byTier = new Map<string, { pass: number; total: number; failures: string[] }>();

    for (const c of cases) {
      if (c.expected_any.length === 0) continue; // labelling-only cases
      const hits = searchAssets(db, c.phrase, { limit: 5 });
      const ids = hits.map((h) => h.logicalId);

      // A case passes only if it satisfies every constraint it declares. Checking
      // recall alone overstated noise-rejection, which exists precisely to catch a
      // real asset being outranked rather than merely absent.
      const reasons: string[] = [];
      if (!ids.some((id) => c.expected_any.includes(id))) {
        reasons.push(`expected ${c.expected_any[0]}`);
      }
      // `expected_also` means "the other sense must also surface", so ANY of the
      // listed assets satisfies it. Requiring all of them tested something else
      // entirely -- that one family occupies most of the page -- which is the
      // opposite of what a disambiguation case is for.
      const also = c.expected_also ?? [];
      if (also.length > 0 && !also.some((id) => ids.includes(id))) {
        reasons.push(`second sense missing (any of ${also.slice(0, 2).join(", ")})`);
      }
      const top = ids[0];
      if (top !== undefined && (c.must_not_rank_first ?? []).includes(top)) {
        reasons.push(`noise ranked first: ${top}`);
      }

      const bucket = byTier.get(c.tier) ?? { pass: 0, total: 0, failures: [] };
      bucket.total++;
      if (reasons.length === 0) bucket.pass++;
      else bucket.failures.push(`${c.phrase}  ->  ${reasons.join("; ")}`);
      byTier.set(c.tier, bucket);
    }

    process.stdout.write("recall@5 by tier\n");
    let totalPass = 0;
    let total = 0;
    for (const [tier, r] of [...byTier].sort()) {
      totalPass += r.pass;
      total += r.total;
      const pct = ((r.pass / r.total) * 100).toFixed(0).padStart(3);
      process.stdout.write(`  ${tier.padEnd(22)} ${String(r.pass).padStart(2)}/${r.total}  ${pct}%\n`);
    }
    process.stdout.write(`  ${"(all)".padEnd(22)} ${totalPass}/${formatCount(total)}\n`);

    const failed = [...byTier].filter(([, r]) => r.failures.length > 0);
    if (failed.length > 0) {
      process.stdout.write("\nfailures\n");
      for (const [tier, r] of failed) {
        for (const f of r.failures) process.stdout.write(`  [${tier}] ${f}\n`);
      }
    }
    return totalPass === total ? 0 : 1;
  } finally {
    db.close();
  }
}

