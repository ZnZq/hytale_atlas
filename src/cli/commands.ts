import { existsSync, readFileSync, rmSync } from "node:fs";

import { openDatabase, setMeta } from "../db/open.ts";
import { PIPELINE_VERSION } from "../db/schema.ts";
import { buildSearchIndex } from "../indexer/corpus.ts";
import { indexBenches } from "../indexer/benches.ts";
import { VALUE_LINKS, indexValueLinks } from "../indexer/value-links.ts";
import { resolveCandidates } from "../indexer/references.ts";
import { computeFieldStats } from "../indexer/stats.ts";
import { TypeResolver, applyTypes, assetSuffixes, ingestSchemas } from "../indexer/schema.ts";
import type { AssetLoader } from "../query/asset.ts";
import { searchAssets } from "../query/search.ts";
import { findUndocumented } from "../query/schema.ts";
import { AssetArchive, archiveStamp } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { TELEMETRY_DISCLOSURE, withGeneratedSchemas } from "../sources/schema-gen.ts";
import { readGeneratedSchemas } from "../sources/schema-doc.ts";
import {
  benchOp,
  benchesOp,
  declaredCount,
  describeOp,
  getAssetOp,
  undeclaredObserved,
  langOp,
  refsAnyOp,
  searchAssetsOp,
  assetsOfType,
  searchSchemaOp,
  typeAlternatives,
  typesOp,
  undocumentedOp,
} from "../api/operations.ts";
import { caveatBlock } from "../api/types.ts";
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
 * Shortens prose for a list, and says so when it does.
 *
 * Silent truncation is the failure this whole surface keeps making in different
 * costumes. Here it cut a field description mid-word with no ellipsis and no
 * flag to disable it, and the cut sentence was the one that would have settled
 * whether an area-mining primitive exists. The row-count truncation next to it
 * announced itself correctly, which made the inconsistency worse.
 */

