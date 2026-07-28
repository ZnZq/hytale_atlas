import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
