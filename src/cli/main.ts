#!/usr/bin/env node
import { detectInstallation, detectProject } from "../sources/detect.ts";
import {
  cmdBench,
  cmdDescribe,
  cmdEval,
  cmdGenerateSchema,
  cmdGet,
  cmdIndex,
  cmdSearch,
  cmdSearchSchema,
  cmdUndocumented,
  indexSummary,
} from "./commands.ts";

/**
 * CLI entry point.
 *
 * Everything the MCP server does must also be reachable from here. That parity is
 * what makes the system testable without an agent in the loop, which matters more
 * for iteration speed than almost anything else — see
 * `docs/init/03-ARCHITECTURE.md` §Component boundaries.
 */

/**
 * Help text, audited line by line against what the code actually does.
 *
 * It had drifted, and every drift was the same failure this tool exists to avoid
 * -- a confident statement that is not true. It claimed `search` defaulted to 20
 * when the code used 10; that `status` reported an epoch and coverage, neither of
 * which it prints; that `clean` and `--mcp` worked, when `clean` prints "not
 * implemented" and `--mcp` is not read at all -- the flag falls through and runs
 * the INDEXER, so an MCP client pointed at it would silently build an index
 * instead of serving. `--raw` existed and was listed nowhere.
 *
 * Anything stated here must be checked against behaviour, not intent.
 */
const USAGE = `hytale-atlas — unofficial local index of Hytale assets

  hytale-atlas                 Same as 'index': build if absent, report if present
  hytale-atlas status          Where the game is, which patchline, which tier, and
                               what the built index contains
  hytale-atlas index           Build the corpus index (cached globally, ~40s)
  hytale-atlas search <query>  Search assets in any indexed locale
  hytale-atlas get <id>        Effective definition, with the parent chain resolved
                               (the only high-token command). Identifiers are NOT
                               unique across types -- add --type <Type> to choose.
  hytale-atlas describe <Type> Schema for a type: declared and observed layers.
                               Shared types need their namespace: 'common:ItemTool',
                               not 'ItemTool'. Add --field <pointer> for one field,
                               which also prints its full description and every
                               observed value.
  hytale-atlas search-schema <q>  Where a capability lives. A miss is reported as
                               evidence, not proof: the index is lexical.
  hytale-atlas bench [id]      Crafting benches; with an id, what it crafts
  hytale-atlas undocumented [Type]  Fields the schema permits that vanilla never
                               uses; with a type, scoped to it
  hytale-atlas eval            Run the search evaluation set, recall@5 per tier
  hytale-atlas generate-schema Run the game's own schema generator, then ingest
                               (starts the server binary; it sends telemetry)

Not implemented yet -- these exit 2 rather than pretending
  hytale-atlas validate        Pack validation. Every input exists; the command
                               does not.
  hytale-atlas clean [--all]   Dropping the index or the global cache.
  hytale-atlas --mcp           Serving MCP over stdio.

Options
  --assets <path>              Explicit Assets.zip override
  --jar <path>                 Explicit HytaleServer.jar override
  --patchline <name>           Select a non-active patchline
  --force                      Rebuild even if a cached index exists
  --yes                        Accept the telemetry disclosure without prompting
  --dry-run                    Print the command that would run, and exit
  --keep <path>                Keep generated schema files instead of discarding
  --schema <path>              Use an already-generated schema directory
  --field <pointer>            Single field for describe, e.g. --field /Tool/Speed
                               (the leading slash is optional, and helps: some
                               shells rewrite a leading slash into a path)
  --type <Type>                Disambiguate 'get' when several assets share a name
  --raw                        'get' prints the effective JSON and nothing else
  --limit <n>                  Result cap. Defaults: search 20, search-schema 20,
                               describe 60, undocumented 40, bench 200. Every one
                               of them says so when it truncates.
  --set <path>                 Evaluation set (default docs/evaluation/search-phrases.json)
  -h, --help                   This message
`;

interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
  /** Positional arguments after the command, e.g. the search query. */
  readonly rest: readonly string[];
}

/**
 * Every flag the CLI accepts.
 *
 * Unknown flags used to be collected and then ignored, which is worse than
 * rejecting them: `get Pickaxe --typ Item` returned a DIFFERENT asset than
 * intended, silently, because the disambiguation was dropped and nothing said so.
 * `describe Item --feild Recipe` likewise fell back to the full 96-field dump.
 */
/** Flags that require a value. Everything else is a switch. */
const VALUE_FLAGS = new Set([
  "assets",
  "jar",
  "patchline",
  "keep",
  "schema",
  "field",
  "limit",
  "set",
  "type",
]);

const SWITCH_FLAGS = new Set(["force", "yes", "dry-run", "raw", "all", "mcp", "help"]);

const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...SWITCH_FLAGS]);

/** Nearest known flag by single-edit distance, for a typo suggestion. */
function nearestFlag(name: string): string | null {
  for (const known of KNOWN_FLAGS) {
    if (known === name) return known;
    if (Math.abs(known.length - name.length) > 2) continue;
    // Cheap similarity: same first letter and a shared majority of characters.
    if (known[0] !== name[0]) continue;
    const shared = [...new Set(name)].filter((c) => known.includes(c)).length;
    if (shared >= Math.max(2, Math.min(known.length, name.length) - 1)) return known;
  }
  return null;
}

export class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  let command = "index";
  let seenCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // `--key=value` as well as `--key value`. Rejecting the equals form left a
      // circular message -- "Unknown option '--limit=0'. Did you mean '--limit'?"
      // -- that never said which syntax was expected, and --help did not say either.
      const equals = a.indexOf("=");
      const key = equals < 0 ? a.slice(2) : a.slice(2, equals);
      const inlineValue = equals < 0 ? undefined : a.slice(equals + 1);

      if (!KNOWN_FLAGS.has(key)) {
        const near = nearestFlag(key);
        throw new UsageError(
          `Unknown option '--${key}'.` + (near !== null ? ` Did you mean '--${near}'?` : ""),
        );
      }

      if (SWITCH_FLAGS.has(key)) {
        if (inlineValue !== undefined) {
          throw new UsageError(`--${key} takes no value.`);
        }
        flags.set(key, true);
        continue;
      }

      if (inlineValue !== undefined) {
        flags.set(key, inlineValue);
        continue;
      }
      // The next argument is the value even when it starts with a dash, so
      // `--limit -5` reaches the validator that can explain itself instead of
      // being intercepted as an unknown option that never mentions --limit.
      const next = argv[i + 1];
      if (next === undefined) {
        // Previously accepted and then ignored, so a dropped value behaved
        // exactly like passing no flag at all, with nothing said.
        throw new UsageError(`--${key} needs a value, e.g. --${key} <value>.`);
      }
      flags.set(key, next);
      i++;
    } else if (a.startsWith("-") && a.length > 1 && a !== "-h") {
      // A single dash reads as a flag to a user and as a positional to a parser,
      // so `-type Item` was accepted as a search term and the intent lost.
      throw new UsageError(`Unknown option '${a}'. Long options take two dashes.`);
    } else if (a === "-h") {
      flags.set("help", true);
    } else if (!seenCommand) {
      command = a;
      seenCommand = true;
    } else {
      rest.push(a);
    }
  }
  // Validated here, not where the value is read, so the diagnostic does not
  // depend on argument order. `search --limit pickaxe` consumed the query as the
  // limit and then failed with "usage: search <query>" -- reporting a missing
  // query when one was plainly given, and sending the reader after the wrong fix.
  const limit = flags.get("limit");
  if (typeof limit === "string") {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`--limit takes a positive whole number, not '${limit}'.`);
    }
  }

  return { command, flags, rest };
}

