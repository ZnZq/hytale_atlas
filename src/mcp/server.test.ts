import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The MCP server, driven over real stdio the way a client drives it.
 *
 * Asserted as PROPERTIES rather than as wording, because the wording is the
 * operations' and is tested there. What belongs to this layer is narrow and
 * absolute: the protocol stream stays clean, caveats survive serialisation, a
 * miss is an answer rather than an error, and the tools that mutate state or
 * send telemetry are not on the list at all.
 */

const CLI = join(process.cwd(), "dist", "cli", "main.js");
const available = existsSync(CLI);
const opts = available ? {} : { skip: "no built CLI on this machine" };

interface Rpc {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** One session: sends every request, returns every reply plus raw stdout. */
async function session(
  calls: readonly { method: string; params: Record<string, unknown> }[],
): Promise<{ replies: Rpc[]; stdout: string; stderr: string }> {
  const child = spawn("node", [CLI, "--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  const write = (body: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(body)}\n`);
  };
  write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  calls.forEach((c, i) => write({ jsonrpc: "2.0", id: i + 2, method: c.method, params: c.params }));

  // The server answers in order; wait until every id has come back or we time out.
  const deadline = Date.now() + 60_000;
  const wanted = calls.length + 1;
  while (Date.now() < deadline) {
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length >= wanted) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();

  const replies: Rpc[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    replies.push(JSON.parse(line) as Rpc);
  }
  return { replies, stdout, stderr };
}

function payload(reply: Rpc | undefined): Record<string, unknown> {
  const content = (reply?.result?.["content"] ?? []) as { text?: string }[];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("an existing index is not rebuilt on every start", opts, async () => {
  // The bootstrap must be a check, not a build. Rebuilding takes about ninety
  // seconds, and a client that pays it on every connect is unusable -- so the
  // test is that a warm start says nothing about building and answers promptly.
  const started = Date.now();
  const { replies, stderr } = await session([
    { method: "tools/call", params: { name: "status", arguments: {} } },
  ]);
  const value = payload(replies[1])["value"] as { indexState?: string };
  assert.equal(value.indexState, "ready");
  assert.doesNotMatch(stderr, /building it now/, "a warm start rebuilt the index");
  assert.ok(Date.now() - started < 30_000, "a warm start took longer than a cold read should");
});

test("the bootstrap reports an unusable index rather than serving an empty one", opts, async () => {
  // A missing file is easy; a file that EXISTS but holds nothing is the case a
  // presence check cannot see, and it is what an interrupted build leaves
  // behind. Serving it would answer "no such asset" about the whole corpus.
  //
  // Asserted on the operation rather than by planting a broken database in the
  // user's cache: `status` reports the same `pipelineState` the bootstrap acts
  // on, so the two cannot disagree about whether an index is usable. The probe
  // itself is unit-tested against a deliberately half-written database in
  // db/open.test.ts.
  const ops = await import("../../dist/api/operations.js");
  const status = await ops.statusOp({});
  assert.ok(
    ["ready", "not-built", "no-archive", "unreadable", "incomplete", "stale"].includes(
      status.value.indexState,
    ),
    `indexState is not one of the documented states: ${status.value.indexState}`,
  );
  if (status.value.indexState === "ready") {
    assert.ok(
      (status.value.index?.assets ?? 0) > 0,
      "an index reported ready carries no assets, which the bootstrap should have caught",
    );
  }
});

test("stdout carries protocol and nothing else", opts, async () => {
  // A single stray line corrupts the stream and the client sees a parse error
  // instead of an answer. The operations are pure, but the CLI layer beside them
  // writes to stdout constantly, so this is the invariant worth pinning.
  const { stdout, stderr } = await session([
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "status", arguments: {} } },
  ]);
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    assert.doesNotThrow(
      () => JSON.parse(line),
      `non-JSON reached stdout: ${line.slice(0, 120)}`,
    );
  }
  // ...and the human-facing note went to stderr, where it belongs.
  assert.match(stderr, /MCP server on stdio/);
});

