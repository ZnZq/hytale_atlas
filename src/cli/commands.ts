import { existsSync, readFileSync, rmSync } from "node:fs";

import { openDatabase } from "../db/open.ts";
import { buildSearchIndex } from "../indexer/corpus.ts";
import { resolveCandidates } from "../indexer/references.ts";
import { TypeResolver, applyTypes, ingestSchemas } from "../indexer/schema.ts";
import { type AssetLoader, resolveAsset } from "../query/asset.ts";
import { searchAssets } from "../query/search.ts";
import { AssetArchive, archiveStamp } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { TELEMETRY_DISCLOSURE, withGeneratedSchemas } from "../sources/schema-gen.ts";
import { readGeneratedSchemas } from "../sources/schema-doc.ts";
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
    const schemaDir = args.schema ?? DEFAULT_SCHEMA_DIR;
    if (existsSync(schemaDir)) {
      const set = readGeneratedSchemas(schemaDir);
      const ingested = ingestSchemas(db, set);
      resolver = new TypeResolver(set.types);
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
      onProgress: (done, total) => {
        process.stdout.write(`\r  parsed ${formatCount(done)} / ${formatCount(total)}`);
      },
    });
    process.stdout.write("\r".padEnd(48) + "\r");

    // Pass 2 resolution: one indexed join per edge kind, now that the symbol
    // table is complete.
    const edges = resolveCandidates(db);

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
        `Candidates: ${formatCount(edges.candidates)} recorded, ` +
          `${formatCount(edges.dangling)} unresolved`,
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

export async function cmdSearch(
  query: string,
  args: { assets?: string; patchline?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const hits = searchAssets(db, query, { limit: args.limit ?? 10 });
    if (hits.length === 0) {
      process.stdout.write("No matches.\n");
      return 1;
    }
    for (const hit of hits) {
      const relaxed = hit.relaxation > 0 ? `  ~${hit.relaxation}` : "";
      process.stdout.write(
        `${hit.logicalId.padEnd(38)} [${hit.locale}] ${hit.displayName}${relaxed}\n`,
      );
    }
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
  args: { assets?: string; patchline?: string; raw?: boolean },
): Promise<number> {
  const archivePath = openFrozen(args.assets, args.patchline);
  const db = await frozenDb(args.assets, args.patchline);
  const archive = await AssetArchive.open(archivePath);

  try {
    const byId = db.prepare(
      "SELECT path, type FROM assets WHERE logical_id = ? ORDER BY is_effective DESC LIMIT 1",
    );

    const load: AssetLoader = async (id) => {
      const row = byId.get(id) as { path: string; type: string | null } | undefined;
      if (row === undefined) return null;
      try {
        return { path: row.path, type: row.type, document: JSON.parse(await archive.readText(row.path)) };
      } catch {
        return null;
      }
    };

    const resolved = await resolveAsset(db, logicalId, load);
    if (resolved === null) {
      process.stderr.write(`No asset '${logicalId}'. Try 'hytale-atlas search ${logicalId}'.\n`);
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