/**
 * Reports what we can see without touching the index.
 *
 * `status` must be answerable even on a cold cache, so an agent that finds the
 * server unready can diagnose why rather than guess (`docs/init/06-CLI-UX.md`).
 */
async function cmdStatus(args: Args): Promise<number> {
  const patchlineFlag = args.flags.get("patchline");
  const install = detectInstallation(
    typeof patchlineFlag === "string" ? patchlineFlag : undefined,
  );
  const project = detectProject();

  const lines: string[] = [];
  lines.push(`Project:     ${project.kind}  (${project.root})`);

  if (!install) {
    lines.push("Hytale:      not found");
    lines.push("");
    lines.push("Set HYTALE_ROOT, or pass --assets to point at an archive directly.");
    process.stdout.write(lines.join("\n") + "\n");
    return 1;
  }

  lines.push(`Install:     ${install.root}`);
  lines.push(
    `Patchline:   ${install.patchline}` +
      (install.availablePatchlines.length > 1
        ? `  (also present: ${install.availablePatchlines
            .filter((p) => p !== install.patchline)
            .join(", ")})`
        : ""),
  );
  lines.push(`Assets.zip:  ${install.assetsZip ?? "not found"}`);
  lines.push(`Server JAR:  ${install.serverJar ?? "not found"}`);
  lines.push(`Bundled JVM: ${install.bundledJava ?? "not found"}`);
  lines.push(`UI language: ${install.uiLanguage ?? "unknown"}  (display only; search covers every indexed locale)`);

  // Tiers per docs/init/06-CLI-UX.md. Tier 2 needs the JAR *and* a JVM to run it;
  // the game bundles one, so this is the normal case rather than the lucky one.
  const tier1 = install.assetsZip !== null;
  const tier2 = tier1 && install.serverJar !== null && install.bundledJava !== null;
  const tier3 = project.kind !== "none";

  const tiers = [tier1 && "1", tier2 && "2", tier3 && "3"].filter(Boolean).join(" + ");
  lines.push(`Tier:        ${tiers || "none — no sources found"}`);
  if (tier1 && !tier2) {
    lines.push("             schema answers unavailable; pass --jar to enable tier 2");
  }

  // Reported from the cache itself rather than from a constant. This line read
  // "not built (indexing is not implemented yet)" long after indexing worked, so
  // status contradicted every other command and made the tool look broken.
  const assetsFlag = args.flags.get("assets");
  lines.push(
    `Index:       ${await indexSummary(
      typeof assetsFlag === "string" ? assetsFlag : undefined,
      typeof patchlineFlag === "string" ? patchlineFlag : undefined,
    )}`,
  );

  process.stdout.write(lines.join("\n") + "\n");
  return install.assetsZip ? 0 : 1;
}


