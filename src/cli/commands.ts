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
import { describeSchema, findUndocumented, searchSchema } from "../query/schema.ts";
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
      for (const r of rows) {
        process.stdout.write(
          `${r.id.padEnd(18)} ${String(r.bench_type ?? "?").padEnd(18)} ` +
            `${String(r.reqs).padStart(5)} recipes  ${String(r.cats).padStart(2)} cat  ` +
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
      process.stderr.write(`No bench '${benchId}'. Run without an argument to list them.\n`);
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

export async function cmdDescribe(
  assetType: string,
  args: { assets?: string; patchline?: string; field?: string; limit?: number },
): Promise<number> {
  const db = await frozenDb(args.assets, args.patchline);
  try {
    const fields = describeSchema(db, assetType, args.field);
    if (fields.length === 0) {
      process.stderr.write(`No schema for type '${assetType}'.\n`);
      return 1;
    }
    const limit = args.limit ?? 60;
    for (const f of fields.slice(0, limit)) {
      const d = f.declared;
      const o = f.observed;
      const flags = [
        d?.optional === false ? "required" : null,
        d?.inheritsProperty ? "inherits" : null,
        d?.mergesProperties ? "merges" : null,
        d?.referenceTarget ? `-> ${d.referenceTarget}` : null,
        d === null ? "UNDECLARED" : null,
        o === null ? "unused" : null,
      ].filter(Boolean);

      process.stdout.write(
        `${f.pointer.padEnd(46)} ${String(d?.type ?? "?").padEnd(16)} ${flags.join(" ")}\n`,
      );
      if (d?.title) process.stdout.write(`    ${d.title}\n`);
      if (d?.description) {
        process.stdout.write(`    ${d.description.replace(/\s+/g, " ").slice(0, 140)}\n`);
      }
      // Declared enums are the complete legal set; observed values are only what
      // vanilla happens to use. Labelled differently on purpose.
      if (d?.enumValues) process.stdout.write(`    legal: ${d.enumValues.join(", ")}\n`);
      else if (o?.values) process.stdout.write(`    seen:  ${o.values.slice(0, 14).join(", ")}\n`);
      if (o) {
        process.stdout.write(
          `    used in ${formatCount(o.assets)} assets` +
            (o.targetTypes ? `, points at ${o.targetTypes.join("/")}` : "") + "\n",
        );
      }
    }
    if (fields.length > limit) {
      process.stdout.write(`... ${formatCount(fields.length)} fields total\n`);
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
    const hits = searchSchema(db, query, args.limit ?? 15);
    if (hits.length === 0) {
      process.stdout.write("No schema field matches. That is itself an answer: nothing in\n");
      process.stdout.write("any asset type declares this capability.\n");
      return 1;
    }
    for (const h of hits) {
      process.stdout.write(`${(h.assetType + h.pointer).padEnd(56)} ${h.title ?? ""}\n`);
      if (h.description) {
        process.stdout.write(`    ${h.description.replace(/\s+/g, " ").slice(0, 130)}\n`);
      }
    }
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
    const fields = findUndocumented(db, args.type, args.limit ?? 40);
    process.stdout.write(
      "Fields the schema permits that appear in zero vanilla assets.\n" +
        "These are leads, not features: a field may be deprecated, engine-internal,\n" +
        "set programmatically rather than from JSON, or a debug hook.\n\n",
    );
    for (const f of fields) {
      process.stdout.write(
        `${(f.assetType + f.pointer).padEnd(56)} ${f.declaredType ?? ""}` +
          `${f.referenceTarget ? ` -> ${f.referenceTarget}` : ""}\n`,
      );
      if (f.description) {
        process.stdout.write(`    ${f.description.replace(/\s+/g, " ").slice(0, 130)}\n`);
      }
    }
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