/**
 * The next commands worth running, chosen from what the token actually is.
 *
 * One suggester for every miss, reading one classification (`identify`). Each
 * command used to decide this for itself from a single fact, and the results
 * contradicted both each other and the prose they sat under: `search` withheld
 * `refs` from the value case its own sentence was about, `refs` and `search`
 * pointed at each other with no exit, and neither ever named `search-lang` for a
 * localization key or `bench` for a bench id.
 *
 * Ordered by how likely the token is to be that thing, and every line is a
 * command that returns something for this exact token -- a suggestion that
 * misses is worse than none, because it reads as a verdict.
 */
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
        // --keep changes what happens after the run, and the dry run said
        // nothing about it while printing a disclosure that ends "deleted
        // afterwards" -- the very outcome --keep exists to prevent. The command
        // line is identical either way (the generator WIPES its output directory
        // before writing, so it is never pointed at a caller's path), and that
        // is exactly why the copy step has to be stated here.
        ...(args.keep !== undefined
          ? [
              `Then: copy the generated Schema/ out to ${args.keep}`,
              "(the generator wipes its own output directory before writing, so it is",
              " never pointed at that path -- the files are copied there afterwards)",
              "",
            ]
          : []),
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
  // The write-ahead log and shared-memory file are part of the database, not
  // scratch beside it: deleting only the main file leaves SQLite to reconcile a
  // fresh database against a stale WAL. Removed together, in that order.
  if (args.force && existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm", ""]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }

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

    // The completion marker, written last and only here. Everything above this
    // line commits separately, so any earlier failure leaves a database that
    // opens cleanly and is wrong. Readers check this key, not the file.
    setMeta(db, "pipeline", String(PIPELINE_VERSION));

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
    // Excludes the empty-pointer TYPE rows, like every other count in the
    // project. `status` said 18,396 while `undocumented` said 17,400 about the
    // same thing, and the 996 difference is types, not fields.
    const declared = one(
      "SELECT count(*) AS n FROM schema_fields WHERE json_pointer <> ''",
    );
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
      `${formatCount(one("SELECT count(*) AS n FROM edges"))} edges` +
      // Named, not counted. "5 locales" led an agent to work out which ones by
      // inference and conclude Ukrainian was absent -- it is not. The tool said
      // nothing false; its silence produced a false belief, which is the same
      // failure wearing a different hat.
      // ...and attributed. Naming them was not enough: an unlabelled list of five
      // codes on a counts line reads as the set of languages the GAME ships, and
      // a blind trial asked to support "every language the game ships" could
      // neither confirm nor refute it. These are the locales found in the
      // archive that was indexed -- which is a fact about this archive.
      `\n             locales in this Assets.zip: ${(
        db.prepare("SELECT DISTINCT locale FROM lang_keys ORDER BY locale").all() as unknown as {
          locale: string;
        }[]
      )
        .map((r) => r.locale)
        .join(", ")}\n` +
      `             observed/declared join: ${formatCount(joined)} of ` +
      `${formatCount(observed)} observed fields match a declared one ` +
      `(${Math.round((joined / Math.max(observed, 1)) * 100)}%)\n` +
      // Named, not just numbered. `epoch 1` appeared beside a path with nothing
      // saying what it counts -- a reader deciding whether their index is stale
      // had to guess between rebuild generation, cache format and schema version.
      `             epoch ${one("SELECT CAST(ifnull(value,'0') AS INTEGER) AS n FROM meta WHERE key = 'epoch'")}` +
      ` -- one per index build; rebuild with 'index --force'\n` +
      `             ${dbPath}`
    );
  } catch (err) {
    return `unreadable (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    db.close();
  }
}

export async function cmdSearch(
  query: string,
  args: { assets?: string; patchline?: string; limit?: number; type?: string },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    // The operation renders, this writes. A miss goes to stderr so piped output
    // stays machine-readable.
    const result = searchAssetsOp(db, query, args.limit ?? 20, args.type);
    const miss = result.value.length === 0;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
  } finally {
    db.close();
  }
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
    // The ORDER BY must match the disambiguation note's exactly. It did not: the
    // note ordered by (is_effective, type) and the loader by is_effective alone,
    // leaving SQLite to break the tie by rowid. So `get Plant_Bush` announced
    // "Showing the Item one" and then printed the ItemDropList -- handing over the
    // wrong file while stating the right one.
    const byId = db.prepare(
      "SELECT path, type FROM assets WHERE logical_id = ?1" +
        " AND (?2 IS NULL OR type = ?2) ORDER BY is_effective DESC, type LIMIT 1",
    );
    // `forType` is the child's type when resolving a parent, and the caller's
    // --type (or nothing) for the asset itself. Passing `args.type` for every
    // lookup meant that without --type a parent was chosen by identifier alone:
    // `get Eggsac` merged the BlockBoundingBoxes named Cocoon into a
    // BlockSoundSet and printed `Boxes` in place of `SoundEvents`.
    const load: AssetLoader = async (id, forType) => {
      const row = byId.get(id, forType ?? args.type ?? null) as
        | { path: string; type: string | null }
        | undefined;
      if (row === undefined) return null;
      try {
        return {
          path: row.path,
          type: row.type,
          document: JSON.parse(await archive.readText(row.path)),
        };
      } catch {
        return null;
      }
    };

    const result = await getAssetOp(db, logicalId, load, args.type, args.raw === true);
    const miss = result.value === null;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    // `--raw` promises parseable stdout, so its qualifications go to stderr --
    // the one place a front end still splits a result, and it splits by STREAM
    // rather than by wording: `caveatBlock` is the same renderer either way.
    if (!miss && args.raw === true) process.stderr.write(caveatBlock(result.caveats));
    return miss ? 1 : 0;
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
    // Both forms render in the operation now, so the served answer and this one
    // cannot disagree about whether a bench exists -- which they did, for every
    // id that recipes require and no asset declares.
    if (benchId === undefined) {
      process.stdout.write(benchesOp(db, args.limit ?? 200).text ?? "");
      return 0;
    }
    const result = benchOp(db, benchId, args.limit ?? 200);
    const miss = result.value.found === false;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
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
    // All four branches -- asset, wrong type, value, file -- render in the
    // operation, so the served answer cannot take a different one.
    const result = refsAnyOp(db, logicalId, args.type, args.limit ?? 40);
    const miss = result.value["found"] === false;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
  } finally {
    db.close();
  }
}

/**
 * Lists the asset types.
 *
 * `asset_types` holds 102 rows and had no reader anywhere, while `describe`
 * and `undocumented` both require a type name you must already know and
 * `search-schema` searches field prose rather than the type list. Every blind
 * trial asked for this and each one reconstructed a partial list by reading
 * the TYPE column of `search` results.
 */
export async function cmdTypes(args: {
  assets?: string;
  patchline?: string;
  limit?: number;
  type?: string;
}): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const limit = args.limit ?? 200;

    // `types <Type>` lists the assets of one type. Without it there was no way
    // to enumerate a legal-value set: `describe BlockType --field
    // /BlockSoundSetId` reports 48 distinct values, cannot show them (above the
    // 40 storage ceiling), and points at `refs <id>` -- which needs the id you
    // are looking for. A blind trial filed this as the one thing it could not
    // get, and the only workaround was a query that matches everything by
    // accident of tokenisation.
    // The command renders nothing of its own: the operation carries its text,
    // and this writes it. The MCP server returns the same string, so the two
    // front ends cannot describe the same corpus differently.
    const result = typesOp(db, {
      ...(args.type === undefined ? {} : { type: args.type }),
      limit,
    });
    const miss = result.value.kind === "miss";
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
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
    // The operation renders; this writes. A miss goes to stderr.
    const result = langOp(db, query, args.limit ?? 20);
    const miss = result.value.length === 0;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
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
    // Every branch -- union type, field miss, unknown type, and the field table
    // with its legend -- renders in the operation. This was the last command with
    // a rendering of its own, and it was the one all five agents of round 22 hit:
    // the CLI printed a route across a $ref crossing and the served answer had
    // only a flat denial, because the sentence lived in a print statement.
    // The pointer goes in AS TYPED. The operation repairs shell mangling and says
    // so in a caveat; normalising here first hid the repair from the sentence that
    // exists to explain it.
    const result = describeOp(db, {
      assetType,
      ...(args.field === undefined ? {} : { field: args.field }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    const miss = result.value.fields.length === 0 && result.value.union === null;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
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
    // Renders nothing of its own: the operation carries its text and this writes
    // it. A miss goes to stderr so piped output stays machine-readable.
    const result = searchSchemaOp(db, query, args.limit ?? 20);
    const miss = result.value.length === 0;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
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
      // From the shared operation, not a second inline copy of the query. The
      // copy that used to live here counted the empty-pointer TYPE row, so this
      // header said "declares 9 fields" above a `describe` listing 8 -- the exact
      // drift the api layer exists to prevent, reintroduced by hand.
      const declared = declaredCount(db, args.type);
      const extra = undeclaredObserved(db, args.type);
      if (declared === 0) {
        // The shared suggester, not a third inline copy of half of it. This one
        // kept only the exact-respelling half, so `undocumented FarmingBlock`
        // gave up where `describe FarmingBlock` reaches common:FarmingData.
        const alternatives = typeAlternatives(db, args.type);
        const carriedByType = assetsOfType(db, args.type);
        process.stderr.write(
          (carriedByType > 0
            ? `'${args.type}' is a real asset type (${formatCount(carriedByType)} assets) ` +
              `but the schema declares no fields for it, so nothing here can be\n` +
              `unused or documented.\n`
            : `No type '${args.type}' in the schema.\n`) +
            // Suggestions only when the name really did not resolve. Offering
            // "did you mean" under a sentence that just confirmed the type is
            // real invites the reader to correct a spelling that was right.
            (carriedByType === 0 && alternatives.length > 0
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
            `not a name that failed to resolve.)\n` +
            // Both numbers are right and the pair still read as an off-by-one,
            // which is how a blind trial filed it. `describe` unions the observed
            // layer; this command counts only what the schema declares.
            (extra > 0
              ? `'describe ${args.type}' lists ${formatCount(declared + extra)} rows: ` +
                `${formatCount(extra)} more that the corpus uses but the schema never ` +
                `declares.\n`
              : ""),
        );
        return 0;
      }
    }

    // Everything below is the operation's own rendering.
    process.stdout.write(undocumentedOp(db, args.type, args.limit ?? 40).text ?? "");
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