function main(): number | Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has("help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Refused explicitly. The flag was documented as "Serve MCP over stdio" and
  // then never read, so it fell through to the default command and ran the
  // INDEXER -- an MCP client configured with it would have built an index and
  // reported success while serving nothing.
  if (args.flags.has("mcp")) {
    process.stderr.write(
      "The MCP server is not implemented yet, and --mcp does nothing.\n" +
        "Everything it would expose is reachable from this CLI meanwhile:\n" +
        "  search, get, describe, search-schema, bench, undocumented\n",
    );
    return 2;
  }

  switch (args.command) {
    case "status":
      return cmdStatus(args);
    case "index":
      return cmdIndex(opts(args));
    case "search": {
      const query = args.rest.join(" ");
      if (query.length === 0) {
        process.stderr.write("usage: hytale-atlas search <query>\n");
        return 2;
      }
      return cmdSearch(query, opts(args));
    }
    case "get": {
      const id = args.rest[0];
      if (id === undefined) {
        process.stderr.write("usage: hytale-atlas get <asset-id>\n");
        return 2;
      }
      return cmdGet(id, opts(args));
    }
    case "describe": {
      const type = args.rest[0];
      if (type === undefined) {
        process.stderr.write("usage: hytale-atlas describe <AssetType> [--field <pointer>]\n");
        return 2;
      }
      // A second positional used to be swallowed in silence: `describe Item Tool`
      // returned the identical full dump, so it read as "Item.Tool has 96 fields".
      if (args.rest.length > 1) {
        process.stderr.write(
          `describe takes one type. Did you mean:\n` +
            `  hytale-atlas describe ${type} --field /${args.rest.slice(1).join("/")}\n`,
        );
        return 2;
      }
      return cmdDescribe(type, opts(args));
    }
    case "search-schema": {
      const query = args.rest.join(" ");
      if (query.length === 0) {
        process.stderr.write("usage: hytale-atlas search-schema <query>\n");
        return 2;
      }
      return cmdSearchSchema(query, opts(args));
    }
    case "bench":
      return cmdBench(args.rest[0], opts(args));
    case "undocumented":
      // The positional was accepted and then dropped, so `undocumented ItemToolSpec`
      // returned the whole unscoped corpus and looked like an answer.
      return cmdUndocumented({ ...opts(args), ...(args.rest[0] ? { type: args.rest[0] } : {}) });
    case "eval":
      return cmdEval(opts(args));
    case "generate-schema":
      return cmdGenerateSchema(opts(args));
    case "validate":
    case "clean":
      // Non-zero on purpose: a caller scripting against this must not read
      // "not implemented" as success, and --help lists both under the same
      // heading so the two agree.
      process.stderr.write(
        `'${args.command}' is not implemented yet -- see 'hytale-atlas --help'.\n` +
          `The index lives under the path 'hytale-atlas status' prints; ` +
          `deleting that directory is the manual equivalent of 'clean'.\n`,
      );
      return 2;
    default:
      process.stderr.write(`Unknown command '${args.command}'.\n\n${USAGE}`);
      return 2;
  }
}

function opts(args: Args) {
  const str = (k: string): string | undefined => {
    const v = args.flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = str(k);
    if (v === undefined) return undefined;
    // Validated here rather than passed through. `--limit abc` reached SQLite and
    // surfaced a raw 'datatype mismatch'; `--limit 0` and `--limit -1` printed
    // "No matches." for a query with dozens of them, indistinguishable from a
    // genuinely empty result -- and SQLite reads LIMIT -1 as "no limit", so the
    // one value a user might expect to mean "all" returned none.
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`--${k} takes a positive whole number, not '${v}'.`);
    }
    return n;
  };
  return {
    ...(str("assets") !== undefined ? { assets: str("assets")! } : {}),
    ...(str("patchline") !== undefined ? { patchline: str("patchline")! } : {}),
    ...(str("set") !== undefined ? { set: str("set")! } : {}),
    ...(str("schema") !== undefined ? { schema: str("schema")! } : {}),
    ...(num("limit") !== undefined ? { limit: num("limit")! } : {}),
    ...(str("jar") !== undefined ? { jar: str("jar")! } : {}),
    ...(str("keep") !== undefined ? { keep: str("keep")! } : {}),
    ...(str("field") !== undefined ? { field: str("field")! } : {}),
    ...(str("type") !== undefined ? { type: str("type")! } : {}),
    ...(args.flags.has("force") ? { force: true } : {}),
    ...(args.flags.has("yes") ? { yes: true } : {}),
    ...(args.flags.has("dry-run") ? { dryRun: true } : {}),
    ...(args.flags.has("raw") ? { raw: true } : {}),
  };
}

/** Usage errors exit 2 and print only their message; anything else is a fault. */
function runMain(): number | Promise<number> {
  try {
    return main();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\nRun 'hytale-atlas --help' for the full list.\n`);
      return 2;
    }
    throw err;
  }
}

const code = runMain();
if (code instanceof Promise) {
  code.then(
    (c) => {
      process.exitCode = c;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
} else {
  process.exitCode = code;
}