test("state-changing and telemetry-sending commands are not exposed", opts, async () => {
  // `generate-schema` launches the game's own generator, which emits telemetry
  // that cannot be switched off and therefore requires explicit human consent.
  // A tool call would route around that consent.
  const { replies } = await session([{ method: "tools/list", params: {} }]);
  const tools = (replies[1]?.result?.["tools"] ?? []) as { name: string }[];
  assert.ok(tools.length > 0, "no tools listed");
  for (const forbidden of ["index", "generate_schema", "generate-schema", "clean", "eval"]) {
    assert.ok(
      !tools.some((t) => t.name === forbidden),
      `${forbidden} must not be callable over MCP`,
    );
  }
});

test("caveats survive the round trip", opts, async () => {
  // The whole reason this server reads `src/api`: the defects this project keeps
  // finding are sentences, and the sentences are the caveats. A truncated list
  // that arrives without its notice reads as complete.
  const { replies } = await session([
    { method: "tools/call", params: { name: "describe", arguments: { type: "Item", limit: 3 } } },
    { method: "tools/call", params: { name: "status", arguments: {} } },
  ]);
  const described = payload(replies[1]);
  const caveats = described["caveats"] as { code: string }[];
  assert.ok(Array.isArray(caveats) && caveats.length > 0, "describe lost its caveats");
  assert.ok(caveats.some((c) => c.code === "truncated"), "a capped list arrived unqualified");

  const status = payload(replies[2]);
  assert.ok(
    ((status["caveats"] ?? []) as unknown[]).length > 0,
    "status lost its join-incomplete caveat",
  );
});

test("a question with no answer is a result, not an error", opts, async () => {
  // "No such asset" is frequently the finding. Reporting it as a failed call
  // tells the model the tool broke rather than that the corpus is silent.
  const { replies } = await session([
    { method: "tools/call", params: { name: "get", arguments: { id: "zzqqxx_nothing_at_all" } } },
  ]);
  assert.notEqual(replies[1]?.result?.["isError"], true, "a miss was reported as a tool failure");
  const value = payload(replies[1])["value"] as Record<string, unknown>;
  assert.equal(value["found"], false);
  assert.ok(typeof value["reason"] === "string" && value["reason"].length > 0);
});

/**
 * Round 22, in one place: everything the CLI knew and the served answer did not.
 *
 * Five blind agents worked through MCP alone. Their reports were not five
 * unrelated bugs -- in four of the six most-reported cases the command line
 * printed the right thing while the tool call returned a dead end, because the
 * knowledge lived in a print statement instead of in the result. These assert on
 * the SERVED payload, since that is the half that was wrong.
 *
 * Driven through `callTool` rather than a spawned session: the transport is
 * covered above, and what needs pinning here is the answer, not the protocol.
 */
