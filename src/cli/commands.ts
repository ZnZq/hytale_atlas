import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_HTTP_PORT } from "../mcp/server.ts";
import { detected, launchCommand, snippet, targets } from "./mcp-install.ts";
import { basename, join, resolve } from "node:path";

import { type Database, openDatabase, setMeta } from "../db/open.ts";
import { PIPELINE_VERSION } from "../db/schema.ts";
import { type PackSource, buildSearchIndex } from "../indexer/corpus.ts";
import { indexBenches } from "../indexer/benches.ts";
import { VALUE_LINKS, indexValueLinks } from "../indexer/value-links.ts";
import { resolveCandidates } from "../indexer/references.ts";
import { computeFieldStats } from "../indexer/stats.ts";
import { TypeResolver, applyTypes, assetSuffixes, ingestSchemas } from "../indexer/schema.ts";
import { searchAssets } from "../query/search.ts";
import { AssetArchive } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { CONFIG_FILENAME, findConfigFile, resolveMods } from "../sources/config.ts";
import { resolveSources } from "../api/operations.ts";
import { TELEMETRY_DISCLOSURE, withGeneratedSchemas } from "../sources/schema-gen.ts";
import { readGeneratedSchemas } from "../sources/schema-doc.ts";
import {
  benchOp,
  benchesOp,
  resolveDbPath,
  describeOp,
  getAssetOp,
  openIndex,
  langOp,
  refsAnyOp,
  packAssetLoader,
  searchAssetsOp,
  searchSchemaOp,
  typesOp,
  undocumentedOp,
} from "../api/operations.ts";
import { caveatBlock } from "../api/types.ts";
import { formatCount } from "../util/paths.ts";
import { askConsent } from "./consent.ts";

/**
 * Strips ANSI colour codes.
 *
 * The server colours its log output, and the escape sequences survive being piped
 * into our own output, where they corrupt alignment and leak into log files.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
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

/**
 * Reads a pack's `manifest.json` without unpacking the archive.
 *
 * Returns nulls rather than throwing: a jar that is pure code has no manifest and
 * is not an error, just not a pack.
 */
async function readManifest(
  archive: AssetArchive,
): Promise<{ group: string | null; name: string | null; version: string | null }> {
  const entry = archive.entries.find((e) => e.path === "manifest.json");
  if (entry === undefined) return { group: null, name: null, version: null };
  try {
    const m = JSON.parse(await archive.readText(entry.path)) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return { group: str(m["Group"]), name: str(m["Name"]), version: str(m["Version"]) };
  } catch {
    return { group: null, name: null, version: null };
  }
}

/**
 * Opens every source and gives each a `packs` row.
 *
 * Priority mirrors the server's own load order (`docs/init/03-ARCHITECTURE.md`):
 * lower wins, so mods at 2 override vanilla at 3. That is the direction a modder
 * expects -- their file replaces the game's -- and it is the direction the
 * `is_effective` pass below reads.
 *
 * A pack with no asset roots is skipped and SAID: 22 of the 31 archives in a
 * typical `UserData/Mods` are plugin jars, and most of those carry no assets at
 * all. Silently opening and discarding them would make "31 packs" in the config
 * and "9 packs" in the index look like a bug.
 */
async function openPacks(
  db: Database,
  vanilla: string,
  mods: readonly string[],
): Promise<{ sources: PackSource[]; skipped: string[] }> {
  const insPack = db.prepare(
    "INSERT INTO packs (group_name, name, version, path, kind, priority) VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT (path) DO UPDATE SET name = excluded.name RETURNING id",
  );
  const sources: PackSource[] = [];
  const skipped: string[] = [];

  const add = async (path: string, kind: "vanilla" | "archive"): Promise<void> => {
    const archive = await AssetArchive.open(path);
    const carriesAssets = archive.entries.some((e) =>
      /^(Server|Common|Client)\/.+\.(json|lang)$/i.test(e.path),
    );
    if (!carriesAssets) {
      skipped.push(basename(path));
      archive.close();
      return;
    }
    const m = kind === "vanilla" ? { group: "Hytale", name: "Hytale", version: null } : await readManifest(archive);
    const row = insPack.get(
      m.group,
      m.name ?? basename(path),
      m.version,
      path,
      kind,
      kind === "vanilla" ? 3 : 2,
    ) as { id: number } | undefined;
    sources.push({ archive, packId: row?.id ?? 1 });
  };

  await add(vanilla, "vanilla");
  for (const path of mods) await add(path, "archive");
  return { sources, skipped };
}

