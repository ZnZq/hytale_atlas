import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

/**
 * Regression tests for the command-line surface, run as a real process.
 *
 * Every defect these pin was found by an agent that had never seen this
 * repository, given only the CLI and a modder's request. None of them were
 * failures to compute: they were **messages that stated something false or hid
 * something true**, and they lived at the process boundary -- argument parsing,
 * exit codes, help text, wording -- where unit tests over the query layer cannot
 * reach. So these shell out.
 *
 * Skipped wholesale when no index is present, since that is the normal state on a
 * machine without Hytale installed.
 */

const CLI = "dist/cli/main.js";

/**
 * Runs the CLI and returns BOTH streams, whatever the exit code.
 *
 * spawnSync rather than execFileSync: several of these defects are diagnostics
 * written to stderr on a SUCCESSFUL run -- the shell-mangling note, the
 * name-collision note -- and execFileSync returns stdout only when the process
 * exits zero, so the first version of this harness reported those tests as
 * failures of the tool rather than of itself.
 */
function run(...args: string[]): { out: string; code: number } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { out: `${proc.stdout ?? ""}${proc.stderr ?? ""}`, code: proc.status ?? 1 };
}

/**
 * Result rows only: blank lines and the truncation notice are not results.
 *
 * Counting raw lines made three tests fail the moment truncation started
 * announcing itself -- the tests were measuring the wrong thing, not the tool.
 */
function resultRows(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.startsWith("...") && !l.startsWith(" "));
}

const built = existsSync(CLI);
const indexed = built && run("describe", "Item", "--limit", "1").code === 0;
const opts = indexed ? {} : { skip: "no built CLI or no index on this machine" };

// ---------------------------------------------------------------------------
// Round 1 defects: eight, found on the first blind trial.
// ---------------------------------------------------------------------------

test("status reports the real index rather than a stale constant", opts, () => {
  // Printed "Index: not built (indexing is not implemented yet)" long after
  // indexing worked, so the first thing a new user saw was the tool calling
  // itself broken while every other command contradicted it.
  const { out } = run("status");
  assert.ok(!/not implemented yet/i.test(out), `status still claims not implemented:\n${out}`);
  assert.match(out, /Index:\s+[\d,]+ assets/);
  assert.match(out, /schema fields/);
  assert.match(out, /edges/);
});

