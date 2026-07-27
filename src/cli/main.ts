#!/usr/bin/env node
import { detectInstallation, detectProject } from "../sources/detect.ts";
import { cmdEval, cmdIndex, cmdSearch } from "./commands.ts";

/**
 * CLI entry point.
 *
 * Everything the MCP server does must also be reachable from here. That parity is
 * what makes the system testable without an agent in the loop, which matters more
 * for iteration speed than almost anything else — see
 * `docs/init/03-ARCHITECTURE.md` §Component boundaries.
 */

const USAGE = `hytale-atlas — unofficial local index of Hytale assets

  hytale-atlas                 Detect, index, report. Idempotent.
  hytale-atlas status          Sources, patchline, tier, epoch, coverage
  hytale-atlas index           Build the corpus index (cached globally)
  hytale-atlas search <query>  Search assets in any indexed locale
  hytale-atlas eval            Run the search evaluation set, recall@5 per tier
  hytale-atlas --mcp           Serve MCP over stdio (requires a warm cache)
  hytale-atlas validate        Run pack validation; non-zero exit on errors
  hytale-atlas clean [--all]   Drop this project's index, or the global cache

Options
  --assets <path>              Explicit Assets.zip override
  --jar <path>                 Explicit HytaleServer.jar override
  --patchline <name>           Select a non-active patchline
  --force                      Rebuild even if a cached index exists
  --limit <n>                  Result limit for search
  --set <path>                 Evaluation set (default docs/evaluation/search-phrases.json)
  -h, --help                   This message
`;

interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
  /** Positional arguments after the command, e.g. the search query. */
  readonly rest: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  let command = "index";
  let seenCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (a === "-h") {
      flags.set("help", true);
    } else if (!seenCommand) {
      command = a;
      seenCommand = true;
    } else {
      rest.push(a);
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
function cmdStatus(args: Args): number {
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

  lines.push("Index:       not built (indexing is not implemented yet)");

  process.stdout.write(lines.join("\n") + "\n");
  return install.assetsZip ? 0 : 1;
}

function main(): number | Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has("help")) {
    process.stdout.write(USAGE);
    return 0;
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
    case "eval":
      return cmdEval(opts(args));
    case "validate":
    case "clean":
      process.stderr.write(
        `'${args.command}' is not implemented yet. Try 'hytale-atlas status'.\n`,
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
    return v === undefined ? undefined : Number(v);
  };
  return {
    ...(str("assets") !== undefined ? { assets: str("assets")! } : {}),
    ...(str("patchline") !== undefined ? { patchline: str("patchline")! } : {}),
    ...(str("set") !== undefined ? { set: str("set")! } : {}),
    ...(str("schema") !== undefined ? { schema: str("schema")! } : {}),
    ...(num("limit") !== undefined ? { limit: num("limit")! } : {}),
    ...(args.flags.has("force") ? { force: true } : {}),
  };
}

const code = main();
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
