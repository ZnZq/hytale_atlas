import { existsSync, readFileSync, rmSync } from "node:fs";

import { type Database, openDatabase, setMeta } from "../db/open.ts";
import { PIPELINE_VERSION } from "../db/schema.ts";
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
import { readGeneratedSchemas, scopes } from "../sources/schema-doc.ts";
import {
  benchDeclaredBy,
  benchIdExists,
  benchRecipeCount,
  assetTypesOp,
  assetsDeclaringField,
  assetsOfTypeList,
  typeExists,
  benchesOp,
  brokenRefsFor,
  declaredCount,
  fileRefsOp,
  identify,
  undeclaredObserved,
  langOp,
  refsOp,
  searchAssetsOp,
  sameNamed,
  assetsOfType,
  sameNamedCount,
  searchSchemaOp,
  typeAlternatives,
  typesOp,
  unionOf,
  valueLinkFor,
  valueOccurrencesWithoutEdges,
  valueUsage,
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
function nextCommands(
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
    const { value: hits, caveats } = searchAssetsOp(db, query, args.limit ?? 20, args.type);
    if (hits.length === 0) {
      // Said "No matches." and stopped, which reads as "this string appears
      // nowhere". It indexes identifiers and localized names, not field VALUES:
      // searching a sound-set id returned the set itself and none of the three
      // items referencing it, and searching a literal interaction value returned
      // nothing at all. Both agents inferred the limitation from repeated empty
      // results rather than being told.
      // The `--type` scope was dropped from the sentence, so a scoped miss made
      // a claim about the whole corpus: `search Workbench --type BenchCategory`
      // answered "No asset is named 'Workbench', in any indexed locale" about a
      // string that is an asset's own en-US name. Five blind trials hit this and
      // one nearly concluded a damage type does not exist. The type is also
      // checked now -- `--type Zzz` was accepted in silence and its emptiness
      // reported as a fact about the game, while `get` has always validated it.
      const unscoped =
        args.type === undefined ? 0 : searchAssetsOp(db, query, 1).value.length;
      const known =
        args.type === undefined ||
        (db.prepare("SELECT count(*) AS n FROM assets WHERE type = ?").get(args.type) as {
          n: number;
        }).n > 0;
      process.stdout.write(
        (args.type === undefined
          ? `No asset is named "${query}", in any indexed locale.\n\n`
          : !known
            ? `No asset type '${args.type}' exists, so nothing could match. ` +
              `Drop --type, or check the spelling.\n\n`
            : `No asset of type '${args.type}' is named "${query}", in any indexed ` +
              `locale.` +
              (unscoped > 0
                ? ` Without --type there ARE matches -- run the same search without it.`
                : ` Without --type there are none either.`) +
              `\n\n`) +
          // Wording comes from the operation layer, so the MCP server states the
          // same limitation rather than a paraphrase of it.
          `${caveats.map((c) => c.message).join("\n")}\n\n`.replace(
            "not field values.",
            "NOT field values.",
          ) +
          // Built from what the token IS, not from one fact about it. Gating
          // `refs` on "is it an asset" was the inverse of the sentence printed
          // just above -- which is about VALUES -- so the one command that
          // answers the value case was withheld exactly when it applied. The
          // closed loop the old comment describes (`search` -> `refs` ->
          // `search`) came from neither command being able to say what the token
          // was; asking once removes it without withholding anything.
          nextCommands(db, query.split(/\s+/)[0] ?? query),
      );
      return 1;
    }
    // The asset type is printed, not just the id. Searching "pickaxe" returns
    // Goblin_Pickaxe and Outlander_Pickaxe, which are ItemPlayerAnimations rather
    // than items -- without the type they are indistinguishable from real tools
    // and cost a `get` each to rule out.
    // Two markers were printed with no legend anywhere, and both are about the
    // QUERY rather than the asset -- which is how a reader concluded an item was
    // only translated into pt-BR after seeing `[pt-BR]` beside it. The bracket
    // names the locale the match was FOUND in; `~N` means the query had to be
    // loosened N times to reach the row.
    // "name" was a promise the column cannot keep. Translation references are
    // recognised by SHAPE, not by an allowlist of field names -- they arrive
    // under at least eight, `Value` being the second most common -- so the text
    // here is whichever translated string the asset carries. `Burn` has no name
    // at all and its only translation is a DeathMessageKey, which the header
    // then presented as the effect's name.
    process.stdout.write(
      `${"ASSET ID".padEnd(36)} ${"TYPE".padEnd(22)} [locale the match was ` +
        `found in] translated text\n\n`,
    );
    let loosened = false;
    for (const hit of hits) {
      const relaxed = hit.relaxation > 0 ? `  ~${hit.relaxation}` : "";
      if (hit.relaxation > 0) loosened = true;
      process.stdout.write(
        // `??` never fired: the FTS table stores an empty string, not NULL, so
        // 14 198 of 45 449 rows printed a blank TYPE column and an empty `[]`
        // where the header promises a locale. `get` and `refs` print `(untyped)`
        // for the very same assets.
        `${hit.logicalId.padEnd(36)} ${(hit.type || "(untyped)").padEnd(22)} ` +
          // Falls back to the identifier: the column now carries the translation
          // alone, so an asset whose translation resolves to an empty string
          // would print a bare `[en-US]` with nothing after it.
          `[${hit.locale || "id"}] ${hit.displayName || hit.logicalId}${relaxed}\n`,
      );
    }
    if (loosened) {
      process.stdout.write(
        `\n~N marks a row the query only reached after being loosened N time(s); ` +
          `those are weaker matches.\n`,
      );
    }
    process.stdout.write(
      `\n[id] means the match was on the identifier, not on a translation.\n` +
      `A locale here is where THIS query matched, not the only language the ` +
        `asset has.\nThe text is whichever translated string the asset carries -- ` +
        `usually its name, but\nan asset with no name shows another (a death ` +
        `message, a hint).\nUse 'search-lang <id>' for every translation of one asset.\n`,
    );
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
    // The COUNT is unlimited; only the sample below it is capped. Deriving the
    // count from the sample made `get Entry.node` say '8 assets are named' where
    // 461 are, and 442 identifiers are over the cap -- while `refs`, whose query
    // has no LIMIT, printed the true figure for the same id.
    const sameNameTotal = sameNamedCount(db, logicalId);
    if (sameNameTotal > 1 && args.type === undefined) {
      process.stderr.write(
        `note: ${formatCount(sameNameTotal)} assets are named '${logicalId}'. Showing the ` +
          `${sameName[0]!.type ?? "untyped"} one.\n` +
          sameName
            .slice(1)
            .map((s) => `      also: ${s.type ?? "untyped"}  ${s.path}\n`)
            .join("") +
          (sameNameTotal > sameName.length
            ? `      ... and ${formatCount(sameNameTotal - sameName.length)} more; ` +
              `add --type <Type> to choose\n`
            : ""),
      );
    }

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
      } else if (benchIdExists(db, logicalId)) {
        // `get Farmingbench` sent readers to `search`, which sent them to `refs`,
        // which finally explained it is a value rather than an asset -- three
        // hops that never named the one command built for the question.
        process.stderr.write(
          `'${logicalId}' is a bench id, not an asset. Use: hytale-atlas bench ${logicalId}\n`,
        );
      } else if (logicalId.includes(":")) {
        const [maybeType, ...rest] = logicalId.split(":");
        process.stderr.write(
          `No asset '${logicalId}'. Identifiers carry no namespace here.\n` +
            `Did you mean: hytale-atlas get ${rest.join(":")} --type ${maybeType}\n`,
        );
      } else {
        process.stderr.write(
          `No asset '${logicalId}'.\n` + nextCommands(db, logicalId, "search"),
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

    // Both numbers, because the one-sided version was false. `origins` already
    // records declared/inherited/merged per pointer and nothing read it, so the
    // line was derived from the inherited count alone and asserted the rest:
    // `Plant_Crop_Tomato_Block` printed "40 field(s) come from ancestors; the
    // file on disk declares fewer" over an effective definition of 148 leaves,
    // more than half of them the file's own. That sentence answers exactly the
    // question a modder asks -- what must I write myself -- with the wrong side.
    // Counted over the TOP-LEVEL keys, which is the thing the reader can see and
    // check. `origins` records every pointer at every depth, so counting all of
    // them produced a pair reconcilable with nothing on screen: "13 declared in
    // this file, 12 from ancestors" above a document with 19 top-level keys and
    // 40 leaves. Two blind trials tried to check those numbers and could not.
    // The unit is now stated, and the two sides sum to what is printed below.
    const byOrigin = new Map<string, string>();
    for (const o of resolved.origins) {
      if (o.pointer.split("/").length !== 2) continue; // top level only
      // `merged` is recorded after the recursive call, so it must not overwrite
      // the per-key verdict already stored for the same pointer.
      if (o.via === "merged" && byOrigin.has(o.pointer)) continue;
      byOrigin.set(o.pointer, o.via);
    }
    const inherited = [...byOrigin.values()].filter((v) => v === "inherited").length;
    const merged = [...byOrigin.values()].filter((v) => v === "merged").length;
    const declared = [...byOrigin.values()].filter((v) => v === "declared").length;
    if (byOrigin.size > 0) {
      header.push(
        `  of ${byOrigin.size} top-level field(s): ${declared} declared here, ` +
          `${inherited} inherited whole, ${merged} merged with ` +
          `${resolved.parentChain[0] ?? "the parent"}`,
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
      // --help documents a cap for `bench`; the list form ignored it entirely,
      // printing all 21 rows at --limit 3.
      const benchLimit = args.limit ?? 200;
      const allRows = benchesOp(db).value;
      const rows = allRows.slice(0, benchLimit);
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
          `${"".padStart(3)}  (the asset, not the id)\n` +
          // CAT counts what the BENCH ASSET declares. The bracketed groups in
          // 'bench <id>' are what the RECIPES name, which is a different set --
          // Weapon_Bench declares 5 and its recipes name 8. Unlabelled, the two
          // read as the same number disagreeing with itself.
          `\nCAT counts categories the bench ASSET declares. The [groups] under\n` +
          `'bench <id>' are the categories its RECIPES name -- a different set,\n` +
          `so the two numbers differ by design.\n\n`,
      );
      for (const r of rows) {
        // Report, do not interpret. '(no declaring asset -- hand crafting)' was
        // an invented causal story: no such concept exists in the schema, and one
        // of the six ids it labelled that way is a declared BenchCategory typo'd
        // into an Id slot. All the index knows is that nothing declares the id.
        const origin =
          r.declared_by ??
          (r.is_category === 1
            ? "(no bench declares this id; it IS a declared bench category)"
            : "(no bench declares this id)");
        process.stdout.write(
          `${r.id.padEnd(18)} ${String(r.bench_type ?? r.req_type ?? "?").padEnd(18)} ` +
            `${String(r.reqs).padStart(7)} ${String(r.cats).padStart(3)}  ` +
            `${origin}\n`,
        );
      }
      noticeTruncated(rows.length, allRows.length > benchLimit, "benches");
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

    // Over-fetch by one so the printed total is the TOTAL. Using items.length
    // meant a capped list reported the cap: `bench Builders` said "200 craftable
    // here" while the bench table one screen earlier said 911, with no truncation
    // notice and against an explicit --help promise that every command gives one.
    // Four of five blind trials reported it independently.
    const limit = args.limit ?? 200;
    const fetched = craftableAt(db, benchId, limit + 1);
    const items = fetched.slice(0, limit);
    const totalCraftable = benchRecipeCount(db, benchId);
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
          : // A bench CATEGORY is the mistake this command exists to catch -- it is
          // the id sitting one field away, in `Bench.Categories[].Id`, and the
          // listing itself annotates the case elsewhere ("it IS a declared bench
          // category"). Sending the reader to a list that by construction cannot
          // contain what they typed is the one dead end left in this family.
          `No bench '${benchId}'.\n` +
          nextCommands(db, benchId, null, [["hytale-atlas bench", "list every bench id"]]),
      );
      return 1;
    }

    // Whether any asset declares this bench at all. The LIST view computes and
    // prints this ("Fieldcraft ... (no bench declares this id)"); the detail view
    // dropped it, so `bench Fieldcraft` and `bench Furnace` were identical in
    // shape while one is a station you can place and the other is an id nothing
    // in vanilla provides -- a recipe requiring it can never be crafted. That is
    // precisely the runtime silence this command exists to prevent, and the fact
    // was already in hand one screen away.
    const declaredBy = db
      .prepare(
        `SELECT group_concat(a.logical_id, ', ') AS ids FROM bench_declarations d
           JOIN assets a ON a.id = d.asset_id WHERE d.bench_id = ?`,
      )
      .get(benchId) as { ids: string | null } | undefined;
    if (declaredBy?.ids == null) {
      process.stdout.write(
        `  NOTE: no asset declares the bench id '${benchId}'. Recipes require it,\n` +
          `  but nothing in vanilla provides a station carrying it.\n\n`,
      );
    } else {
      process.stdout.write(`  declared by: ${declaredBy.ids}\n\n`);
    }

    // Headed, because column 2 is a trap. It is the category's translated NAME,
    // and it routinely collides with a real identifier of something else:
    // `Workbench_Tools` displays as `Tools`, and `Tools` is separately a
    // FieldcraftCategory asset used by nine Fieldcraft recipes. A modder copying
    // column 2 into BenchRequirement.Categories writes a category belonging to a
    // different bench and gets exactly the runtime silence they are avoiding.
    // The bench listing prints headers; this block had none and no title.
    if (categories.length > 0) {
      process.stdout.write(
        `  ${"CATEGORY ID (use this)".padEnd(24)} DISPLAY NAME (do not use)\n`,
      );
    }
    for (const c of categories) {
      const indent = c.parent_id === null ? "  " : "      ";
      process.stdout.write(
        `${indent}${c.category_id.padEnd(26 - indent.length)} ${c.value ?? c.name_key ?? ""}\n`,
      );
    }
    process.stdout.write(`\n${formatCount(totalCraftable)} craftable here:\n`);
    noticeTruncated(items.length, fetched.length > limit, "recipes");
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
      // Before treating it as a plain string: does it exist as an asset of
      // ANOTHER type? `refs Wood --type Item` answered "'Wood' is not an asset"
      // about a name four assets carry. `get` has always got this right, and
      // the two commands contradicting each other is worse than either alone.
      if (args.type !== undefined) {
        const elsewhere = sameNamed(db, logicalId);
        if (elsewhere.length > 0) {
          process.stderr.write(
            `No '${logicalId}' of type '${args.type}'. It exists as: ` +
              `${elsewhere.map((c) => c.type ?? "untyped").join(", ")}\n` +
              `Try: hytale-atlas refs ${logicalId} --type ${elsewhere[0]!.type ?? ""}\n`,
          );
          return 1;
        }
      }

      const valueLimit = args.limit ?? 40;
      const usage = valueUsage(db, logicalId, valueLimit);
      if (usage.occurrences > 0) {
        const fields = usage.byField.slice(0, usage.fieldsShown);
        const carriers = usage.examples.slice(0, valueLimit);
        // Both numbers, because they differ and the difference matters: one
        // asset can hold the same value in two fields.
        //
        // stdout and exit 0: this is an ANSWER, not a miss. It went to stderr
        // with exit 1 -- a successful lookup reported as a failure, unusable in
        // a pipeline -- and once `search` began suggesting this exact command
        // for a value, the suggestion led somewhere that printed nothing to
        // stdout and signalled an error. The asset branch has always used
        // stdout and 0 for the same question.
        process.stdout.write(
          `'${logicalId}' is not an asset. It appears as a VALUE ` +
            `${formatCount(usage.occurrences)} time(s) in ` +
            `${formatCount(usage.assets)} asset(s):\n` +
            fields
              .map((r) => `  ${formatCount(r.count)}x  ${r.scope} :: ${r.pointer}\n`)
              .join("") +
            // "a declared field" was the wrong term and made the arithmetic
            // unreconcilable: the rows above are grouped by the RESOLVED field
            // position, declared or not -- `Interaction :: /DamageCalculator/
            // BaseDamage/Physical` is listed there and `describe` marks it
            // UNDECLARED. What the remainder actually is: occurrences whose
            // pointer never resolved to a field position at all, because the
            // owning type declares no fields to resolve against (44 938 of them
            // are NPCRole).
            (usage.unattributed > 0
              ? `  ${formatCount(usage.unattributed)} occurrence(s) sit in assets whose ` +
                `type declares no fields, so their position could not be resolved ` +
                `and the breakdown above does not sum to the total.\n`
              : "") +
            (usage.fields > fields.length
              ? `  ... and ${formatCount(usage.fields - fields.length)} more field(s). ` +
                `Use --limit <n>.\n`
              : "") +
            `\nCarried by:\n` +
            carriers
              .map(
                (e) =>
                  `  ${e.logicalId.padEnd(38)} ${(e.type ?? "untyped").padEnd(18)} ${e.pointer}\n`,
              )
              .join("") +
            (usage.examples.length > carriers.length
              ? `  ... ${formatCount(usage.occurrences - carriers.length)} more. ` +
                `Use --limit <n>.\n`
              : "") +
            // The same caveat the asset branch carries. A value inherited from a
            // parent is not in this list: `refs "Type=Soil"` names 30 assets and
            // omits every crop that inherits its Support block from
            // Template_Crop_Block, while `get` shows the value on all of them.
            `\nCounts cover files that declare the value themselves. 'get' resolves\n` +
            `inheritance first, so it can show this value on assets not listed here.\n`,
        );
        return 0;
      }

      // Before giving up: it may be a FILE. Models, textures, icons, sounds and
      // animations are indexed with their own edge kind, and `refs` filtered
      // them out -- so a texture with 221 inbound references answered 'nothing
      // carries it as a value'.
      const asFile = fileRefsOp(db, logicalId, args.limit ?? 40);
      if (asFile.value.length > 0) {
        for (const file of asFile.value) {
          process.stdout.write(
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
          );
        }
        renderCaveats(asFile.caveats);
        return 0;
      }

      // "no file by that name" was asserted about anything the file-reference
      // index did not hold -- including `Tool_Pickaxe_Iron.json`, a path this
      // very tool prints in the header of `get`. Only asset documents are absent
      // from `files`, so say which index was consulted rather than making a
      // claim about the archive.
      process.stderr.write(
        `No asset '${logicalId}'${args.type ? ` of type '${args.type}'` : ""}, ` +
          "and nothing carries it as a value. No file of that name is REFERENCED by\n" +
          "any asset (asset documents themselves are not in the file index).\n" +
          nextCommands(db, logicalId),
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

    // The asset branch is chosen silently when the token is BOTH an asset and a
    // field value, and the value report is then unreachable. Every Quality value
    // in the game (1-6) is also the name of a BlockMigration asset, so `refs 5`
    // answered with four NPCRole rows and no hint that 'which blocks require
    // Quality 5' -- the question a tool author actually has -- was sitting
    // behind the branch not taken.
    const beyond = valueOccurrencesWithoutEdges(
      db,
      logicalId,
      value.targets.map((t) => t.id),
    );
    if (beyond.occurrences > 0) {
      process.stdout.write(
        `\n'${logicalId}' also appears ${formatCount(beyond.occurrences)} time(s) in ` +
          `${formatCount(beyond.assets)} asset(s) as a value that produced no edge above ` +
          `(filtered as\ngeneric, or in a type the schema declares no fields for).\n`,
      );
    }

    // Confidence is not decoration. A declared reference is a fact the schema
    // states; a heuristic one is a name that happens to collide, and 'Stone'
    // collides with a great many things.
    process.stdout.write(
      // The `medium` gloss named a rare cause as if it were the rule. Measured:
      // 15 386 of 26 274 medium edges come from a field that DOES declare a
      // target type, and in every one of those the declared type has assets --
      // so "the declared target type is not itself an asset type" was false for
      // all of them. The real reason is that this particular destination is not
      // of the declared type, which is also why `describe` can call the same
      // value BROKEN without contradicting anything: one statement is about the
      // edge, the other about the value.
      "\nhigh   = declared by the schema AND this target IS of the declared type,\n" +
        "         or inheritance the engine resolves itself\n" +
        "medium = the schema declares this field a reference, but this target is not\n" +
        "         of the declared type (some other asset shares the name), or the\n" +
        "         field declares no target and its name follows a convention\n" +
        "low    = the value merely collides with an identifier; often coincidence\n" +
        // Wrapped so no line begins with a confidence word: those start a result
        // row, and prose that opens with one is indistinguishable from data to
        // anything reading this output -- including this project's own tests.
        "\nA field can be declared '-> X', have no X of that name, and still show\n" +
        "an edge of medium confidence to a same-named asset of another type.\n" +
        "'describe' calls that value BROKEN; both are true, about different things.\n",
    );
    renderCaveats(caveats);
    return 0;
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
    const { value: entries, caveats } = langOp(db, query, args.limit ?? 20);
    if (entries.length === 0) {
      process.stdout.write(
        `No localization key or value matches "${query}".\n\n` +
          // "Any root is accepted" was false, and false in the one direction
          // that misleads: `server.` and `common.` are stripped, and any other
          // first segment is only tried as a literal root against `lang_keys.root`.
          // `emotes.general.deathCause.burn` missed while `server.general.deathCause.burn`
          // resolved -- the root WAS the problem, under a sentence saying it could
          // not be. A reader who types the root their own .lang file uses is told
          // to look elsewhere.
          "Keys are stored WITHOUT their root: an asset referencing\n" +
          "'server.items.Foo.name' is stored as 'items.Foo.name'. 'server.' and\n" +
          "'common.' are stripped automatically; any other first segment is tried\n" +
          "as a literal root, so try the key without its root as well.\n\n" +
          // The one command that had no coverage hedge, while its siblings all
          // carry one -- and the command a reader uses to ask whether a language
          // exists at all. "This is a real miss" was a claim about the game that
          // only the index could answer.
          "This is evidence, not proof: it covers the locales this index holds\n" +
          "(see 'hytale-atlas status'), and matching is literal -- a string spelt\n" +
          "differently would not match.\n",
      );
      return 1;
    }
    for (const entry of entries) {
      // Both forms. The stored key is what the table holds; the reference is
      // what an asset must contain, and printing only the former sent modders
      // to paste a key the game will not resolve.
      process.stdout.write(
        `${entry.key}\n` +
          (entry.reference === entry.key
            ? ""
            : `    write this in an asset: ${entry.reference}\n`),
      );
      for (const t of entry.translations) {
        process.stdout.write(`    ${t.locale.padEnd(7)} ${t.value}\n`);
      }
      const shownUsers = entry.usedBy.slice(0, args.limit ?? 20);
      for (const u of shownUsers) {
        process.stdout.write(`    used by ${u.logicalId} ${u.pointer ?? ""}\n`);
      }
      if (entry.usedByTotal > shownUsers.length) {
        process.stdout.write(
          `    ... and ${formatCount(entry.usedByTotal - shownUsers.length)} more ` +
            `of ${formatCount(entry.usedByTotal)}. Use --limit <n>.\n`,
        );
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
    // From the operation, not from a second copy of its query. This block had
    // its own SELECT against `schema_fields`, so `unionOf` and the CLI could
    // disagree about what a union is -- and did: the operation now requires more
    // than one branch (a single `$ref` is an ordinary crossing, not a union of
    // one) while this copy would still have printed "a union of 1 shapes".
    const union = unionOf(db, assetType);

    if (union !== null && field === undefined) {
      const branches = union.branches;
      const values = union.discriminatorValues;
      const property = union.discriminatorProperty;
      process.stdout.write(
        `'${assetType}' is a union of ${branches.length} shapes, chosen by the ` +
          `'${property}' field.\nIt declares no field of its own -- describe a branch ` +
          `to see fields.\n\n`,
      );
      const width = Math.max(...values.map((v: string) => v.length), 8);
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
      // The operation's own test, not an inline copy of it.
      const declaresFields = typeExists(db, assetType);

      if (declaresFields && field !== undefined) {
        // Walk up the pointer to find the deepest prefix that does exist, which
        // is usually where the user's mental model and the schema diverge.
        let probe = field;
        let near: string[] = [];
        while (probe.length > 1 && near.length === 0) {
          near = pointersLike(db, assetType, probe);
          if (near.length === 0) probe = probe.slice(0, probe.lastIndexOf("/")) || "/";
        }
        // A union declares no field of its own, so sending the reader to
        // `describe X` "to list its fields" lands them on 102 branches and no
        // fields at all. Name what they will actually get.
        const fallback =
          union !== undefined
            ? `'${assetType}' is a union: its fields live on the branches, not on it.\n` +
              `Run 'hytale-atlas describe ${assetType}' to list the branches, then describe one.\n`
            : `Run 'hytale-atlas describe ${assetType}' to list its fields.\n`;
        // Where the nearest declared pointer CROSSES into another type, say so.
        // The success path prints "continues in common:X" for the very same
        // pointer, and the error path withheld it -- so reaching
        // `BlockType /Support/Down/*/TagId` took four invocations where two
        // would do, and the message read as absence for a field that exists one
        // `$ref` away. Two agents hit this independently, on different types.
        const crossing = near
          .map((p) => {
            const row = db
              .prepare(
                `SELECT ref_scope FROM schema_fields
                  WHERE asset_type = ? AND json_pointer = ? AND ref_scope IS NOT NULL`,
              )
              .get(assetType, p) as { ref_scope: string } | undefined;
            const targets = scopes(row?.ref_scope ?? null);
            return targets.length === 1
              ? `  ${p} continues in ${targets[0]} -- ` +
                `hytale-atlas describe ${targets[0]} --field ${field.slice(p.length) || "/"}\n`
              : null;
          })
          .filter((l): l is string => l !== null)
          .join("");

        process.stderr.write(
          `'${assetType}' has no field '${field}'.\n` +
            (near.length > 0
              ? `Nearest declared:\n` + near.map((p) => `  ${p}\n`).join("") + crossing
              : fallback),
        );
        return 1;
      }

      // Shared definitions live in a namespace, and which types need one is not
      // guessable: ItemToolSpec and CraftingRecipe do not, ItemTool and
      // BenchRequirement do. Suggestions go both ways, because both mistakes
      // happen: adding a prefix that does not belong, and omitting one that does.
      const alternatives = typeAlternatives(db, assetType);

      // A type with assets but no declared fields is a real type the schema is
      // silent about, not a typo. Saying "No type" sent readers looking for a
      // spelling mistake that does not exist.
      const carried = assetsOfType(db, assetType);
      if (carried > 0) {
        process.stderr.write(
          `'${assetType}' is a real asset type -- ${formatCount(carried)} assets carry ` +
            `it -- but the generated schema declares no fields for it, so there is\n` +
            `nothing to describe. Its contents are reachable per asset: ` +
            `hytale-atlas get <id> --type ${assetType}\n`,
        );
        return 1;
      }
      if (alternatives.length > 0) {
        process.stderr.write(
          `No type '${assetType}'. Did you mean:\n` +
            alternatives
              .map((a) => `  hytale-atlas describe ${a}${field ? ` --field ${field}` : ""}\n`)
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
    const markers = new Set<string>();
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
        // 2 064 fields across 724 types declare a default, it was decoded into
        // the row being rendered, and no branch printed it -- while "what
        // happens if I omit this field" is the commonest schema question.
        d?.defaultValue != null ? `default ${clip(d.defaultValue, 40)}` : null,
        d === null ? "UNDECLARED" : null,
        o === null ? (container ? "(container)" : "unused") : null,
      ].filter(Boolean);

      // Every marker printed is recorded, so the legend below can explain
      // exactly the ones this answer used. They were bare words with no
      // explanation anywhere in the tool: a blind trial went through all nine
      // commands looking for prose defining `unused` and found none, and read it
      // -- reasonably -- as "the engine ignores this field" rather than "no
      // vanilla asset sets it, and the declared/observed join is partial".
      for (const flag of flags) {
        if (typeof flag !== "string") continue;
        // `-> Target` and `default X` carry a value, so the marker recorded is
        // the symbol itself. `->` was excluded as "data, not a marker" and a
        // blind trial had to guess what the arrow meant on a container row,
        // where no `points at` line follows to gloss it.
        if (flag.startsWith("->")) markers.add("->");
        else if (flag.startsWith("default")) markers.add("default");
        else markers.add(flag);
      }
      if (d?.type == null) markers.add("?");

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
      // A value link is the only kind of legal-value set JSON Schema cannot
      // express, so `describe` had nothing to say about the very fields whose
      // values are hardest to guess.
      // Values this field declares a target for that resolve to nothing. The
      // marker existed, was overwritten before it could be used, and no query
      // read the column: `describe BlockType --field HitboxType` printed
      // '-> BlockBoundingBoxes' and 214 distinct values without mentioning that
      // one of them names nothing, 256 times.
      const broken = brokenRefsFor(db, assetType, f.pointer);
      for (const one of broken.shown) {
        process.stdout.write(
          `    BROKEN: '${one.value}' names no ${d?.referenceTarget ?? "asset"} ` +
            `(${formatCount(one.occurrences)} occurrence(s))\n`,
        );
      }
      // The list is capped at eight and said so nowhere:
      // `common:BlockTypeFarmingStageData --field /Block` names 63 BlockTypes
      // that do not exist and printed the first eight alphabetically.
      if (broken.distinct > broken.shown.length) {
        process.stdout.write(
          `    BROKEN: ${formatCount(broken.shown.length)} of ` +
            `${formatCount(broken.distinct)} unresolved value(s) shown, ` +
            `${formatCount(broken.occurrences)} occurrence(s) in total\n`,
        );
      }
      // Which assets declare it, in the single-field view. "used in 1 assets"
      // with no way to reach that one asset was a dead end on the exact field
      // --help points at for "what makes a tool faster" (common:ItemTool./Speed,
      // used by one asset of 35 074). `refs` answers this for values and value
      // links name their declarers; a plain scalar field had no route at all.
      if (args.field !== undefined && o !== null && o.assets > 0) {
        const declarers = assetsDeclaringField(db, assetType, f.pointer, 7);
        if (declarers.length > 0) {
          const shown = declarers.slice(0, 6);
          process.stdout.write(
            `    declared by: ${shown.map((s) => s.logicalId).join(", ")}` +
              (declarers.length > shown.length
                ? ` ... and ${formatCount(o.assets - shown.length)} more`
                : "") +
              `\n    e.g. hytale-atlas get ${shown[0]!.logicalId}` +
              (shown[0]!.type ? ` --type ${shown[0]!.type}` : "") +
              `\n`,
          );
        }
      }
      // Where the legal values live, when the field declares a target type.
      // `describe` could report "48 distinct values" it cannot store and then
      // point at `refs <id>`, which needs the id being looked for.
      if (args.field !== undefined && d?.referenceTarget != null) {
        process.stdout.write(
          `    the values are assets of type ${d.referenceTarget} -- ` +
            `hytale-atlas types ${d.referenceTarget}\n`,
        );
      }
      // Absence of `required` is weak evidence, and silence looked like a fact.
      // The generated schema marks only 2 455 of 18 396 fields required, so a
      // field with no marker is usually one the schema simply says nothing
      // about -- the same (a)/(b) confusion `unused` carries, about the schema
      // instead of the corpus.
      if (args.field !== undefined && d !== null && d.optional) {
        process.stdout.write(
          `    the schema does not mark this required -- and it marks few fields\n` +
            `    either way, so that is not evidence the field is optional\n`,
        );
      }
      const link = valueLinkFor(db, assetType, f.pointer);
      if (link !== null) {
        process.stdout.write(
          `    value link '${link.link}': this field ${link.role} the value.\n` +
            `    ${formatCount(link.declared.length)} value(s) are declared: ` +
            `${link.declared.join(", ")}\n` +
            `    declared by ${formatCount(link.declaredByTotal)} asset(s), ` +
            `e.g. ${link.declaredBy.map((d2) => d2.logicalId).join(", ")}\n` +
            (link.unresolved.length > 0
              ? `    referenced but declared nowhere: ${link.unresolved.join(", ")}\n`
              : ""),
        );
      }
      if (d?.typeConstant) {
        // A discriminator's own legal set is one value. The union's full list
        // sat here instead, one line under the sentence saying so, and
        // following it selects a different branch of the schema.
        process.stdout.write(`    legal here: "${d.typeConstant}" (this branch only)\n`);
        if (d.enumValues) {
          process.stdout.write(
            `    the union allows ${d.enumValues.join(", ")} -- each selects a ` +
              `different shape\n`,
          );
        }
      } else if (d?.enumValues) {
        process.stdout.write(`    legal: ${d.enumValues.join(", ")}\n`);
        // ...and which of them vanilla actually uses. The observed values were
        // stored and this branch dropped them, so a field with three legal values
        // and two in use looked identical to one where all three are used --
        // `common:RequiredBlockFaceSupport./Support` is exactly that, and "do any
        // vanilla crops set Disallowed" was unanswerable while the index held the
        // answer. Only worth printing when it is narrower than the legal set.
        if (o?.values && o.values.length < d.enumValues.length) {
          process.stdout.write(
            `    seen:  ${o.values.join(", ")}  (${o.values.length} of ` +
              `${d.enumValues.length} legal values occur in vanilla)\n`,
          );
        }
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
            (o.targetTypes ? `, points at ${o.targetTypes.join("/")}` : "") +
            (o.targetTypes ? ((): string => { markers.add("points at"); return ""; })() : "") +
            // The JSON type, for a field the schema does not declare. Without a
            // declared row there is no type on the line at all, so 418 observed
            // fields printed a count and left the reader to infer from the
            // sample values whether the field takes a number or a string.
            (d === null && o.valueTypes ? `, holds ${o.valueTypes.join("/")}` : "") +
            "\n",
        );
        // An UNDECLARED field is named to its sources, because a few of them are
        // not evidence of a capability at all.
        //
        // Asset type comes from the file's PATH. When a file sits in the wrong
        // directory the mismatch is silent, and its fields surface as observed
        // properties of a type they have nothing to do with:
        // `Food_EffectCondition_Buff_Medium` and `_Small` live under
        // Server/Entity/Effects/Food/Buff/_Deprecated/ and are therefore typed
        // EntityEffect, while their content is a plain EffectConditionInteraction
        // -- so /Match, /Next and /EntityEffectIds appeared as EntityEffect
        // capabilities. Byte-identical siblings one directory over are typed
        // correctly, which is how it stayed invisible.
        if (d === null && o.assets > 0 && o.assets <= 5) {
          const sources = db
            .prepare(
              `SELECT DISTINCT a.logical_id, a.path FROM candidates c
                 JOIN assets a ON a.id = c.asset_id
                WHERE c.schema_scope = ? AND c.schema_pointer = ? LIMIT 3`,
            )
            .all(f.assetType, f.pointer) as unknown as {
            logical_id: string;
            path: string;
          }[];
          for (const s of sources) {
            process.stdout.write(`      from ${s.logical_id}  ${s.path}\n`);
          }
        }
        // Above the enum threshold the values are not stored, so the line simply
        // vanished -- no list, no count, no caveat, while a neighbouring field
        // with 33 values printed all of them. Two agents independently read the
        // silence as "this field has no values", on the two fields that mattered
        // most to them: MaterialQuantity/ItemId (1,194 uses) and
        // ApplyEffectInteraction/EffectId (123 uses).
        if (o.values === null && o.cardinality > 0 && d?.enumValues == null) {
          // Says that --limit cannot help, because it cannot: values above the
          // enum threshold are never stored, so there is nothing for a larger
          // limit to reveal. An agent tested --limit 10, 500 and 1000 and got
          // identical output, reasonably reading that as the flag being ignored.
          process.stdout.write(
            `    ${formatCount(o.cardinality)} distinct values -- more than this index\n` +
              `    keeps. They are not stored, so --limit cannot show them. To ask the\n` +
              `    reverse question -- which assets name a particular one -- use\n` +
              `    'refs <id>'.\n`,
          );
        }
      } else if (container && args.field !== undefined) {
        // A union FIELD gets the same treatment a union TYPE does. `describe
        // Interaction` lists its 102 branches and the value selecting each, but
        // `describe ItemDropList --field Container` said only "(container)" and
        // never mentioned that `Type` picks Single or Multiple -- structure that
        // was recoverable only by fetching a real asset.
        const branches = db
          .prepare(
            `SELECT ref_scope, discriminator_property, discriminator_values
               FROM schema_fields WHERE asset_type = ? AND json_pointer = ?
                AND ref_scope IS NOT NULL`,
          )
          .get(assetType, f.pointer) as Record<string, unknown> | undefined;
        // A SINGLE-target crossing gets named too. `describe BlockType --field
        // Farming` printed a bare "(container)" and never mentioned
        // common:FarmingData, so the only way across that boundary was to guess
        // the type name from a lexical search and notice the resemblance.
        const targets = scopes((branches?.["ref_scope"] as string | null) ?? null);
        if (targets.length === 1) {
          process.stdout.write(
            `    continues in ${targets[0]} -- hytale-atlas describe ${targets[0]}\n`,
          );
        } else if (targets.length > 1) {
          // Only a real union gets the branch table. Printing it for a single
          // target produced "one of 1 shapes, chosen by 'Type'" above one row
          // whose discriminator column read '?' -- a choice that does not exist.
          const values = String(branches?.["discriminator_values"] ?? "")
            .split(" ")
            .filter(Boolean);
          const property = (branches?.["discriminator_property"] as string | null) ?? "Type";
          process.stdout.write(`    one of ${targets.length} shapes, chosen by '${property}':\n`);
          const width = Math.max(...values.map((v) => v.length), 8);
          for (const [i, target] of targets.entries()) {
            process.stdout.write(`      ${(values[i] ?? "?").padEnd(width)}  ${target}\n`);
          }
        }
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
          "are not counted here.\n" +
          // A shape can be embedded in a file of another type, so the count is
          // not a count of assets OF this type: `EntityEffect./Duration` reports
          // 146 while `types EntityEffect` lists 140, because 19 of them are
          // inline EntityEffect literals inside Items. Both numbers were right
          // and the pair read as a plain contradiction.
          "A file of any type counts if it carries this shape, inline or as its\n" +
          "own asset -- so this can exceed the number of assets OF this type.\n",
      );
    }

    // A marker is explained where it is printed, and only the ones that appeared
    // are listed. `unused` is the load-bearing one: it is a statement about this
    // INDEX, and `undocumented` has always carried the join-rate hedge for the
    // identical fact while this command printed the bare word.
    if (markers.size > 0) {
      // The same pair `undocumented` quotes, measured on the DECLARED side --
      // the honest denominator when the question is "does vanilla use this".
      const one = (sql: string): number =>
        Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
      // Counted over SCALAR declared fields only -- the population that can
      // carry this marker at all. The first version quoted 2 457 of 17 400,
      // borrowed from `undocumented`'s caveat where the denominator is the whole
      // declared side. Here it is wrong twice over: 7 959 of those 17 400 are
      // containers, which the legend two lines up says can NEVER appear in the
      // observed layer, so counting them as unmatched inflates the doubt roughly
      // forty-fold. A blind trial discounted a load-bearing `unused` field on the
      // strength of it.
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
        merges:
          "values of this type combine field by field instead of replacing wholesale",
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
      process.stdout.write("\nmarkers in this answer:\n");
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
        if (markers.has(m) && legend[m] !== undefined) {
          process.stdout.write(`  ${m.padEnd(12)} ${legend[m]}\n`);
        }
      }
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