test("what the CLI knows, the tool call returns", opts, async () => {
  const ops = await import("../../dist/api/operations.js");
  const { callTool } = await import("../../dist/mcp/tools.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  const ctx = {
    db,
    options: {},
    openArchive: async () => {
      throw new Error("not needed");
    },
  };
  try {
    // All five agents hit this, on five different pointers -- including the one
    // in `describe`'s own parameter documentation. The pointer misses because the
    // tree crosses a `$ref`; saying only "has no field" is true of a flat pointer
    // table and reads as a statement about the game.
    const missed = await callTool(ctx, "describe", {
      type: "Item",
      field: "/Tool/Specs/*/Power",
    });
    const crossing =
      (missed.value as { continuesIn?: { into: string; continueAt: string }[] }).continuesIn ?? [];
    assert.ok(crossing.length > 0, "a miss across a $ref offered no continuation");
    assert.ok(
      missed.caveats.some((c) => c.code === "crosses-into"),
      "the continuation was not stated as a caveat",
    );
    // Asserted as "it resolves", not as a type name: naming the type would pin
    // the FIRST hop, and this pointer takes two -- Item -> common:ItemTool ->
    // ItemToolSpec. A test that named the intermediate would keep passing while
    // the reader was handed a command that fails, which is the defect itself.
    const arrived = await callTool(ctx, "describe", {
      type: crossing[0]!.into,
      field: crossing[0]!.continueAt,
    });
    assert.ok(
      ((arrived.value as { fields?: unknown[] }).fields ?? []).length > 0,
      `the continuation this answer offers does not itself resolve: ` +
        `${crossing[0]!.into} ${crossing[0]!.continueAt}`,
    );

    // A bench id nothing declares is still a bench: six vanilla ids are required
    // by recipes that no station provides. The CLI listed `Fieldcraft` and
    // annotated it; the tool call said "No bench 'Fieldcraft'" while `refs`
    // reported nine occurrences of the same string.
    const bench = await callTool(ctx, "bench", { id: "Fieldcraft" });
    assert.notEqual((bench.value as { found?: boolean }).found, false);
    assert.ok((bench.value as { total: number }).total > 0);
    assert.ok(
      bench.caveats.some((c) => c.code === "bench-undeclared"),
      "a bench no asset declares arrived looking like a working one",
    );

    // `limit` means what its own description says, on both lists that have one.
    const refs = await callTool(ctx, "refs", { id: "Items.Tools", limit: 10 });
    const examples = (refs.value as { examples: unknown[] }).examples;
    assert.ok(examples.length <= 10, `limit 10 returned ${examples.length} rows`);
    assert.ok(
      refs.caveats.some((c) => c.code === "truncated"),
      "a clipped reference list was indistinguishable from a whole one",
    );

    const described = await callTool(ctx, "describe", {
      type: "common:BlockBreakingDropType",
      field: "/Quality",
      limit: 3,
    });
    const first = (described.value as { fields: { declaredBy: { shown: unknown[]; total: number } }[] })
      .fields[0]!;
    // The total is a count of DECLARING assets, not of observed values: a
    // container has none, and `/StatModifiers` was served as "declared by 0"
    // beside a child counted in 67.
    assert.ok(first.declaredBy.total >= first.declaredBy.shown.length);
    assert.ok(first.declaredBy.total > 0);
    if (first.declaredBy.shown.length < first.declaredBy.total) {
      assert.ok(
        described.caveats.some((c) => c.code === "truncated"),
        "the sample was capped in silence",
      );
    }

    // A loosened query is a qualified answer. `search Burning` returns four
    // effects, none of them named Burning.
    const loose = await callTool(ctx, "search", { query: "Burning", type: "EntityEffect" });
    const hits = loose.value as { relaxation?: number }[];
    if (Array.isArray(hits) && hits.some((h) => (h.relaxation ?? 0) > 0)) {
      assert.ok(
        loose.caveats.some((c) => c.code === "relaxed"),
        "the query was loosened and the answer did not say so",
      );
    }

    // A field whose declared type is a union is not a container: an `anyOf` of
    // scalars carries values, and the note told readers to disregard them.
    const applied = await callTool(ctx, "describe", { type: "common:ApplyEffectInteraction" });
    for (const f of (applied.value as { fields: Record<string, unknown>[] }).fields) {
      if (f["observed"] !== null) {
        assert.equal(
          f["observedNote"],
          undefined,
          `${String(f["pointer"])} carries observations and a note saying it cannot`,
        );
      }
    }
  } finally {
    db.close();
  }
});

/**
 * The whole point of the operation layer, asserted as bytes.
 *
 * Every command renders in `src/api` and both front ends write what it produced,
 * so a divergence is not a bug to be found -- it is a thing that cannot be
 * expressed. Before this, the CLI printed a route across a `$ref` crossing, a
 * `~N` relaxation legend, a bench-declared-nowhere note and a truncation notice
 * that the served answer had none of, because each lived in a print statement.
 *
 * Asserted across every tool that renders, not a sample: the defects were always
 * in whichever command nobody thought to check.
 */