test("undocumented scopes to a type instead of ignoring the argument", opts, () => {
  // The positional was accepted and then dropped, so this returned the entire
  // unscoped corpus and read as an answer about the type asked for.
  const scoped = run("undocumented", "ItemToolSpec").out;
  const all = run("undocumented").out;
  assert.notEqual(scoped, all);
  assert.match(scoped, /scoped to ItemToolSpec/);
  for (const line of scoped.split("\n").filter((l) => /^\S+\//.test(l))) {
    assert.match(line, /^ItemToolSpec\//, `leaked an unrelated type: ${line}`);
  }
});

test("describe names the flag when it truncates", opts, () => {
  // Stopped at 60 printing only a total, so a type appeared to end mid-alphabet
  // and there was no way to learn the rest was reachable.
  const { out } = run("describe", "Item");
  assert.match(out, /showing 60 of \d+ fields/);
  assert.match(out, /--limit/);
});

test("describe rejects a second positional instead of swallowing it", opts, () => {
  // `describe Item Tool` returned the identical full dump, which reads as
  // "Item.Tool has 96 fields".
  const { out, code } = run("describe", "Item", "Tool");
  assert.equal(code, 2);
  assert.match(out, /--field \/Tool/);
});

test("a missing namespace prefix is suggested", opts, () => {
  const { out, code } = run("describe", "ItemTool");
  assert.equal(code, 1);
  assert.match(out, /common:ItemTool/);
});

test("a namespace prefix that should not be there is also suggested", opts, () => {
  // The opposite mistake, and just as easy to make: ItemToolSpec takes no prefix
  // while ItemTool requires one, and nothing in the data says which is which.
  const { out, code } = run("describe", "common:ItemToolSpec");
  assert.equal(code, 1);
  assert.match(out, /describe ItemToolSpec/);
});

test("validate is listed as unimplemented rather than as a working command", opts, () => {
  const { out } = run("--help");
  const notImplemented = out.slice(out.indexOf("Not implemented yet"));
  assert.ok(notImplemented.length > 0, "help has no 'Not implemented yet' section");
  assert.match(notImplemented, /validate/);
});

test("search prints the asset type so false positives are visible", opts, () => {
  // Goblin_Pickaxe is an ItemPlayerAnimations, indistinguishable from a real tool
  // without spending a `get` on each candidate.
  const { out } = run("search", "pickaxe");
  assert.match(out, /Tool_Pickaxe_\w+\s+Item\s/);
  assert.match(out, /ItemPlayerAnimations/);
});

// ---------------------------------------------------------------------------
// The systematic one: `unused` was a claim about extraction, not about the game.
// ---------------------------------------------------------------------------

test("a numeric field is not reported as unused", opts, () => {
  // Candidate extraction collected string scalars only, so all 1,963 non-string
  // scalar fields were absent from the observed layer by construction.
  // Item.ItemLevel was labelled unused while vanilla items set it to 40.
  const { out } = run("describe", "Item", "--field", "ItemLevel");
  assert.match(out, /ItemLevel/);
  assert.ok(!/\bunused\b/.test(out), `still unused:\n${out}`);
  assert.match(out, /used in [\d,]+ assets/);
});

test("a boolean field is not reported as unused", opts, () => {
  const { out } = run("describe", "common:BreakBlockInteraction", "--field", "Harvest");
  assert.ok(!/\bunused\b/.test(out), `still unused:\n${out}`);
});

test("containers are labelled as containers, not as unused", opts, () => {
  // An object or array holds no scalar of its own and can never reach the
  // observed layer however heavily the corpus uses it.
  const { out } = run("describe", "Item", "--field", "Tool");
  assert.match(out, /\(container\)/);
  assert.ok(!/\bunused\b/.test(out), `container called unused:\n${out}`);
});

test("undocumented warns that absence may be a join failure", opts, () => {
  // Roughly a third of declared fields currently join their observed counterpart,
  // so absence here is weaker evidence than the heading implies.
  const { out } = run("undocumented", "ItemToolSpec");
  assert.match(out, /failed to join/i);
});

// ---------------------------------------------------------------------------
// Round 2 defects: five more, found once the first eight were fixed.
// ---------------------------------------------------------------------------

test("a pointer mangled by the shell is recovered and explained", opts, () => {
  // A JSON Pointer starts with '/', which MSYS rewrites into a Windows path, so
  // under Git Bash `--field /BlockType` arrived as C:/Program Files/Git/BlockType
  // and the flag could never work. An agent concluded it was entirely broken.
  const { out, code } = run("describe", "Item", "--field", "C:/Program Files/Git/BlockType");
  assert.equal(code, 0);
  assert.match(out, /shell rewrote the pointer/);
  assert.match(out, /^\/BlockType/m);
});

test("a pointer without its leading slash is accepted", opts, () => {
  // The form that sidesteps the shell entirely, so it must work.
  const { out, code } = run("describe", "Item", "--field", "BlockType");
  assert.equal(code, 0);
  assert.match(out, /^\/BlockType/m);
});

test("a missing field is reported as a missing field, not a missing type", opts, () => {
  // Checking the type first produced "No type 'Item'. Did you mean: describe
  // Item" -- a suggestion identical to what had just been typed, which hid the
  // real cause above for six attempts.
  const { out, code } = run("describe", "Item", "--field", "Tool/Nonsense");
  assert.equal(code, 1);
  assert.ok(!/No type 'Item'/.test(out), `reported as a type error:\n${out}`);
  assert.match(out, /has no field/);
  assert.match(out, /Nearest declared/);
  assert.match(out, /\/Tool/);
});

test("bench labels which of its two identifier columns is the key", opts, () => {
  // Two ids sit on every row and only one works: the left is the bench id, which
  // `bench <id>` takes AND which a recipe's BenchRequirement.Id must carry; the
  // right is the asset that declares it.
  const { out } = run("bench");
  assert.match(out, /BENCH ID/);
  assert.match(out, /DECLARED BY/);
  assert.match(out, /use this/);
  assert.match(out, /^Workbench\s+Crafting/m);
});

test("bench called with the declaring asset names the id to use instead", opts, () => {
  // Writing the asset id into a recipe's BenchRequirement fails silently at
  // runtime, so this mistake must be caught at lookup time.
  const { out, code } = run("bench", "Bench_WorkBench");
  assert.equal(code, 1);
  assert.match(out, /not the bench id/);
  assert.match(out, /bench Workbench/);
  assert.match(out, /BenchRequirement\.Id/);
});

test("get discloses a name collision instead of silently choosing", opts, () => {
  // Four assets are named Pickaxe_Mine. Returning the CameraEffect in silence led
  // an agent to conclude the interaction chain had a dead reference, when the
  // Interaction it wanted existed the whole time.
  const { out } = run("get", "Pickaxe_Mine");
  assert.match(out, /assets are named 'Pickaxe_Mine'/);
  assert.match(out, /Interaction/);
});

test("get --type selects among same-named assets", opts, () => {
  const { out, code } = run("get", "Pickaxe_Mine", "--type", "Interaction");
  assert.equal(code, 0);
  assert.match(out, /type=Interaction/);
});

// ---------------------------------------------------------------------------
// Round 5, adversarial: four defects found by deliberately misusing the CLI.
// ---------------------------------------------------------------------------

test("a misspelled flag is rejected, not silently dropped", opts, () => {
  // `get Pickaxe --typ Item` returned a DIFFERENT asset than intended, in
  // silence, because the unknown flag was collected and then ignored. Dropping
  // an argument the user clearly meant is worse than refusing it.
  const { out, code } = run("get", "Pickaxe", "--typ", "Item");
  assert.equal(code, 2);
  assert.match(out, /Unknown option '--typ'/);
  assert.match(out, /--type/);
});

test("a single-dash long option is rejected", opts, () => {
  const { out, code } = run("get", "Pickaxe", "-type", "Item");
  assert.equal(code, 2);
  assert.match(out, /Unknown option '-type'/);
});

test("--limit rejects a non-number instead of reaching SQLite", opts, () => {
  // Surfaced a raw 'datatype mismatch' from the driver, which tells a caller
  // nothing about which argument was wrong.
  const { out, code } = run("search", "pickaxe", "--limit", "abc");
  assert.equal(code, 2);
  assert.match(out, /--limit takes a positive whole number/);
  assert.ok(!/datatype mismatch/.test(out));
});

test("--limit rejects zero and negatives rather than printing 'No matches'", opts, () => {
  // Both printed the same string as a genuinely empty result, so a caller could
  // not tell a bad limit from a real negative. SQLite also reads LIMIT -1 as
  // "no limit", making the one value a user might expect to mean "all" return
  // none.
  for (const value of ["0", "-1"]) {
    const { out, code } = run("search", "pickaxe", "--limit", value);
    assert.equal(code, 2, `--limit ${value} was accepted`);
    assert.ok(!/No matches/.test(out), `--limit ${value} reported an empty result`);
  }
});

test("a single-field describe prints the whole description", opts, () => {
  // List mode clips prose, which is right; doing it to a single-field request is
  // not, and there was no flag to turn it off. The clipped sentence here was the
  // one that settles whether a selector can hit more than one block -- the crux
  // of the area-mining question.
  const { out } = run("describe", "common:SelectInteraction", "--field", "HitBlock");
  assert.match(out, /A block cannot be hit multiple times by a single selector/);
  assert.ok(!out.includes("…"), `single-field output was clipped:\n${out}`);
});

test("clipped prose in list mode is marked", opts, () => {
  const { out } = run("describe", "common:SelectInteraction", "--limit", "200");
  assert.ok(out.includes("…"), "long descriptions are cut with no marker");
});

test("a branch whose constant differs from its name is not reported unused", opts, () => {
  // common:SelectInteraction is selected by the constant "Selector", which is not
  // a prefix of its name, so deriving the discriminator from the name missed it
  // entirely and reported every field unused -- while vanilla pickaxes and
  // hatchets use it in their swing chains. The schema declares the constant in
  // prose on the /Type field; that is now what is read.
  const { out } = run("describe", "common:SelectInteraction", "--field", "Type");
  assert.ok(!/\bunused\b/.test(out), `still unused:\n${out}`);
  assert.match(out, /used in [\d,]+ assets/);
  assert.match(out, /constant value "Selector"/);
});

// ---------------------------------------------------------------------------
// Round 6, adversarial: five argument-parsing defects. The trial reported the
// semantic layer clean -- no false statement, no wrong "unused" or "does not
// exist" -- so everything here is about how the CLI reads its own input.
// ---------------------------------------------------------------------------

test("a value flag with no value is refused, not ignored", opts, () => {
  // Behaved exactly like passing no flag at all, so a dropped value was
  // indistinguishable from never having typed it.
  const { out, code } = run("search", "pickaxe", "--limit");
  assert.equal(code, 2);
  assert.match(out, /--limit needs a value/);
});

test("the --flag=value form is accepted", opts, () => {
  // Rejected for every value with "Unknown option '--limit=0'. Did you mean
  // '--limit'?" -- circular, and neither the message nor --help said which
  // syntax was expected.
  const { out, code } = run("search", "pickaxe", "--limit=3");
  assert.equal(code, 0);
  assert.equal(resultRows(out).length, 3);
});

test("a negative limit reaches the validator that can explain it", opts, () => {
  // The generic parser intercepted '-5' as an unknown option first, producing a
  // message that never mentioned --limit at all.
  const { out, code } = run("search", "pickaxe", "--limit", "-5");
  assert.equal(code, 2);
  assert.match(out, /--limit takes a positive whole number, not '-5'/);
});

test("a bad flag value is reported the same way whatever the argument order", opts, () => {
  // `search --limit pickaxe` consumed the query as the limit and then failed with
  // "usage: search <query>", reporting a missing query when one was given.
  const { out, code } = run("search", "--limit", "pickaxe");
  assert.equal(code, 2);
  assert.match(out, /--limit takes a positive whole number, not 'pickaxe'/);
  assert.ok(!/usage: hytale-atlas search/.test(out));
});

test("a switch flag rejects a value rather than absorbing it", opts, () => {
  const { out, code } = run("index", "--force=yes");
  assert.equal(code, 2);
  assert.match(out, /--force takes no value/);
});

test("a loosened schema match says so; an exact one does not", opts, () => {
  // "quarry" returned CurveType, EasingType and MoonPhaseWeightModifiers --
  // suffix-trimming had reduced the term until something matched, and nothing
  // said so, which is worse than the honest "no match" the same command gives
  // for other queries.
  const loose = run("search-schema", "quarry");
  assert.match(loose.out, /Nothing matched "quarry" as written/);
  assert.match(loose.out, /may be unrelated/);

  const exact = run("search-schema", "GatherType");
  assert.ok(
    !/as written/.test(exact.out),
    `an exact match was labelled as loosened:\n${exact.out}`,
  );
});

// ---------------------------------------------------------------------------
// Round 7, and the schema declaration found while answering a question about it.
// ---------------------------------------------------------------------------

test("a single-field describe lists every observed value", opts, () => {
  // The list was cut at 14 in silence. common:BenchRequirement./Id has 21 real
  // bench ids; the output ended mid-alphabet at Furniture_Bench and never showed
  // Workbench, Weapon_Bench, Tannery or Salvagebench -- readable as the complete
  // set by anyone who did not already know better.
  const { out } = run("describe", "common:BenchRequirement", "--field", "Id");
  for (const id of ["Alchemybench", "Salvagebench", "Tannery", "Weapon_Bench", "Workbench"]) {
    assert.match(out, new RegExp(id), `missing ${id}:\n${out}`);
  }
});

test("a clipped value list says how many of how many", opts, () => {
  const { out } = run("describe", "common:BenchRequirement");
  const line = out.split("\n").find((l) => l.includes("of 21 distinct"));
  assert.ok(line !== undefined, `no count for the clipped list:\n${out}`);
  assert.match(line, /use --field for the rest/);
});

test("a container with no observations explains why that means nothing", opts, () => {
  // A sibling container that HAD been used as a string reference showed usage,
  // so this one read as genuinely unused -- while find_undocumented, which
  // excludes containers, did not list it either. Two consistent outputs that
  // together looked like a contradiction.
  const { out } = run("describe", "common:SelectInteraction", "--field", "HitBlock");
  assert.match(out, /\(container\)/);
  assert.match(out, /Absence here says nothing/);
});

test("a union keyed on something other than Type resolves", opts, () => {
  // The discriminator PROPERTY was hardcoded to `Type` while the schema declares
  // it per union in hytaleSchemaTypeField: 185 say Type, 14 say Id. Those 14
  // could never resolve. ScriptedBrushAsset./Operations/* is 56 branches keyed on
  // `Id`, and was recorded in OPEN-QUESTIONS Q20 as having no discriminator.
  const { out } = run("describe", "ScriptedBrushAsset", "--field", "Operations/*");
  assert.match(out, /anyOf/);
  // Its branches now carry observed data, which is the point.
  const branch = run("describe", "common:AppendMaskOperation", "--limit", "200");
  assert.equal(branch.code, 0, `branch type missing:\n${branch.out}`);
});

// ---------------------------------------------------------------------------
// Round 8, plus a full audit of the help text against actual behaviour.
//
// The help had drifted, and every drift was the failure this tool exists to
// avoid: a confident statement that is not true.
// ---------------------------------------------------------------------------

test("the documented search default is the real one", opts, () => {
  // --help claimed 20 while the code used 10, and nothing announced the cap. A
  // first search for "pickaxe" surfaced one tool and hid eight more.
  const capped = run("search", "pickaxe", "--limit", "3");
  assert.equal(resultRows(capped.out).length, 3);
  const dflt = run("search", "pickaxe");
  assert.ok(
    resultRows(dflt.out).length > 10,
    `default limit still below the documented 20: ${resultRows(dflt.out).length}`,
  );
});

test("every list command announces its own truncation", opts, () => {
  for (const argv of [
    ["search", "a", "--limit", "2"],
    ["search-schema", "type", "--limit", "2"],
    ["undocumented", "--limit", "2"],
  ]) {
    const { out } = run(...argv);
    assert.match(out, /showing the first/, `${argv.join(" ")} truncated in silence:\n${out}`);
  }
});

test("unscoped undocumented does not hide 99% of its output", opts, () => {
  // Showed 40 rows of 6,324 with no notice -- and search-schema points readers
  // here specifically to firm up a negative.
  const { out } = run("undocumented");
  assert.match(out, /showing the first/);
});

test("--mcp refuses instead of silently running the indexer", opts, () => {
  // Documented as "Serve MCP over stdio" and never read, so it fell through to
  // the default command. An MCP client configured with it would have built an
  // index and reported success while serving nothing.
  const { out, code } = run("--mcp");
  assert.equal(code, 2);
  assert.match(out, /not implemented/i);
  assert.ok(!/Index already built|Indexing vanilla/.test(out), `--mcp still indexes:\n${out}`);
});

test("unimplemented commands exit non-zero and are listed as such", opts, () => {
  for (const name of ["validate", "clean"]) {
    const { out, code } = run(name);
    assert.equal(code, 2, `${name} reported success`);
    assert.match(out, /not implemented/i);
  }
  const help = run("--help").out;
  const section = help.slice(help.indexOf("Not implemented yet"));
  for (const name of ["validate", "clean", "--mcp"]) {
    assert.ok(section.includes(name), `--help does not list ${name} as unimplemented`);
  }
});

test("help does not advertise a command that is not dispatched", opts, () => {
  // Parsed out of the help text itself, so adding a line without wiring it up
  // fails here rather than in a user's hands.
  const help = run("--help").out;
  const advertised = [...help.matchAll(/^ {2}hytale-atlas ([a-z-]+)/gm)]
    .map((m) => m[1]!)
    .filter((c) => c !== "hytale-atlas");
  const unimplemented = help.slice(help.indexOf("Not implemented yet"));
  for (const command of new Set(advertised)) {
    if (unimplemented.includes(`hytale-atlas ${command}`)) continue;
    const { code, out } = run(command, "--help");
    assert.notEqual(code, 2, `advertised '${command}' is not dispatched:\n${out}`);
  }
});

test("status reports what help says it reports", opts, () => {
  // Claimed "epoch, coverage" and printed neither.
  const { out } = run("status");
  assert.match(out, /Patchline:/);
  assert.match(out, /Tier:/);
  assert.match(out, /epoch \d+/);
  assert.match(out, /join: [\d,]+ of [\d,]+ observed fields/);
});

test("every documented option is accepted by the parser", opts, () => {
  // --raw existed and was documented nowhere; the inverse -- documenting a flag
  // the parser rejects -- is caught here.
  const help = run("--help").out;
  const documented = [...help.matchAll(/^ {2}(--[a-z-]+)/gm)].map((m) => m[1]!);
  assert.ok(documented.includes("--raw"), "--raw is still undocumented");
  for (const flag of new Set(documented)) {
    const { out } = run("status", flag, "1");
    assert.ok(!/Unknown option/.test(out), `${flag} is documented but rejected:\n${out}`);
  }
});

// ---------------------------------------------------------------------------
// The verdict itself. These pin the answers the tool must keep giving, so a
// future change that silently degrades them fails here rather than in a trial.
// ---------------------------------------------------------------------------

test("the tool surface reaches ItemToolSpec from a plain-language query", opts, () => {
  const { out } = run("search-schema", "tool tier gather");
  assert.match(out, /ItemToolSpec\/GatherType/);
});

test("GatherType reports its observed vocabulary", opts, () => {
  // No schema enum declares these; the corpus-inferred layer is the only route.
  const { out } = run("describe", "ItemToolSpec", "--field", "GatherType");
  assert.match(out, /seen:/);
  for (const value of ["Rocks", "Woods", "Soils", "SoftBlocks"]) {
    assert.match(out, new RegExp(value));
  }
});

test("area mining is absent from the tool schema, and the tool says so plainly", opts, () => {
  // The load-bearing negative: a modder must be told 3x3 is not expressible
  // before investing time. If a future patchline adds such a field this test
  // fails, which is the correct outcome -- the answer would have changed.
  const spec = run("describe", "ItemToolSpec", "--limit", "200").out;
  assert.ok(
    !/\/(Radius|Area|Shape|Width|Height|Depth|Range)\b/.test(spec),
    `ItemToolSpec now declares an area-like field:\n${spec}`,
  );
  const tool = run("describe", "common:ItemTool", "--limit", "200").out;
  assert.ok(
    !/\/(Radius|Area|Shape|Width|Height|Depth|Range)\b/.test(tool),
    `common:ItemTool now declares an area-like field:\n${tool}`,
  );
});

test("the bench join answers what can be crafted where", opts, () => {
  const { out } = run("bench", "Workbench");
  assert.match(out, /Workbench_Tools/);
  assert.match(out, /Tool_Pickaxe_/);
});

test("a recipe's bench requirement is reachable as a declared field", opts, () => {
  const { out } = run("describe", "common:BenchRequirement", "--limit", "200");
  for (const field of ["/Id", "/Type", "/Categories"]) {
    assert.match(out, new RegExp(field.replace("/", "\\/")));
  }
});

// ---------------------------------------------------------------------------
// Round 3 defects: four more, found once the first thirteen were fixed.
// ---------------------------------------------------------------------------

test("search returns every same-named asset instead of picking one", opts, () => {
  // Deduplicating on the identifier alone silently discarded same-named assets
  // of other types. Four carry the name Pickaxe_Mine, and the Interaction --
  // the one holding the mining logic -- was invisible to search entirely. Not a
  // limit truncation, which at least prints a total: a silent choice.
  const { out } = run("search", "Pickaxe_Mine", "--limit", "50");
  // Matched line-wise rather than by regex: a backslash class written through a
  // shell heredoc silently loses its escape, and the first version of this
  // assertion tested /Pickaxe_Mines+CameraEffect/ against correct output.
  const rows = out
    .split("\n")
    .filter((l) => l.startsWith("Pickaxe_Mine "))
    .map((l) => l.split(/\s+/)[1]);
  for (const type of ["CameraEffect", "CameraShake", "Interaction", "RootInteraction"]) {
    assert.ok(rows.includes(type), `missing ${type}, got ${rows.join(", ")}:\n${out}`);
  }
});

test("get --type is documented in help", opts, () => {
  // The flag existed and worked, but nothing announced it, so the only route to
  // it was guessing after two plausible syntaxes failed.
  const { out } = run("--help");
  assert.match(out, /--type <Type>/);
  assert.match(out, /get <id>[\s\S]*not\s+unique across types/i);
});

test("a namespaced identifier guess is answered with the flag that works", opts, () => {
  // The old advice was to search for the string as typed -- a syntax that does
  // not exist, from a command that cannot disambiguate by type either.
  const { out, code } = run("get", "Interaction:Pickaxe_Mine");
  assert.equal(code, 1);
  assert.match(out, /--type Interaction/);
  assert.ok(!/Try 'hytale-atlas search Interaction:Pickaxe_Mine'/.test(out));
});

test("a schema search miss is reported as evidence, not as proof", opts, () => {
  // "That is itself an answer: nothing in any asset type declares this
  // capability" is a semantic claim drawn from a lexical match. One missed query
  // does not rule out the capability existing under other words -- the same
  // overreach as 'unused', in a different command.
  const { out, code } = run("search-schema", "zzz-no-such-capability");
  assert.equal(code, 1);
  assert.ok(
    !/that is itself an answer/i.test(out),
    `still claims a miss settles the question:\n${out}`,
  );
  assert.match(out, /evidence, not proof/i);
  assert.match(out, /lexical/i);
  assert.match(out, /undocumented <Type>/);
});

test("an undeclared field still reports what it holds", opts, () => {
  // common:BenchRequirement./Set is used by 69 assets and declared nowhere.
  // describe could say it existed and nothing more, which is a dead end: values
  // lived only on declared rows, and an undeclared field has none.
  const { out } = run("describe", "common:BenchRequirement", "--field", "Set");
  assert.match(out, /UNDECLARED/);
  assert.match(out, /seen:/);
  assert.match(out, /used in [\d,]+ assets/);
});

// ---------------------------------------------------------------------------
// Round 4: one defect, and the trial explicitly reported the rest clean.
// ---------------------------------------------------------------------------

test("undocumented rejects a type that does not exist", opts, () => {
  // This printed the same sentence as a real negative and exited 0, so a typo
  // returned a confident wrong answer -- and search-schema sends readers here
  // specifically to firm up a negative, making the pair circular.
  const { out, code } = run("undocumented", "ItemDoesNotExistXYZ");
  assert.equal(code, 1);
  assert.match(out, /No type 'ItemDoesNotExistXYZ'/);
});

test("undocumented states a real negative as a fact about the type", opts, () => {
  const { out, code } = run("undocumented", "Item");
  assert.equal(code, 0);
  assert.match(out, /'Item' declares [\d,]+ fields/);
  assert.match(out, /every one of them appears/);
  assert.match(out, /real negative/);
});

test("undocumented still lists real findings when there are any", opts, () => {
  const { out, code } = run("undocumented", "ItemToolSpec");
  assert.equal(code, 0);
  assert.match(out, /ItemToolSpec\/IsIncorrect/);
});

test("an interaction branch reached through a root union has observed data", opts, () => {
  // Interaction.json is anyOf over 102 concrete definitions and declares no field
  // of its own. The root was skipped because its pointer is empty, so that
  // namespace was empty too and everything rebasing into it had nowhere to land:
  // common:BreakBlockInteraction had zero observed fields while the corpus uses
  // it constantly.
  const { out } = run("describe", "common:BreakBlockInteraction", "--field", "Harvest");
  assert.ok(!/\bunused\b/.test(out), `still unused:\n${out}`);
  assert.match(out, /used in [\d,]+ assets/);
});