/**
 * Marks exactly one row per logical identifier as the one the engine sees.
 *
 * Without this every query would count a mod's override and the vanilla original
 * as two assets, and `get` would pick whichever the join happened to reach first.
 * Lowest priority wins.
 *
 * Ties break on the highest pack id -- an ARBITRARY rule, and callers must be
 * told so. This comment used to claim it was "the same rule the server applies
 * to two mods claiming one id"; that was never established, and it contradicts
 * OPEN-QUESTIONS Q5, which records the equal-ordinal tiebreak as unknown. Pack
 * id is the order WE opened the archives, which is a directory walk, not a game
 * load order. Six identifiers in a real mods folder land here, so `getAssetOp`
 * reports equal-priority collisions as CONTESTED rather than naming a winner.
 *
 * **Within a type**, because identity here is (logical_id, type) and nothing
 * else -- the same rule `resolveCandidates` enforces with `a.type = src.type`
 * and the loader enforces when resolving a parent. Shadowing on the identifier
 * alone let one mod file named `Default` mark every OTHER vanilla `Default` as
 * overridden: an Environment, a GameplayConfig, a Trail, a BlockSoundSet and
 * six more types the engine never conflates. That is worse than a miscount,
 * because `sameNamed`, `sameNamedCount` and `sameNamedTypes` all filter
 * `is_effective = 1`: the collision list arrived one row long, the
 * `candidates.length > 1` guard in `getAssetOp` never fired, and an agent
 * asking for the game's `Default` Environment was handed a MovementConfig with
 * no sign anything had been chosen for it.
 *
 * `IS`, not `=`, so two untyped assets sharing an identifier still shadow each
 * other. `resolveCandidates` wants the opposite there and uses `=` on purpose
 * (an unknown type yields NULL and claims nothing); here a mod replacing an
 * untyped worldgen file must still mark the original, so NULL has to equal NULL.
 */
function markEffective(db: Database): { overridden: number } {
  db.exec("UPDATE assets SET is_effective = 0");
  db.exec(`
    UPDATE assets SET is_effective = 1
     WHERE id IN (
       SELECT a.id FROM assets a
        JOIN packs p ON p.id = a.pack_id
        WHERE NOT EXISTS (
          SELECT 1 FROM assets b JOIN packs q ON q.id = b.pack_id
           WHERE b.logical_id = a.logical_id AND b.type IS a.type
             AND (q.priority < p.priority
               OR (q.priority = p.priority AND q.id > p.id))))`);
  const row = db
    .prepare("SELECT count(*) AS n FROM assets WHERE is_effective = 0")
    .get() as { n: number } | undefined;
  return { overridden: Number(row?.n ?? 0) };
}

export interface InitArgs {
  readonly assets?: string;
  readonly jar?: string;
  readonly patchline?: string;
  readonly modsDir?: string;
  /** Where the built index goes. Omitted means the per-user cache directory. */
  readonly cacheDir?: string;
  /** Generated schema directory. Detected from the default when it exists. */
  readonly schema?: string;
  readonly mods?: readonly string[];
  readonly exclude?: readonly string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /** Where to write. Defaults to the current directory. */
  readonly cwd?: string;
}

/**
 * Writes `hytale-atlas.json`, filled in from flags and from what detection found.
 *
 * The file is OPTIONAL: with none, the tool reads the game's own install, which
 * is what makes `npx hytale-atlas` work with no setup at all. This command exists
 * for the cases detection cannot answer -- a relocated archive, two patchlines,
 * and above all which third-party packs take part in the index, which is not
 * discoverable from the game directory at all.
 *
 * **It resolves before it writes.** A config naming a path that is not there is
 * the exact failure the config layer reports at read time; writing one and only
 * finding out later would be this tool teaching the user to distrust it. So every
 * path is checked, the mod selection is expanded, and the counts are printed --
 * a person should be able to see the file did what they meant before they run
 * anything else.
 */
