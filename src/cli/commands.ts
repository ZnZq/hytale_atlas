import { existsSync, readFileSync, rmSync } from "node:fs";

import { openDatabase } from "../db/open.ts";
import { buildSearchIndex } from "../indexer/corpus.ts";
import { TypeResolver, ingestSchemas } from "../indexer/schema.ts";
import { searchAssets } from "../query/search.ts";
import { AssetArchive, archiveStamp } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { readGeneratedSchemas } from "../sources/schema-doc.ts";
import { frozenDbPath, frozenKey } from "../util/paths.ts";

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
  process.stdout.write(`  ${archive.size.toLocaleString()} entries\n`);

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
        `  schema: ${ingested.types} types, ${ingested.fields.toLocaleString()} fields, ` +
          `${ingested.definitions.toLocaleString()} shared definitions\n`,
      );
      for (const warning of set.warnings) process.stdout.write(`  note: ${warning}\n`);
    } else {
      process.stdout.write(
        `  schema: not found at ${schemaDir} — assets will be untyped (tier 1)\n`,
      );
    }

    const result = await buildSearchIndex(archive, db, {
      ...(resolver ? { types: resolver } : {}),
      onProgress: (done, total) => {
        process.stdout.write(`\r  parsed ${done.toLocaleString()} / ${total.toLocaleString()}`);
      },
    });
    process.stdout.write("\r".padEnd(48) + "\r");
    process.stdout.write(
      [
        `Indexed ${result.assets.toLocaleString()} assets ` +
          `(${result.typed.toLocaleString()} typed, ${result.localized.toLocaleString()} localized)`,
        `Localization: ${result.locales.length} locales, ` +
          `${result.langKeys.toLocaleString()} keys, ` +
          `${result.ftsRows.toLocaleString()} search rows`,
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

interface EvalCase {
  readonly phrase: string;
  readonly tier: string;
  readonly locale?: string;
  readonly overlap?: string;
  readonly expected_any: readonly string[];
  /** Assets that must appear too, for disambiguation cases. */
  readonly expected_also?: readonly string[];
  /** Assets that must not be the top result — noise, prototypes, test fixtures. */
  readonly must_not_rank_first?: readonly string[];
}

/**
 * Runs the search evaluation set.
 *
 * Reports recall@5 **per tier**, never as one number: the aggregate is dominated
 * by `lexical-id`, which passes under every configuration, and would mask total
 * failure on `lexical-name` — the tier the whole localization design rests on.
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
      // entirely — that one family occupies most of the page — which is the
      // opposite of what a disambiguation case is for.
      const also = c.expected_also ?? [];
      if (also.length > 0 && !also.some((id) => ids.includes(id))) {
        reasons.push(`second sense missing (any of ${also.slice(0, 2).join(", ")}…)`);
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
    process.stdout.write(`  ${"(all)".padEnd(22)} ${totalPass}/${total}\n`);

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