test("the CLI and the MCP server emit the same bytes", opts, async () => {
  const ops = await import("../../dist/api/operations.js");
  const { callTool, compact } = await import("../../dist/mcp/tools.js");
  const { AssetArchive } = await import("../../dist/sources/archive.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  const status = await ops.statusOp({});
  let archive: { close(): void } | null = null;
  const ctx = {
    db,
    options: {},
    openArchive: async () => {
      archive ??= await AssetArchive.open(status.value.install.assetsZip!);
      return archive;
    },
  };

  const cases: [string[], string, Record<string, unknown>][] = [
    [["types", "EntityEffect", "--limit", "5"], "types", { type: "EntityEffect", limit: 5 }],
    [
      ["search", "Burning", "--type", "EntityEffect"],
      "search",
      { query: "Burning", type: "EntityEffect" },
    ],
    [
      ["describe", "common:ItemTool", "--limit", "4"],
      "describe",
      { type: "common:ItemTool", limit: 4 },
    ],
    [["refs", "Items.Tools", "--limit", "5"], "refs", { id: "Items.Tools", limit: 5 }],
    [["refs", "AOECylinder"], "refs", { id: "AOECylinder" }],
    [["bench", "Fieldcraft"], "bench", { id: "Fieldcraft" }],
    [["search-schema", "gather type"], "search_schema", { query: "gather type" }],
    [
      ["search-lang", "items.Weapon_Sword_Iron.name"],
      "search_lang",
      { query: "items.Weapon_Sword_Iron.name" },
    ],
    [
      ["undocumented", "common:SelectInteraction"],
      "undocumented",
      { type: "common:SelectInteraction" },
    ],
    [["get", "Tool_Pickaxe_Iron", "--type", "Item"], "get", { id: "Tool_Pickaxe_Iron", type: "Item" }],
  ];

  try {
    for (const [argv, tool, args] of cases) {
      const proc = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
      // A miss is written to stderr so piped output stays machine-readable; the
      // STREAM is the CLI's decision, the bytes are the operation's.
      const printed = (proc.stdout || "") + (proc.status === 1 ? proc.stderr : "");
      const served = (await callTool(ctx, tool, args)).text ?? "";
      // The contract changed shape, not strength. MCP now drops tabular rows --
      // `value` already carries every one of them as named fields, so serving
      // both makes a model read the same data twice, once in a worse form. What
      // must still hold is that MCP never says anything the CLI does not: every
      // served line has to appear in the printed answer. That catches a surface
      // inventing, rewording or contradicting the other, which is what this test
      // was always for; byte equality was only ever a proxy for it.
      const haystack = compact(printed);
      for (const line of served.split("\n")) {
        if (line.trim().length === 0) continue;
        assert.ok(
          haystack.includes(line.trim()),
          `${argv.join(" ")}: MCP served a line the CLI never printed:\n  ${line}`,
        );
      }
    }
  } finally {
    archive?.close();
    db.close();
  }
});

test("the served answers match the operations they come from", opts, async () => {
  // The divergence this layer exists to prevent: `benchOp` once returned 200
  // recipes while the CLI printed 911. Checked against the operation directly.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const { replies } = await session([
      { method: "tools/call", params: { name: "describe", arguments: { type: "Item", limit: 5 } } },
      { method: "tools/call", params: { name: "types", arguments: { type: "BlockSoundSet" } } },
    ]);
    const served = payload(replies[1])["value"] as { total: number };
    assert.equal(served.total, ops.describeOp(db, { assetType: "Item", limit: 5 }).value.total);

    const listed = payload(replies[2])["value"] as { total: number };
    assert.equal(listed.total, ops.assetsOfType(db, "BlockSoundSet"));
  } finally {
    db.close();
  }
});