export async function cmdInit(args: InitArgs = {}): Promise<number> {
  const cwd = args.cwd ?? process.cwd();
  const target = join(cwd, CONFIG_FILENAME);
  const existing = findConfigFile(cwd);

  if (existsSync(target) && args.force !== true) {
    process.stderr.write(
      `${CONFIG_FILENAME} already exists here:\n  ${target}\n` +
        `Pass --force to overwrite it, or edit it directly.\n`,
    );
    return 1;
  }
  // A config FURTHER UP still applies to this directory, so writing a new one
  // here changes which file wins. Said plainly, because the surprise otherwise
  // arrives much later as "my settings stopped working".
  if (existing !== null && existing !== target) {
    process.stdout.write(
      `note: ${existing}\n` +
        `      already applies to this directory. The new file will take precedence here.\n\n`,
    );
  }

  // Detection fills whatever the flags did not, so a bare `init` produces a
  // working file rather than an empty one a reader has to research.
  const install = detectInstallation(args.patchline);
  const assets = args.assets ?? install?.assetsZip ?? null;
  const jar = args.jar ?? install?.serverJar ?? null;
  const patchline = args.patchline ?? install?.patchline ?? null;
  const modsDir =
    args.modsDir ??
    (install?.userData == null ? null : join(install.userData, "Mods"));

  const config: Record<string, unknown> = {};
  if (assets !== null) config["assets"] = assets;
  if (jar !== null) config["serverJar"] = jar;
  if (patchline !== null) config["patchline"] = patchline;
  // Written only when asked for. Emitting the default would freeze today's cache
  // location into every config file, so a later change to where caches live
  // would silently not apply to anyone who ran `init`.
  if (args.cacheDir !== undefined) config["cacheDir"] = resolve(cwd, args.cacheDir);
  // Written ABSOLUTE whenever it can be found, because the relative default is
  // the thing that breaks as soon as the tool runs from anywhere else.
  const schemaDir =
    args.schema !== undefined
      ? resolve(cwd, args.schema)
      : existsSync(resolve(cwd, DEFAULT_SCHEMA_DIR))
        ? resolve(cwd, DEFAULT_SCHEMA_DIR)
        : null;
  if (schemaDir !== null) config["schema"] = schemaDir;

  const mods: Record<string, unknown> = {};
  if (modsDir !== null && existsSync(modsDir)) mods["dir"] = modsDir;
  if (args.mods !== undefined && args.mods.length > 0) {
    mods["include"] = args.mods.map((p) => resolve(cwd, p));
  }
  if (args.exclude !== undefined && args.exclude.length > 0) {
    mods["exclude"] = [...args.exclude];
  }
  if (Object.keys(mods).length > 0) config["mods"] = mods;

  // Resolved with the same code the tool will use to read it back, so what is
  // reported here is what will actually happen -- not a second implementation
  // that can drift from the first.
  const selection = resolveMods({
    dir: (mods["dir"] as string | undefined) ?? null,
    include: (mods["include"] as string[] | undefined) ?? [],
    exclude: (mods["exclude"] as string[] | undefined) ?? [],
  });

  const problems: string[] = [...selection.problems];
  for (const [label, path] of [
    ["assets", assets],
    ["serverJar", jar],
  ] as const) {
    if (path !== null && !existsSync(path)) problems.push(`${label} does not exist: ${path}`);
  }
  if (assets === null) {
    problems.push(
      "No Assets.zip: detection found none and --assets was not given. " +
        "The index cannot be built until this is set.",
    );
  }

  const body = `${JSON.stringify(config, null, 2)}\n`;
  const lines = [
    args.dryRun === true ? `Would write ${target}:` : `Wrote ${target}:`,
    "",
    ...body.trimEnd().split("\n").map((l) => `  ${l}`),
    "",
    `Sources this selects:`,
    `  Assets.zip  ${assets ?? "(none)"}`,
    `  Server JAR  ${jar ?? "(none)"}`,
    `  Patchline   ${patchline ?? "(none)"}`,
    `  Schemas     ${schemaDir ?? "(none found -- assets will be untyped)"}`,
    `  Index at    ${
      args.cacheDir === undefined ? "(per-user cache directory)" : resolve(cwd, args.cacheDir)
    }`,
    `  Mods        ${selection.packs.length} pack(s)` +
      (selection.packs.length === 0
        ? ""
        : ` -- ${selection.packs
            .slice(0, 4)
            .map((p) => basename(p.path))
            .join(", ")}${selection.packs.length > 4 ? `, and ${selection.packs.length - 4} more` : ""}`),
    "",
  ];
  for (const problem of problems) lines.push(`PROBLEM: ${problem}`);
  if (problems.length > 0) lines.push("");
  // Multi-pack indexing has landed, so the note that used to sit here -- "selected
  // but not yet part of the index" -- became a false statement about the tool the
  // moment `openPacks` started feeding these archives to `buildSearchIndex`. It
  // survived the landing because nothing fails when prose goes stale. What a
  // reader needs now is the consequence, not a status report.
  if (selection.packs.length > 0) {
    lines.push(
      `Note: ${selection.packs.length} mod pack(s) will be indexed alongside the game.`,
      "      Answers will include their assets, and where a pack overrides a",
      "      vanilla asset the pack's version is the one you get. No pack code",
      "      is executed -- the archives are read as zip files.",
      "",
    );
  }

  if (args.dryRun !== true) writeFileSync(target, body, "utf8");
  process.stdout.write(lines.join("\n"));
  // A file that names a path which is not there is written, but the exit code
  // says something needs attention -- scripts should not treat it as clean.
  return problems.length > 0 ? 1 : 0;
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

  // The mod plugins whose code the server would load. Only .jar files: a .zip
  // pack carries assets and no code, and passing them changes nothing --
  // measured, 9 zips produced exactly the vanilla 105 schema files and loaded
  // zero plugins. Naming only the archives that actually execute keeps the
  // disclosure honest about its own scope.
  const sourcesForSchema = resolveSources({
    ...(args.assets === undefined ? {} : { assets: args.assets }),
    ...(args.patchline === undefined ? {} : { patchline: args.patchline }),
    ...(args.jar === undefined ? {} : { jar: args.jar }),
  });
  const modPlugins = sourcesForSchema.mods
    .map((m) => m.path)
    .filter((p) => p.toLowerCase().endsWith(".jar"));

  if (modPlugins.length > 0) {
    // A SECOND consent, separate from the telemetry one above, because it is a
    // different act with a different blast radius. Telemetry is data leaving the
    // machine; this is arbitrary third-party code running on it with the user's
    // own privileges. `--yes` does not cover it -- only an explicit
    // `consent.runModPlugins` or an interactive yes does.
    const consentedToRun = await askConsent({
      ...(sourcesForSchema.consent.runModPlugins ? { granted: true } : {}),
      disclosure: [
        "SCHEMAS FOR MOD-DEFINED TYPES REQUIRE RUNNING THE MODS.",
        "",
        `The server will LOAD and EXECUTE ${modPlugins.length} plugin JAR(s):`,
        ...modPlugins.slice(0, 10).map((p) => `  ${basename(p)}`),
        ...(modPlugins.length > 10 ? [`  ... and ${modPlugins.length - 10} more`] : []),
        "",
        "This is not the same as indexing them. Indexing reads archives; this",
        "runs their Java with your account's privileges -- filesystem, network,",
        "everything you can do. `--bare` does NOT prevent it: the server's own",
        "help says plugins are still loaded.",
        "",
        "There is no way to have these schemas without it. The extra types exist",
        "because the plugin code registers them at runtime; nothing is sitting in",
        "the archives waiting to be read.",
        "",
        "The bundled JRE is Java 25, where the in-process SecurityManager has been",
        "removed, so there is no sandbox inside the JVM. If you do not trust every",
        "JAR above, run this in a container or a throwaway account instead.",
      ].join("\n"),
      question: `Execute ${modPlugins.length} third-party plugin(s) to generate their schemas?`,
    });
    if (!consentedToRun) {
      process.stdout.write(
        "Declined. Generating vanilla schemas only -- mod-defined types will be absent.\n",
      );
      modPlugins.length = 0;
    }
  }

  const { path: dbPath } = await resolveDbPath({ assets: assetsZip });
  if (dbPath === null) {
    process.stderr.write("Assets.zip not found; nowhere to ingest the schemas.\n");
    return 1;
  }
  const db = openDatabase(dbPath);
  let generatorWarnings = 0;

  try {
    const { result, value } = await withGeneratedSchemas(
      {
        serverJar,
        assetsZip,
        java,
        consent: true,
        ...(modPlugins.length > 0 ? { modPlugins } : {}),
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
  // Through the shared resolver: it is what puts the mod set into the key and
  // honours a configured cache directory. Computing the key here by hand meant
  // `index` wrote to one path while every reader looked at another the moment a
  // config appeared.
  const { path: dbPath, sources: selected } = await resolveDbPath({
    ...(args.assets === undefined ? {} : { assets: args.assets }),
    ...(args.patchline === undefined ? {} : { patchline: args.patchline }),
    ...(args.schema === undefined ? {} : { schema: args.schema }),
  });
  if (dbPath === null) {
    process.stderr.write("Assets.zip not found. Set HYTALE_ROOT, or pass --assets <path>.\n");
    return 1;
  }

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

  // Third-party packs the config selected. None without a config, so the plain
  // `npx hytale-atlas` path is untouched.
  if (selected.mods.length > 0) {
    // A NOTICE, not a prompt. Indexing opens archives and reads JSON; no
    // third-party code runs, so there is nothing here to consent to -- the
    // consent this tool asks for guards code execution, and asking for one that
    // guards nothing teaches people to click through the one that does.
    //
    // Still said out loud: these packs change every answer the index gives, and
    // where one overrides a vanilla asset the pack wins.
    process.stdout.write(
      `
  Including ${selected.mods.length} third-party pack(s) from ${CONFIG_FILENAME}:
` +
        selected.mods.slice(0, 6).map((m) => `    ${basename(m.path)}
`).join("") +
        (selected.mods.length > 6 ? `    ... and ${selected.mods.length - 6} more
` : "") +
        `  Read as archives -- no plugin code is executed.

`,
    );
  }

  const db = openDatabase(dbPath);
  const { sources, skipped } = await openPacks(
    db,
    archivePath,
    selected.mods.map((m) => m.path),
  );
  const archive = sources[0]!.archive;
  process.stdout.write(`  ${formatCount(archive.size)} entries\n`);
  if (sources.length > 1) {
    process.stdout.write(`  + ${sources.length - 1} third-party pack(s) with assets\n`);
  }
  if (skipped.length > 0) {
    // Named, not silent: most jars in a mods directory are pure code, and a count
    // dropping from 31 to 9 with no explanation reads as a failure.
    process.stdout.write(
      `  ${skipped.length} archive(s) carry no assets and were skipped ` +
        `(${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ", ..." : ""})\n`,
    );
  }
  try {
    // Schema first: it supplies the path -> type map, and an asset indexed without
    // a type cannot later be told apart from a worldgen prefab or an animation.
    let resolver: TypeResolver | undefined;
    let suffixes: string[] | undefined;
    // Flag, then config, then the relative default. The default is relative to
    // the CWD, which is exactly why it belongs in the config: run from a pack
    // directory it resolves to nothing, and the whole index comes out tier 1.
    const schemaDir = selected.schema ?? DEFAULT_SCHEMA_DIR;
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

    const result = await buildSearchIndex(sources, db, {
      ...(resolver ? { types: resolver } : {}),
      ...(suffixes ? { assetSuffixes: suffixes } : {}),
      onProgress: (done, total) => {
        process.stdout.write(`\r  parsed ${formatCount(done)} / ${formatCount(total)}`);
      },
    });
    process.stdout.write("\r".padEnd(48) + "\r");

    // Overlay: exactly one row per identifier is the one the engine sees. Without
    // it a mod's override and the vanilla original both count, and `get` picks
    // whichever the join reaches first.
    const overlay = markEffective(db);
    if (overlay.overridden > 0) {
      process.stdout.write(
        `Overrides: ${formatCount(overlay.overridden)} vanilla asset(s) replaced by a pack
`,
      );
    }

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

/**
 * Delegates rather than repeating. This used to be a second copy of `openIndex`
 * -- same resolve, same existence check, different error wording -- and it drifted
 * in the way that matters: `openIndex` grew a readiness gate and this one did not,
 * so every CLI read command would answer from a half-built index.
 */
async function frozenDb(assets: string | undefined, patchline: string | undefined) {
  const options = {
    ...(assets === undefined ? {} : { assets }),
    ...(patchline === undefined ? {} : { patchline }),
  };
  try {
    return await openIndex(options);
  } catch (error) {
    // The index is content-addressed over its SOURCES, so installing, removing or
    // updating a mod produces a different cache key and the old database simply
    // is not the answer to the new question. Until now that surfaced as "No index
    // yet. Build it first." -- technically true and useless: nothing had gone
    // wrong, the corpus had merely moved, and the reader was left to guess which
    // of their mods did it. Rebuilding is the only correct response, so do it.
    const message = error instanceof Error ? error.message : String(error);
    if (!/No index yet|INCOMPLETE|STALE/.test(message)) throw error;
    process.stderr.write(
      "Sources changed since the last index -- rebuilding before answering.\n",
    );
    // FORCE, always. We are here because the existing database cannot answer the
    // question -- wrong source set, or a run that never finished. Without this
    // `cmdIndex` sees a file on disk, prints "Use --force to rebuild", returns
    // success, and the very next read fails the same way: a loop that reports no
    // error and makes no progress.
    const code = await cmdIndex({ ...options, force: true });
    if (code !== 0) throw error;
    return await openIndex(options);
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
    const result = searchAssetsOp(db, query, args.limit, args.type);
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
  args: { assets?: string; patchline?: string; raw?: boolean; type?: string; pack?: string },
): Promise<number> {
  // One resolver, one wording. This used to call a near-copy of `resolveArchive`
  // that threw a differently-phrased error for the same condition, so fixing the
  // message in one place left the other stale.
  const archivePath = await resolveArchive(args.assets, args.patchline);
  const db = await frozenDb(args.assets, args.patchline);
  const archive = await AssetArchive.open(archivePath);

  try {
    // The ORDER BY must match the disambiguation note's exactly. It did not: the
    // note ordered by (is_effective, type) and the loader by is_effective alone,
    // leaving SQLite to break the tie by rowid. So `get Plant_Bush` announced
    // "Showing the Item one" and then printed the ItemDropList -- handing over the
    // wrong file while stating the right one.
    // Pack-aware: an asset can live in any indexed archive now, and a parent
    // chain routinely crosses from a mod into vanilla.
    const { load, close, unreadable } = packAssetLoader(
      db,
      args.type,
      ...(args.pack === undefined ? [] : [{ logicalId, pack: args.pack }]),
    );
    const result = await getAssetOp(
      db,
      logicalId,
      load,
      args.type,
      args.raw === true,
      args.pack,
      unreadable,
    );
    close();
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
      process.stdout.write(benchesOp(db, args.limit).text ?? "");
      return 0;
    }
    const result = benchOp(db, benchId, args.limit);
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
    const result = refsAnyOp(db, logicalId, args.type, args.limit);
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
    const result = langOp(db, query, args.limit);
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
    const result = searchSchemaOp(db, query, args.limit);
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
    // Renders nothing of its own. The unresolved-type and nothing-unused
    // branches used to be printed here, which made this the last command whose
    // answer differed by front end -- and the difference landed on the one
    // question `search-schema` sends a reader here to settle.
    const result = undocumentedOp(db, args.type, args.limit);
    const miss = result.value.found === false;
    (miss ? process.stderr : process.stdout).write(result.text ?? "");
    return miss ? 1 : 0;
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

export interface McpInstallArgs {
  readonly client?: string;
  readonly all?: boolean;
}

/**
 * Prints how to register this server with each AI client.
 *
 * Prints only. See mcp-install.ts for why nothing is written: the value a
 * command adds over the README is the absolute paths, and that is all it adds.
 */
export function cmdMcpInstall(args: McpInstallArgs): number {
  const all = targets();
  const chosen =
    args.client !== undefined
      ? all.filter((t) => t.id === args.client)
      : args.all === true
        ? all
        : all.filter(detected);

  if (args.client !== undefined && chosen.length === 0) {
    process.stderr.write(
      `Unknown client '${args.client}'. Known: ${all.map((t) => t.id).join(", ")}\n`,
    );
    return 2;
  }

  const { command, args: launchArgs } = launchCommand();
  const out: string[] = [`Server:  ${command} ${launchArgs.join(" ")}\n\n`];

  if (chosen.length === 0) {
    out.push(`No AI client detected here. --all lists all ${all.length} anyway.\n`);
    process.stdout.write(out.join(""));
    return 0;
  }

  if (args.client === undefined && args.all !== true) {
    out.push(`Detected ${chosen.length} of ${all.length} known clients. --all for the rest.\n\n`);
  }

  for (const t of chosen) {
    out.push(`${t.label}\n`);
    if (t.cli !== undefined) {
      out.push(`  ${t.cli}\n`);
      out.push(`  or edit ${t.file}:\n`);
    } else {
      out.push(`  edit ${t.file}:\n`);
    }
    for (const l of snippet(t).split("\n")) out.push(l.length > 0 ? `    ${l}\n` : "");
    out.push("\n");
  }

  out.push("Merge into what is already there -- these show the key, not the whole file.\n");
  out.push(
    "\nA client that wants a URL instead of a command: run 'hytale-atlas serve'\n" +
      `and point it at http://127.0.0.1:${DEFAULT_HTTP_PORT}/mcp\n`,
  );
  process.stdout.write(out.join(""));
  return 0;
}
