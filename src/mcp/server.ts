import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { existsSync } from "node:fs";

import { openIndex, resolveDbPath } from "../api/operations.ts";
import { cmdIndex } from "../cli/commands.ts";
import { getMeta, openDatabase, pipelineState } from "../db/open.ts";
import { PIPELINE_VERSION } from "../db/schema.ts";
import { AssetArchive } from "../sources/archive.ts";
import { detectInstallation } from "../sources/detect.ts";
import { TOOLS, type ToolContext, callTool } from "./tools.ts";

/**
 * MCP over stdio.
 *
 * **stdout carries the protocol.** Nothing else may write to it, ever: a single
 * stray line corrupts the JSON-RPC stream and the client sees a parse error
 * rather than an answer. The operations in `src/api` are pure -- they return
 * values and never print -- which is what makes serving them safe, and is worth
 * stating because the CLI layer beside them writes to stdout constantly. Any
 * diagnostic here goes to stderr.
 *
 * The index is opened once and shared. It is a frozen, read-only SQLite file
 * (`docs/INDEXING.md`), so concurrent tool calls need no coordination; the
 * archive is opened lazily because only `get` reads it and its central directory
 * costs about four seconds.
 */

const SERVER_INFO = { name: "hytale-atlas", version: "0.0.0" } as const;

/**
 * Told to the model once, at connect time.
 *
 * The two sentences that matter most are the ones every blind trial needed: this
 * index is lexical, and a caveat is data. Without them a model reads "no match"
 * as "the game does not have it" -- the single defect class this project keeps
 * finding.
 */
const INSTRUCTIONS = `Unofficial local index of Hytale's asset corpus, for authoring mods.

Every result is { value, caveats }. The caveats are DATA, not decoration: they
say when a list was truncated, when a query was loosened, when a count precedes
inheritance, and when absence is weak evidence. Read them before concluding
anything negative.

Two limits worth knowing before you draw a conclusion:
- The schema search is LEXICAL. A miss means these words are absent, not that
  the capability is. Try other wording before reporting that something cannot
  be done.
- 20,202 untyped world and prefab assets are indexed and searchable but
  contribute no references, so a reference list can be incomplete by design.

Identifiers are not unique across types: 442 of them name more than eight
assets. Pass 'type' wherever a tool offers it.

THIRD-PARTY PACKS. This index may hold assets from installed mods alongside the
game's own. They are NOT distinguishable by identifier -- some packs prefix
theirs, most do not -- so never infer "this is vanilla" from a name. The get and
search tools report the owning pack, and a third-party caveat names it. An
answer built on a modded asset only works for someone who has that mod.`;

/**
 * Builds the index if it is missing, stale or half-written, before serving.
 *
 * A client starts this process and expects a server; it has no way to be told
 * "run a build first". Left to fail, `openIndex` throws and the client reports
 * only that the server died.
 *
 * **Staleness is addressed, not detected.** `frozenKey` hashes the archive's
 * path, size and mtime, and `SCHEMA_VERSION` is part of the directory, so a new
 * game build or a schema bump lands on a different path and simply reads as
 * "not built". The one case that needs a real check is a database that EXISTS
 * but is unusable -- an interrupted build leaves the file behind, and every
 * later run would happily open an empty corpus and answer "no such asset" about
 * everything.
 */
async function ensureIndex(options: { assets?: string; patchline?: string }): Promise<void> {
  const { path: dbPath } = await resolveDbPath(options);
  if (dbPath === null) {
    throw new Error(
      "Assets.zip not found, so the index cannot be built. " +
        "Set HYTALE_ROOT or pass --assets <path>.",
    );
  }

  let reason: string | null = null;
  if (!existsSync(dbPath)) {
    reason = "no index for this Assets.zip";
  } else {
    // The completion marker, not a row count. Counting assets catches an EMPTY
    // database and misses a half-written one: stages commit separately, so a
    // build that died after the corpus walk leaves 35 074 assets, zero edges and
    // zero field stats -- which opens cleanly and answers "nothing references
    // that" about everything. `pipelineState` is what `status` reports, so the
    // server cannot decide an index is usable while status calls it broken.
    try {
      const probe = openDatabase(dbPath, { readOnly: true });
      try {
        const state = pipelineState(probe);
        if (state === "incomplete") {
          reason = "the existing index is incomplete (a build that did not finish)";
        } else if (state === "stale") {
          reason = `the existing index was built by an older indexer (pipeline ${
            getMeta(probe, "pipeline") ?? "?"
          }, now ${PIPELINE_VERSION})`;
        }
      } finally {
        probe.close();
      }
    } catch (err) {
      reason = `index is unreadable (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  if (reason === null) return;

  process.stderr.write(`hytale-atlas: ${reason}; building it now (about a minute).\n`);

  // Indexing prints progress to stdout, and stdout is the protocol stream -- a
  // client is already listening on it. This runs BEFORE the transport is
  // connected, so nothing else can be writing, and the redirect is torn down in
  // `finally` before anything else happens. That ordering is what makes it safe
  // here and unsafe anywhere else in this server.
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string") return process.stderr.write(chunk);
    return (realOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  let code: number;
  try {
    code = await cmdIndex({
      ...(options.assets === undefined ? {} : { assets: options.assets }),
      ...(options.patchline === undefined ? {} : { patchline: options.patchline }),
      // Force only when a file is in the way; a missing one needs no override.
      ...(existsSync(dbPath) ? { force: true } : {}),
    });
  } finally {
    process.stdout.write = realOut;
  }
  if (code !== 0) throw new Error(`indexing failed with exit code ${code}`);
  process.stderr.write("hytale-atlas: index ready.\n");
}

export async function serveMcp(options: { assets?: string; patchline?: string } = {}): Promise<number> {
  await ensureIndex(options);
  const db = await openIndex(options);

  // Typed explicitly: TypeScript narrows the closure's assignment away and then
  // reports the cleanup below as unreachable on `never`.
  let archive: AssetArchive | null = null as AssetArchive | null;
  const context: ToolContext = {
    db,
    options,
    openArchive: async () => {
      if (archive === null) {
        const path =
          options.assets ?? detectInstallation(options.patchline)?.assetsZip ?? null;
        if (path === null) throw new Error("Assets.zip not found; cannot read documents.");
        archive = await AssetArchive.open(path);
      }
      return archive;
    },
  };

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(context, name, (args ?? {}) as Record<string, unknown>);
      // Serialised whole, caveats included. A summary here would be this layer
      // deciding what matters, which is the divergence `src/api` exists to
      // prevent.
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // A THROW is a tool failure -- the index is unreadable, the archive is
      // missing. A question with no answer is not: those return `found: false`
      // from callTool, because "no such asset" is frequently the finding and
      // must not reach the model as a broken call.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `hytale-atlas MCP server on stdio: ${TOOLS.length} tools, index ready.\n`,
  );

  // Resolves when the client disconnects, so the caller can close cleanly.
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });

  archive?.close();
  db.close();
  return 0;
}
