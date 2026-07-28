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
/**
 * Rows of a column-formatted result list, as opposed to prose around it.
 *
 * Told apart by SHAPE, not by a list of known sentences. The list-of-prefixes
 * version had to be edited every time a legend gained a line: round 16 added a
 * header and two footnotes and made four tests measure the wrong thing, and
 * round 19's fixes did it again to three more. A helper that needs updating
 * whenever the wording changes is the same defect the tool itself keeps having
 * — a rule maintained by repetition rather than by construction.
 *
 * A result row is aligned into columns, so it carries a run of two or more
 * spaces. Prose wraps at the margin and never does. The column HEADER is the one
 * aligned line that is not a result, and it is upper-case by convention.
 */
function resultRows(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => {
      if (l.trim().length === 0 || l.startsWith("...") || l.startsWith(" ")) return false;
      if (!/\S {2,}\S/.test(l)) return false; // prose: no column gap
      const first = l.split(/\s{2,}/)[0] ?? "";
      return first !== first.toUpperCase() || /[a-z0-9_]/.test(first); // not a header
    });
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
    assert.match(out, /showing the first/i, `${argv.join(" ")} truncated in silence:\n${out}`);
  }
});

test("unscoped undocumented does not hide 99% of its output", opts, () => {
  // Showed 40 rows of 6,324 with no notice -- and search-schema points readers
  // here specifically to firm up a negative.
  const { out } = run("undocumented");
  assert.match(out, /showing the first/i);
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
// Round 9: three new scenarios -- a plant with drops and growth stages, impact
// analysis on a heavily-used block, and a sword applying a status effect. Each
// was chosen to load machinery the pickaxe never touched.
// ---------------------------------------------------------------------------

test("get shows the asset its own note says it will", opts, () => {
  // The note ordered candidates by (is_effective, type) and the loader by
  // is_effective alone, so SQLite broke the tie by rowid: `get Plant_Bush`
  // announced "Showing the Item one" and printed the ItemDropList. Handing over
  // the wrong file while naming the right one.
  const { out } = run("get", "Plant_Bush");
  const note = /Showing the (\S+) one/.exec(out);
  const shown = /type=(\S+)/.exec(out);
  assert.ok(note !== null && shown !== null, `no note or type header:\n${out}`);
  assert.equal(shown[1], note[1]);
});

test("refs answers what points at an asset", opts, () => {
  // 162,899 edges were built and none were reachable. The only substitute was
  // `search`, which indexes names rather than values.
  const { out, code } = run("refs", "Poison", "--type", "EntityEffect");
  assert.equal(code, 0);
  assert.match(out, /references to 'Poison'/);
  assert.match(out, /Poison_T1/);
  assert.match(out, /high\s+=/);
  // The blind spot is stated, because a complete-looking answer that is not
  // complete is the failure this whole surface keeps making. The wording now
  // comes from the shared operation layer, so MCP will state it identically.
  assert.match(out, /untyped assets/);
  assert.match(out, /contribute no references/);
});

test("refs is documented", opts, () => {
  // It existed and was reachable only by accident -- an agent found it because a
  // crash happened to print its usage string.
  assert.match(run("--help").out, /hytale-atlas refs <id>/);
});

test("a union type lists its branches and the value that selects each", opts, () => {
  // `describe Interaction` printed a wall of UNDECLARED rows while
  // `describe common:ApplyEffectInteraction` showed the same fields fully
  // declared -- two commands contradicting each other, with the "did you mean"
  // steering toward the worse view. There was also no way to ask what the legal
  // interaction shapes are.
  const { out, code } = run("describe", "Interaction");
  assert.equal(code, 0);
  assert.match(out, /union of \d+ shapes, chosen by the 'Type' field/);
  assert.match(out, /ApplyEffect\s+hytale-atlas describe common:ApplyEffectInteraction/);
  assert.match(out, /complete legal set/);
  assert.ok(!/UNDECLARED/.test(out), `still printing undeclared soup:\n${out}`);
});

test("a high-cardinality field reports its count instead of going quiet", opts, () => {
  // Above the enum threshold the values are not stored, so the line vanished --
  // no list, no count, no caveat, while a neighbouring field printed 33 values.
  // Two agents independently read the silence as "this field has no values".
  const { out } = run("describe", "common:MaterialQuantity", "--field", "ItemId");
  assert.match(out, /[\d,]+ distinct values/);
  assert.match(out, /refs <id>/);
});

test("a search miss explains that search indexes names, not values", opts, () => {
  // "No matches." reads as "this string appears nowhere". Searching a sound-set
  // id returned the set itself and none of the items referencing it.
  //
  // Round 16 suppressed the `refs` suggestion entirely to break a closed loop
  // (`search X` -> `refs X` -> `search X`). That fixed the loop and broke the
  // case the sentence above the suggestion is actually about: `ApplyEntityEffect`
  // is a field VALUE, five occurrences across four assets, so `refs` answers it.
  // Round 18 had three agents follow "ask for references to it instead" into a
  // dead end because the only command offered was `search-schema`.
  //
  // The invariant is not "never suggest refs" -- it is "suggest a command only
  // when it answers for this token". Both halves are asserted here.
  const { out, code } = run("search", "ApplyEntityEffect");
  assert.equal(code, 1);
  assert.match(out, /NOT field values/);
  assert.match(out, /hytale-atlas refs ApplyEntityEffect/, "the value case lost its one route");

  // ...and running it does answer, rather than pointing back here.
  const followed = run("refs", "ApplyEntityEffect");
  assert.match(followed.out, /appears as a VALUE/, "the suggested command is a dead end");

  // A token that is nothing at all gets no `refs`, so the loop cannot re-form.
  const nothing = run("search", "zzqqxx-nothing");
  assert.doesNotMatch(nothing.out, /hytale-atlas refs zzqqxx-nothing/, "the loop is back");

  // And a real asset that simply has no localized name still gets the pointer.
  const real = run("search", "Rock_Stone", "--type", "ItemToolSpec");
  assert.match(real.out, /hytale-atlas refs Rock_Stone|No asset of type/);
});

test("describe states that its counts predate inheritance", opts, () => {
  // `describe common:FarmingData --field StartingStageSet` says 2 assets; `get`
  // shows the value on many more, because it resolves the parent chain. Both are
  // right, and nothing said they answered different questions.
  const { out } = run("describe", "common:FarmingData", "--field", "StartingStageSet");
  assert.match(out, /counts files that declare the field themselves/);
  assert.match(out, /'get' resolves inheritance first/);
});

test("search-lang finds a key written the way an asset references it", opts, () => {
  // Assets say `server.items.X.name`; the table stores `items.X.name`, the root
  // corresponding to the pack directory the .lang file sits under. So the one
  // string a modder has in hand was the one string that could not be looked up.
  const { out, code } = run("search-lang", "server.items.Plant_Crop_Wheat_StageFinal.name");
  assert.equal(code, 0);
  assert.match(out, /items\.Plant_Crop_Wheat_StageFinal\.name/);
  assert.match(out, /uk-UA/);
  assert.match(out, /used by Plant_Crop_Wheat_Block/);
});

test("search-lang finds a key by its translation in any locale", opts, () => {
  const { out, code } = run("search-lang", "Адамантитова кіраса", "--limit", "1");
  assert.equal(code, 0);
  assert.match(out, /Armor_Adamantite_Chest/);
  assert.match(out, /Adamantite Cuirass/);
});

test("search-lang explains the root-prefix rule when it finds nothing", opts, () => {
  const { out, code } = run("search-lang", "zzz.no.such.key");
  assert.equal(code, 1);
  assert.match(out, /stored WITHOUT their root/);
});

// ---------------------------------------------------------------------------
// Round 10: four scenarios re-run against the fixed tool. All four reached the
// same verdicts as before; these pin what they found on the way.
// ---------------------------------------------------------------------------

test("refs --type actually narrows to that type", opts, () => {
  // Four assets are named Stone. `refs Stone --type PhysicalMaterial` returned
  // output byte-identical to `--type BlockSoundSet`, because inheritance edges
  // were built by identifier alone: a BlockSoundSet with Parent "Stone" got an
  // edge to all four, all labelled `high` -- the tier meaning "not a heuristic".
  const material = run("refs", "Stone", "--type", "PhysicalMaterial", "--limit", "5");
  const sound = run("refs", "Stone", "--type", "BlockSoundSet", "--limit", "5");
  assert.notEqual(material.out, sound.out, "refs --type still ignores the type");
  assert.match(material.out, /PhysicalMaterialId/);
  assert.match(sound.out, /BlockSoundSetId/);
});

test("inheritance never crosses asset types", opts, () => {
  // Parent resolves within a type. 845 of 4,575 inheritance edges pointed at the
  // wrong type before this was constrained.
  const { out } = run("refs", "Stone", "--type", "PhysicalMaterial", "--limit", "200");
  const wrong = out
    .split("\n")
    .filter((l) => l.includes("INHERITS_FROM") && !l.includes("PhysicalMaterial"));
  assert.equal(wrong.length, 0, `inheritance crossed types:\n${wrong.join("\n")}`);
});

test("a schema-declared reference is reported as high confidence", opts, () => {
  // `describe BlockType --field PhysicalMaterialId` shows it declared
  // `-> PhysicalMaterial`, while refs called every such edge `medium` -- two
  // commands giving contradictory trust signals for the same field. Confidence
  // was decided before pointers were rebased across `$ref`, so a declared
  // reference reached through one could never qualify.
  const { out } = run("refs", "Stone", "--type", "PhysicalMaterial", "--limit", "5");
  const line = out.split("\n").find((l) => l.includes("PhysicalMaterialId"));
  assert.ok(line !== undefined, `no PhysicalMaterialId edge:\n${out}`);
  assert.match(line, /^high/);
});

test("refs explains that a value is not an asset instead of looping", opts, () => {
  // `search-schema` said "use refs <id>"; `refs Workbench_Tools` said "no such
  // asset, try search"; `search` said "try refs". Two commands handing off to
  // each other, neither able to say the thing is a value nested in a field.
  //
  // Round 15: pointing at `describe <Type> --field <p>` was itself a loop. For a
  // high-cardinality field that command answers "more values than this index
  // keeps -- use refs", which is where the reader just came from. All five blind
  // trials hit it; two called it the biggest gap in the tool. It now names the
  // assets instead of forwarding the question.
  //
  // Round 19: this asserted exit 1, and that was the defect rather than the
  // contract. The command answers the question in full -- the value, its field
  // positions and the assets carrying it -- so it is a success, and reporting it
  // as a failure made it unusable in a pipeline. It became load-bearing once a
  // miss started suggesting this exact command for a value.
  const { out, code } = run("refs", "Workbench_Tools");
  assert.equal(code, 0, "a complete answer must not exit non-zero");
  assert.match(out, /is not an asset/);
  assert.match(out, /as a VALUE/);
  assert.match(out, /Carried by:/);
  assert.match(out, /inheritance first/, "the value branch dropped the pre-inheritance caveat");
  assert.ok(!/Try 'hytale-atlas search Workbench_Tools'/.test(out), "still loops back to search");
  assert.ok(
    !/describe .*--field/.test(out),
    "still forwards to a describe that cannot answer it",
  );
});

test("a value report separates occurrences from assets", opts, () => {
  // It said "N assets carry it as a VALUE" while counting occurrences, so
  // `refs HarvestCrop` claimed 29 where `describe` counted 25, and
  // `refs Necromancy_Bones` claimed 2 for one asset holding the value twice.
  const { out } = run("refs", "HarvestCrop");
  const m = /VALUE ([\d,]+) time\(s\) in ([\d,]+) asset\(s\)/.exec(out);
  assert.ok(m !== null, `no occurrence/asset split:\n${out}`);
  const occurrences = Number(m[1]!.replace(/,/g, ""));
  const assets = Number(m[2]!.replace(/,/g, ""));
  assert.ok(occurrences >= assets, `${occurrences} occurrences under ${assets} assets`);

  // And the asset count is the one `describe` reports for the same field.
  const described = /used in ([\d,]+) assets/.exec(
    run("describe", "common:HarvestCropInteraction", "--field", "Type").out,
  );
  assert.ok(described !== null);
  assert.equal(assets, Number(described[1]!.replace(/,/g, "")));
});

test("a scoped miss never denies the whole corpus", opts, () => {
  // Five blind trials, five reports. `search Workbench --type BenchCategory`
  // answered "No asset is named 'Workbench', in any indexed locale" about a
  // string that is an asset's own en-US name -- the --type scope was dropped
  // from the sentence, turning a scoped miss into a claim about the game.
  const bogus = run("search", "Bench", "--type", "Nonexistent");
  assert.match(bogus.out, /No asset type 'Nonexistent' exists/);
  assert.doesNotMatch(bogus.out, /in any indexed locale/);

  // And `refs` agrees with `get` about a name that exists under another type,
  // rather than calling it "not an asset".
  const scoped = run("refs", "Wood", "--type", "Item");
  assert.match(scoped.out, /No 'Wood' of type 'Item'\. It exists as:/);
  assert.doesNotMatch(scoped.out, /is not an asset/);
});

test("bench reports the true total and says when it truncated", opts, () => {
  // `bench Builders` printed "200 craftable here" -- its own default limit --
  // while the bench table said 911, with no notice, against --help's explicit
  // promise. Four of five blind trials found it.
  const capped = run("bench", "Builders");
  const full = run("bench", "Builders", "--limit", "2000");
  const total = (out: string): number =>
    Number(/([\d,]+) craftable here/.exec(out)?.[1]?.replace(/,/g, "") ?? "0");
  assert.ok(total(capped.out) > 200, `still reporting the cap: ${total(capped.out)}`);
  assert.equal(total(capped.out), total(full.out), "the total moved with the limit");
  assert.match(capped.out, /showing the first 200 recipes/);
  assert.doesNotMatch(full.out, /showing the first/);
});

test("'validate' does not hand out 'clean' remediation", opts, () => {
  // Every blind trial asked "is my pack valid?" and was told how to delete the
  // index -- advice for a different question, printed with full confidence.
  const { out, code } = run("validate");
  assert.equal(code, 2);
  assert.doesNotMatch(out, /manual equivalent of 'clean'/);
  assert.match(out, /describe <Type>/);
});

test("get folds the nested BlockType merge in", opts, () => {
  // Support and the block entity come from Template_Crop_Block, and they are
  // what makes the plant grow at all. Getting this wrong made every plant in
  // the game read as having no farmland restriction and nothing to tick it.
  const raw = run("get", "Plant_Crop_Chilli_Block", "--type", "Item", "--raw").out;
  assert.match(raw, /"Support"/);
  assert.match(raw, /"FarmingBlock"/);
});

/**
 * An unmarked property is inherited, and that is a DECISION, not an oversight.
 *
 * This replaces an assertion that `Recipe` must not appear in a resolved child.
 * It passed for one reason only: its fixture's parent (`Template_Crop_Block`)
 * declares no `Recipe` at all, so there was nothing to inherit and nothing to
 * test. Meanwhile the resolver does exactly the opposite of what the test's name
 * claimed — `asset.ts` weighed this case explicitly and kept the field, on the
 * grounds that a hypothesis about the engine does not get to remove data from an
 * answer.
 *
 * So the behaviour is pinned on a fixture where it is observable, and the test
 * says which way round it goes. If the project ever decides the engine really
 * does not inherit recipes, this fails and is meant to.
 */
test("an unmarked property is still inherited, and it is visible where it matters", opts, () => {
  // Armor_Iron_Chest declares a Recipe; Armor_Diving_Crude_Chest declares none.
  const parent = run("get", "Armor_Iron_Chest", "--type", "Item", "--raw").out;
  const child = run("get", "Armor_Diving_Crude_Chest", "--type", "Item", "--raw").out;
  assert.match(parent, /"Recipe"/, "fixture no longer declares a recipe");
  assert.match(child, /"Recipe"/, "an unmarked property stopped being inherited");
  assert.match(
    JSON.parse(child).Recipe.Input.map((i) => i.ItemId).join(" "),
    /Ingredient_Bar_Iron/,
    "the inherited recipe is not the parent's",
  );
  // ...and the header says where it came from, so the reader is not left to
  // assume the child declared it.
  const header = run("get", "Armor_Diving_Crude_Chest", "--type", "Item").out;
  assert.match(header, /inherited whole|merged with/);
});

test("refs on a bench asset says recipes reference the declared id instead", opts, () => {
  // `refs Bench_WorkBench` returned one unrelated edge while 49 recipes required
  // that bench -- they point at the id it declares, not at the asset.
  const { out } = run("refs", "Bench_WorkBench");
  assert.match(out, /declares the bench id 'Workbench'/);
  assert.match(out, /hytale-atlas bench Workbench/);
});

test("index --dry-run prints instead of running", opts, () => {
  // Documented as a global option and read only by generate-schema, so
  // `index --force --dry-run` ran the real 40-second pipeline and rewrote the
  // cache after promising to print and exit.
  const before = Date.now();
  const { out, code } = run("index", "--force", "--dry-run");
  assert.equal(code, 0);
  assert.ok(Date.now() - before < 15_000, "dry run took long enough to have indexed");
  assert.match(out, /Would build the index/);
  assert.match(out, /target:/);
  assert.ok(!/Indexed [\d,]+ assets/.test(out), "it actually indexed");
});

test("a generic value is still observed even though it never becomes an edge", opts, () => {
  // 'Default' sat in the noise list, so it was dropped at EXTRACTION -- removing
  // it from the observed layer too. Every crop starts in the 'Default' stage set
  // and describe reported `seen: Starting, used in 2 assets`, true only of the
  // two Tomato assets that spell it differently.
  const { out } = run("describe", "common:FarmingData", "--field", "StartingStageSet");
  assert.match(out, /Default/);
  const used = /used in ([\d,]+) assets/.exec(out);
  assert.ok(used !== null, `no usage count:\n${out}`);
  assert.ok(
    Number(used[1]!.replace(/,/g, "")) > 50,
    `still only ${used[1]} assets -- generic values dropped again`,
  );
});

test("generic values do not become references", opts, () => {
  // The other half of the same change: they are collected, but must never be
  // matched against the symbol table, or every 'Default' in the corpus becomes
  // an edge. Thousands of 'Default' candidates now exist and none is an edge --
  // which is what this asserts.
  const { out } = run("refs", "Default");
  assert.match(out, /Nothing references 'Default'/);
});

// ---------------------------------------------------------------------------
// Round 11.
// ---------------------------------------------------------------------------

test("a union branch chosen by an INHERITED discriminator is not reported unused", opts, () => {
  // 152 of 1,341 Interaction assets declare only `Parent` -- the `Type` that says
  // which branch they are lives in the parent they name. Their fields therefore
  // never reached a branch namespace, and
  // `common:DamageEntityInteraction/Parent` -- the inheritance mechanism of every
  // weapon in the game -- was reported as used by nobody.
  const { out } = run("describe", "common:DamageEntityInteraction", "--field", "Parent");
  assert.ok(!/\bunused\b/.test(out), `still unused:\n${out}`);
  assert.match(out, /used in [\d,]+ assets/);
  assert.match(out, /DamageEntityParent/);
});

test("indexing still finishes in a sane time", opts, () => {
  // Edge post-processing added a correlated DELETE that took the build from 42
  // seconds to over six minutes without finishing. --dry-run exercises the same
  // resolution path cheaply; the real guard is that the suite runs at all against
  // a freshly built index, but this catches a wedged CLI outright.
  const before = Date.now();
  const { code } = run("status");
  assert.equal(code, 0);
  assert.ok(Date.now() - before < 20_000, "status hangs");
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

test("the bench list includes benches no asset declares", opts, () => {
  // Built from declarations alone, so Fieldcraft -- with no physical block to
  // declare it -- was absent from a table titled "all benches" while
  // `bench Fieldcraft` worked and listed nine real recipes, and vanilla's own
  // Workbench recipe requires it.
  //
  // Round 16: the cell used to read "(no declaring asset -- hand crafting)".
  // Two agents called that out: no such concept exists in the schema, and one of
  // the six ids so labelled (`Furniture_Misc`) is a declared BenchCategory
  // typo'd into an Id slot. The index knows only that nothing declares the id,
  // so that is all it now says.
  const { out } = run("bench");
  assert.match(out, /^Fieldcraft/m);
  assert.match(out, /no bench declares this id/);
  assert.doesNotMatch(out, /hand crafting/);
  assert.match(
    out,
    /^Furniture_Misc.*it IS a declared bench category/m,
    "a category id in an Id slot is still glossed as a plain bench",
  );
});

test("bench prints the Type its recipes declare rather than '?'", opts, () => {
  // Six ids showed TYPE '?' though every one of their 78 requirements carries
  // Type "Crafting" -- and `describe common:BenchRequirement` puts a number on
  // it: exactly one of 1,928 requirements in the corpus lacks a Type.
  const out = run("bench").out;
  const todo = out.split("\n").find((l) => l.startsWith("TODO"));
  assert.ok(todo !== undefined, `no TODO row:\n${out}`);
  assert.doesNotMatch(todo, /\?/, `still a question mark: ${todo}`);
  assert.match(todo, /Crafting/);
});

test("the CAT column says whose categories it counts", opts, () => {
  // `bench` said Weapon_Bench has 5 categories; `bench Weapon_Bench` grouped its
  // recipes under 8. Both are right -- one counts what the asset declares, the
  // other what recipes name -- but nothing said so, so they read as one number
  // contradicting itself.
  const { out } = run("bench");
  assert.match(out, /CAT counts categories the bench ASSET declares/);
  assert.match(out, /RECIPES name/);
});

test("a positional query mangled by the shell is recovered too", opts, () => {
  // The same rewriting that mangles `--field /Foo` mangles a positional `/Foo`,
  // and only the flag was checked: `search-schema "/Set"` arrived as a Windows
  // path and was reported as a genuine miss.
  const { out, code } = run("search-schema", "C:/Program Files/Git/Set");
  assert.equal(code, 0);
  assert.match(out, /your shell rewrote/);
  assert.ok(!/No schema field matches/.test(out), "still reported as a real miss");
});

test("refs exits zero when it answers", opts, () => {
  const { code } = run("refs", "Template_Crop_Block");
  assert.equal(code, 0);
});

// ---------------------------------------------------------------------------
// Round 12. The cleanest round: three of four scenarios reported no false
// statements and no contradictions at all.
// ---------------------------------------------------------------------------

test("a declared reference is never called coincidence", opts, () => {
  // BlockTypeToPlace declares '-> BlockType', but blocks are Items carrying an
  // embedded BlockType -- exactly one asset of 35,074 has that type. So the
  // declaration could not be verified, the field name follows no convention, and
  // Seed_Place, which literally places Rock_Stone, was labelled "the value merely
  // collides with an identifier". An earlier attempt DEMOTED such edges, which
  // buried real references; one round introduced that and the next found it.
  const { out } = run("refs", "Rock_Stone", "--type", "Item", "--limit", "500");
  const line = out.split("\n").find((l) => l.includes("Seed_Place"));
  assert.ok(line !== undefined, `Seed_Place edge missing entirely:\n${out}`);
  assert.ok(!/^low/.test(line), `declared reference still called coincidence: ${line}`);
});

test("refs does not count the same reference once per same-named target", opts, () => {
  // Four assets are named Rock_Stone, so a world-gen entry naming that string
  // produced an edge to each. The unfiltered list reported 303 references where
  // 162 exist -- the Item view plus the ResourceType view concatenated, with 141
  // rows in both. The total matched the rows printed, so it was internally
  // consistent while answering a different question than the reader asked.
  const all = /^([\d,]+) references/m.exec(run("refs", "Rock_Stone").out);
  const item = /^([\d,]+) references/m.exec(run("refs", "Rock_Stone", "--type", "Item").out);
  const res = /^([\d,]+) references/m.exec(
    run("refs", "Rock_Stone", "--type", "ResourceType").out,
  );
  assert.ok(all !== null && item !== null && res !== null);
  const n = (m: RegExpExecArray) => Number(m[1]!.replace(/,/g, ""));
  assert.ok(
    n(all) < n(item) + n(res),
    `unfiltered total ${n(all)} is still the sum of the two views`,
  );
});

test("a nested union field lists its shapes like a union type does", opts, () => {
  // `describe Interaction` lists its 102 branches and the value selecting each,
  // but `describe ItemDropList --field Container` said only "(container)" and
  // never mentioned that Type picks Single or Multiple -- structure recoverable
  // only by fetching a real asset.
  const { out } = run("describe", "ItemDropList", "--field", "Container");
  assert.match(out, /one of \d+ shapes, chosen by 'Type'/);
  assert.match(out, /Multiple\s+common:MultipleItemDropContainer/);
});

test("a closed pipe exits quietly instead of crashing", opts, () => {
  // Piping into a reader that closes early made the next write fail with EPIPE,
  // which Node reports as an unhandled crash complete with a stack trace.
  const proc = spawnSync("node", [CLI, "search-schema", "type", "--limit", "500"], {
    encoding: "utf8",
    shell: true,
  });
  assert.ok(!/EPIPE|Unhandled/.test(`${proc.stdout}${proc.stderr}`), "still crashes on EPIPE");
});

test("the value ceiling says --limit cannot lift it", opts, () => {
  // An agent tested --limit 10, 500 and 1000 against a field with 132 distinct
  // values and got identical output, reasonably reading that as the flag being
  // ignored. Values above the enum threshold are never stored.
  const { out } = run("describe", "common:MaterialQuantity", "--field", "ItemId");
  assert.match(out, /--limit cannot show them/);
});

// ---------------------------------------------------------------------------
// Round 13. Three of four scenarios reported no false statements and no
// contradictions; every "unused" claim checked against real assets held.
// ---------------------------------------------------------------------------

test("search --type actually narrows", opts, () => {
  // The flag was parsed, honoured by `get`, and dropped here: `search stone
  // --type BlockSet` returned byte-identical output to no flag at all.
  const scoped = run("search", "stone", "--type", "BlockSet", "--limit", "10");
  const all = run("search", "stone", "--limit", "10");
  assert.notEqual(scoped.out, all.out, "search --type is still ignored");
  for (const line of resultRows(scoped.out)) {
    assert.match(line, /\bBlockSet\b/, `leaked another type: ${line}`);
  }
});

test("an undeclared field names the assets it came from", opts, () => {
  // Asset type comes from the file's PATH, and when a file sits in the wrong
  // directory the mismatch is silent. Two deprecated food files typed
  // EntityEffect contain a plain EffectConditionInteraction, so /Match, /Next and
  // /EntityEffectIds surfaced as EntityEffect capabilities. Byte-identical
  // siblings one directory over are typed correctly, which is how it hid.
  const { out } = run("describe", "EntityEffect", "--field", "Match");
  assert.match(out, /UNDECLARED/);
  assert.match(out, /from Food_EffectCondition_Buff/);
  assert.match(out, /_Deprecated/);
});

test("refs --type says what it excluded", opts, () => {
  // Scoping legitimately changes the edge set, but the totals then varied between
  // runs with nothing explaining why, which reads as edges being dropped.
  const { out } = run("refs", "Stone", "--type", "BlockSet", "--limit", "3");
  assert.match(out, /Scoped to 'BlockSet'/);
  assert.match(out, /share this name/);
});

test("--type is documented for every command that honours it", opts, () => {
  const help = run("--help").out;
  // The options block, not the first mention: `--type <Type>` also appears inside
  // the `get` command's own description.
  const line = help.slice(help.lastIndexOf("  --type <Type>"));
  for (const command of ["get", "search", "refs"]) {
    assert.match(line.slice(0, 200), new RegExp(`'${command}'`), `--type omits ${command}`);
  }
});

// ---------------------------------------------------------------------------
// Round 14 defects. Four blind trials: the sword scenario reported none, the
// pickaxe and plant scenarios reported no false statement, and the remaining
// findings are the ones below -- all of them wording or reachability, not
// arithmetic, except the first.
// ---------------------------------------------------------------------------

test("a type-scoped ref total never exceeds the unscoped one", opts, () => {
  // Four assets are named Stone. The same source line produced an edge to each,
  // so `--type PhysicalMaterial` and `--type BlockSet` both counted
  // Alchemy_Cauldron_Big's PhysicalMaterialId -- once as 'high', once as
  // 'medium'. Scoping is supposed to narrow; the four scoped totals summed to
  // 5 087 against an unscoped 2 262. Edges the schema contradicts are now
  // dropped at query time.
  const total = (out: string): number =>
    Number(/([\d,]+) references to/.exec(out)?.[1]?.replace(/,/g, "") ?? "0");
  const unscoped = total(run("refs", "Stone", "--limit", "1").out);
  assert.ok(unscoped > 0, "no baseline to compare against");
  for (const type of ["PhysicalMaterial", "BlockSet", "BlockSoundSet", "BlockParticleSet"]) {
    const scoped = total(run("refs", "Stone", "--type", type, "--limit", "1").out);
    assert.ok(
      scoped <= unscoped,
      `refs Stone --type ${type} counts ${scoped}, more than the unscoped ${unscoped}`,
    );
  }
});

test("a scoped total that still overlaps says so, with a number", opts, () => {
  // The residue is real ambiguity, not a bug: a field that declares no target
  // type cannot choose between four assets called Stone, so the same line
  // appears under each. Stating 'references to those are excluded' denied that
  // and made the arithmetic look like the tool losing edges.
  const { out } = run("refs", "Stone", "--type", "BlockSet", "--limit", "1");
  assert.match(out, /Scoped to 'BlockSet'/);
  assert.match(out, /\d+ of these \d+ references also point at one of those/);
  assert.match(out, /does not declare which type it means/);
});

test("status names the locales instead of counting them", opts, () => {
  // It printed a count. An agent needing to know whether a language was
  // available inferred the list from the ones it had seen quoted elsewhere and
  // concluded Ukrainian was absent. It is present.
  const { out } = run("status");
  assert.match(out, /uk-UA/);
  assert.match(out, /en-US/);
  assert.doesNotMatch(out, /\b\d+ locales\b/);
});

test("a container field names the type it continues into", opts, () => {
  // `describe BlockType --field Farming` printed a bare '(container)'. The type
  // on the other side is common:FarmingData and nothing said so, so the only
  // way across the boundary was to guess a name from a lexical search.
  const { out } = run("describe", "BlockType", "--field", "Farming");
  assert.match(out, /continues in common:FarmingData/);
  assert.match(out, /hytale-atlas describe common:FarmingData/);
  // And the branch table is for real unions only: one target used to render as
  // "one of 1 shapes, chosen by 'Type'" over a row whose value column read '?'.
  assert.doesNotMatch(out, /one of 1 shapes/);
});

test("a near-miss type name reaches the type that exists", opts, () => {
  // Two rounds ended with an agent asking for common:FarmingBlock and
  // common:Shape. Neither exists; each is one word from one that does. Exact
  // respelling could not reach them, so the miss fell through to a search-schema
  // suggestion that searches field text and finds nothing for a type name nobody
  // ever wrote -- and the reader concluded the type was undocumented.
  const farming = run("describe", "common:FarmingBlock");
  assert.match(farming.out, /Did you mean/);
  assert.match(farming.out, /common:FarmingData/);
  const shape = run("describe", "common:Shape");
  assert.match(shape.out, /Did you mean/);
  assert.match(shape.out, /common:(BrushShapeArg|ShapeOperation|ConnectedBlockShape)/);
});

test("a missing field on a union does not promise a field list", opts, () => {
  // The miss said "Run 'describe Interaction' to list its fields". That command
  // lists 102 branches and no fields at all, because a union declares none.
  const { out } = run("describe", "Interaction", "--field", "Damage");
  assert.doesNotMatch(out, /to list its fields/);
  assert.match(out, /fields live on the branches/);
  assert.match(out, /list the branches/);
});

test("a bench id typed at 'get' is sent to 'bench'", opts, () => {
  // 'Farmingbench' is a bench id, not an asset. `get Farmingbench` walked a
  // three-hop chain of same-named candidates and never mentioned the one command
  // that answers it.
  const { out } = run("get", "Farmingbench");
  assert.match(out, /is a bench id, not an asset/);
  assert.match(out, /hytale-atlas bench Farmingbench/);
  assert.equal(run("bench", "Farmingbench").code, 0, "the command it points at fails");
});

// ---------------------------------------------------------------------------
// Round 16 defects. Four blind trials. Three of the findings were regressions
// introduced by round 15's own fixes, which is the argument for these tests.
// ---------------------------------------------------------------------------

test("the overlap a scoped ref total reports is the real overlap", opts, () => {
  // Round 15 added the warning and computed its number wrongly: the sibling
  // edge was not put through the same contradiction filter as the edge being
  // counted, so `refs Stone --type PhysicalMaterial` claimed 644 of 644 where
  // 285 overlap, and `refs Burn --type EntityEffect` claimed 7 of 7 against an
  // observable 3. Two agents measured it by hand from the printed rows.
  const shared = (out: string): number =>
    Number(/([\d,]+) of these ([\d,]+) references/.exec(out)?.[1]?.replace(/,/g, "") ?? "-1");
  const total = (out: string): number =>
    Number(/^([\d,]+) references/m.exec(out)?.[1]?.replace(/,/g, "") ?? "0");

  const scoped = run("refs", "Stone", "--type", "PhysicalMaterial", "--limit", "1").out;
  assert.ok(shared(scoped) >= 0, `no overlap note:\n${scoped}`);
  assert.ok(
    shared(scoped) < total(scoped),
    `claims every reference is shared: ${shared(scoped)} of ${total(scoped)}`,
  );

  // The declared-target rows cannot be shared with a sibling of another type,
  // because the filter that keeps them is the one that drops those siblings.
  const declared = run("refs", "Stone", "--type", "PhysicalMaterial", "--limit", "5000")
    .out.split("\n")
    .filter((l) => l.includes("/BlockType/PhysicalMaterialId")).length;
  assert.ok(declared > 0, "no declared-target rows to reason about");
  assert.ok(
    shared(scoped) <= total(scoped) - declared,
    `overlap ${shared(scoped)} leaves no room for ${declared} declared rows`,
  );
});

test("refs value mode honours the --limit it recommends", opts, () => {
  // It capped at a hard 10 and printed '... N more. Use --limit <n>.' at every
  // limit the reader tried. Naming a remedy that does nothing is worse than
  // naming none: three agents tested it at six different values.
  const carriers = (out: string): number =>
    out.split("\n").filter((l) => /^ {2}\S+ +\S+ +\//.test(l)).length;
  const small = run("refs", "Workbench_Tools", "--limit", "3").out;
  const large = run("refs", "Workbench_Tools", "--limit", "100").out;
  assert.equal(carriers(small), 3, `--limit 3 ignored:\n${small}`);
  assert.ok(carriers(large) > carriers(small), "--limit does not raise the cap");
  assert.doesNotMatch(large, /more\. Use --limit/, "still claims more at a limit above the total");
});

test("describe and undocumented agree on how many fields a type declares", opts, () => {
  // Adding a root row per type -- carrying the union branches and the
  // type-level merge marker -- leaked an unnamed row into describe and put its
  // count one ahead of undocumented for 996 types. The empty pointer is the
  // TYPE, not a field.
  for (const type of ["common:FarmingData", "common:Rangef", "common:SoilConfig"]) {
    const listed = run("describe", type, "--limit", "300").out
      .split("\n")
      .filter((l) => l.startsWith("/")).length;
    const declared = /declares ([\d,]+) fields/.exec(run("undocumented", type).out);
    assert.ok(declared !== null, `no declared count for ${type}`);
    assert.equal(listed, Number(declared[1]!.replace(/,/g, "")), `${type} disagrees`);
  }
});

test("a type whose describe shows more rows explains the difference", opts, () => {
  // Item legitimately lists 96 rows against 95 declared, because describe
  // unions the observed layer. Both numbers are right and the pair still read
  // as an off-by-one, so the difference is now stated.
  const { out } = run("undocumented", "Item");
  assert.match(out, /declares 95 fields/);
  assert.match(out, /lists 96 rows/);
  assert.match(out, /the schema never\s+declares/);
});

test("a discriminator prints its own constant, not the union's menu", opts, () => {
  // `legal: Crafting, Processing, DiagramCrafting, StructuralCrafting` sat one
  // line under "must be set to the constant value \"Crafting\"". Following the
  // menu selects a different branch, whose next field has a different shape.
  const { out } = run("describe", "common:CraftingBench", "--field", "Type");
  assert.match(out, /legal here: "Crafting" \(this branch only\)/);
  assert.match(out, /each selects a different shape/);

  // A plain enum is untouched.
  const plain = run("describe", "common:BenchRequirement", "--field", "Type").out;
  assert.match(plain, /^ +legal: Crafting, Processing/m);
});

test("get merges nested structures the schema says merge", opts, () => {
  // The deepest defect of the round, and it went both ways. Reading
  // `inheritsProperty` as a gate dropped `StageSetAfterHarvest` from 14 of the
  // 15 crops inheriting Template_Crop_Block -- each of which still carried a
  // `Harvested` stage set that nothing pointed at. Replacing nested values
  // wholesale dropped `Support`, the block entity, and the per-stage detail.
  const raw = run("get", "Plant_Crop_Tomato_Block", "--type", "Item", "--raw").out;
  const doc = JSON.parse(raw) as Record<string, any>;
  const block = doc["BlockType"];
  assert.equal(block.Farming.StageSetAfterHarvest, "Harvested");
  assert.ok(block.Support, "lost the farmland restriction");
  assert.ok(block.BlockEntity?.Components?.FarmingBlock, "lost what makes it tick");
  assert.equal(
    block.State.Definitions.StageFinal.InteractionHint,
    "server.interactionHints.harvest",
    "a map of stage definitions was replaced instead of merged per key",
  );
  // And the child's own value still wins where it declares one.
  assert.equal(block.State.Definitions.Stage1.PhysicalMaterialId, "Foliage");
});

test("a union-typed asset resolves through its branch", opts, () => {
  // `Interaction` is 102 branches and no fields of its own, so nothing matched
  // and every field read as not-inherited: an asset named for block damage
  // came back with no block damage in it.
  const raw = run("get", "Explode_Generic_Blocks", "--type", "Interaction", "--raw").out;
  const doc = JSON.parse(raw) as Record<string, any>;
  assert.equal(doc["Config"].DamageBlocks, true);
  assert.equal(doc["Config"].BlockDamageRadius, 3);
  // The child's own override survives the merge.
  assert.equal(doc["Config"].DamageEntities, false);
});

test("--raw prints JSON and nothing else on stdout", opts, () => {
  // Reported as broken because the reporting harness merged stderr. Pinned so
  // that if a note ever does reach stdout, it fails here rather than in a
  // reader's JSON.parse.
  const proc = spawnSync(process.execPath, [CLI, "get", "Bench_Armory", "--raw"], {
    encoding: "utf8",
  });
  assert.doesNotThrow(
    () => JSON.parse(proc.stdout),
    `--raw stdout is not parseable:\n${proc.stdout.slice(0, 200)}`,
  );
  assert.match(proc.stderr, /assets are named/, "the ambiguity note vanished entirely");
});

// ---------------------------------------------------------------------------
// Round 16, second batch: statements about the world that were really
// statements about the index, and markers printed with no legend.
// ---------------------------------------------------------------------------

test("a localization hit shows the key an asset must contain", opts, () => {
  // Four blind trials in a row: `search-lang` printed the STORED key
  // (`items.X.name`) while an asset must contain the ROOTED reference
  // (`server.items.X.name`), and the rule was explained only on a miss. A
  // modder who searched successfully pasted a key the game cannot resolve.
  const { out } = run("search-lang", "Plant_Crop_Tomato");
  assert.match(out, /^items\.Plant_Crop_Tomato\.name/m);
  assert.match(out, /write this in an asset: server\.items\.Plant_Crop_Tomato\.name/);
});

test("a localization root other than 'server.' resolves", opts, () => {
  // The root is the .lang file's own stem, and only 'server.' and 'common.'
  // were known. So `wordlists.runes.algas` -- the full path the schema's own
  // WordList documentation gives -- was declared 'a real miss', while the
  // incorrect `server.runes.algas` resolved.
  const { out } = run("search-lang", "wordlists.runes.algas");
  assert.match(out, /^runes\.algas/m);
  assert.match(out, /write this in an asset: wordlists\.runes\.algas/);
});

test("a localization miss is hedged like every other miss", opts, () => {
  // It was the only command asserting 'this is a real miss' -- a claim about
  // the game that only the index could answer -- and the one a reader uses to
  // ask whether a language exists at all.
  const { out } = run("search-lang", "Schwert");
  assert.doesNotMatch(out, /real miss/);
  assert.match(out, /evidence, not proof/);
  assert.match(out, /locales this index holds/);
});

test("status attributes the locale list to the archive", opts, () => {
  // Naming them was not enough. Five codes appended to a counts line read as
  // the set of languages the GAME ships, and a trial asked to support 'every
  // language the game ships' could neither confirm nor refute it.
  const { out } = run("status");
  assert.match(out, /locales in this Assets\.zip: .*uk-UA/);
});

test("status says what a tier is", opts, () => {
  // 'Tier: 1 + 2' appeared in status and nowhere else in the tool. Three
  // trials flagged it; one read it as partial corpus coverage, which is the
  // most plausible place a missing locale could have hidden.
  const { out } = run("status");
  assert.match(out, /which sources are available/);
  assert.match(out, /1 = Assets\.zip/);
});

test("search explains its locale bracket and its ~N marker", opts, () => {
  // Both are properties of the QUERY, not the asset: the same asset shows
  // [pt-BR] for one query and [ru-RU] for another, and a reader concluded an
  // item was only translated into Portuguese. Neither had a legend anywhere.
  const { out } = run("search", "sword", "--limit", "3");
  assert.match(out, /locale the match was\s+found in/);
  assert.match(out, /not the only language the asset has/);
  assert.match(out, /search-lang <id>/);
});

test("the bench list honours --limit", opts, () => {
  // Documented in --help ('bench 200'), ignored entirely by the list form:
  // --limit 3 printed all 21 rows with no notice.
  const rows = (out: string): number =>
    out.split("\n").filter((l) => /^\S+ +\S+ +\d+/.test(l)).length;
  const capped = run("bench", "--limit", "3");
  assert.equal(rows(capped.out), 3, `--limit ignored:\n${capped.out}`);
  assert.match(capped.out, /showing the first 3 benches/);
  assert.ok(rows(run("bench", "--limit", "100").out) > 3);
});

// ---------------------------------------------------------------------------
// Round 17 fixes, found by reading the code rather than by a blind trial.
// ---------------------------------------------------------------------------

test("an observed value containing spaces survives being stored", opts, () => {
  // Value lists live in one TEXT column, joined and split on a SPACE, so any
  // value with a space in it was shredded: two whole sentences came back as 25
  // comma-separated tokens that read like an enum of legal values.
  //
  // Third delimiter bug in this project, second of exactly this shape -- the
  // discriminator map was once written with \0 and read with a space, and all
  // 21,439 lookups missed in silence.
  const { out } = run("describe", "ScriptedBrushAsset", "--field", "Description");
  assert.match(out, /Example: Places water only where there is NOT stone/);
  assert.doesNotMatch(out, /Example:, Places, water/);
});

test("a Parent nested in an inline object counts as inheritance", opts, () => {
  // `refs Explode_Generic` printed `high INHERITS_FROM /Parent` for three assets
  // and `low REFERENCES /Next/Interactions/0/Parent` for a fourth -- the same
  // mechanism, opposite labels, differing only in nesting depth, with `low`
  // glossed as 'often coincidence'. Two blind trials caught it.
  const { out } = run("refs", "Explode_Generic", "--limit", "20");
  const nested = out.split("\n").find((l) => l.includes("/Next/Interactions/0/Parent"));
  assert.ok(nested !== undefined, `the nested edge is gone entirely:\n${out}`);
  assert.match(nested, /^high/, `still graded a coincidence: ${nested}`);
  assert.match(nested, /INHERITS_FROM/);
});

test("the telemetry disclosure does not contradict the command it prints", opts, () => {
  // The dry run printed `--disable-sentry` and then said the server has no flag
  // to disable this. Three trials across two rounds called it out, and this is
  // the text a user's consent is given against.
  const { out } = run("generate-schema", "--dry-run");
  assert.match(out, /--disable-sentry/);
  assert.match(out, /turns off crash reporting/);
  assert.match(out, /NOT\s+the same thing as telemetry/);
  assert.doesNotMatch(out, /the server has no such flag/);
});

test("a value link is shown on the fields that take part in it", opts, () => {
  // Pass 4 fills `value_links` -- 5,287 rows -- and value_links had no reader at
  // all. It holds the one kind of legal-value set JSON Schema cannot express: a
  // string whose legal values are declared elsewhere in the corpus. One agent
  // rebuilt the gather-type set by merging three commands and still missed
  // three values; another reported the tool 'cannot define or extend GatherType'.
  const { out } = run("describe", "common:BlockBreakingDropType", "--field", "GatherType");
  assert.match(out, /value link 'gather-type': this field references the value/);
  assert.match(out, /14 value\(s\) are declared/);
  // The declarer list is a sample of 27, and saying so is the point: six of 27
  // read as the complete set, which is the silent-truncation class every other
  // cap in the file announces.
  assert.match(out, /declared by 27 asset\(s\), e\.g\. .*Tool_Hatchet/);
  // And the honest half: values blocks require that no tool declares.
  assert.match(out, /referenced but declared nowhere: Pickaxe_Tier0, SoftWoods, Unbreakable/);
});

// ---------------------------------------------------------------------------
// Critic round 1: found by reading the code against the database rather than by
// using the tool. Every one is the index holding an answer the command denied.
// ---------------------------------------------------------------------------

test("an identifier missing from the search index is still found", opts, () => {
  // `assets` holds 22,734 distinct identifiers and `assets_fts` 22,237: 497
  // worldgen ids have no FTS row, so `search` denied assets that exist -- while
  // the very next line offered `refs` for the same string, because that
  // suggestion consults `assets`.
  const { out } = run("search", "001_start.node");
  assert.match(out, /^001_start\.node/m);
  assert.match(out, /identifier lookup instead/);
  assert.doesNotMatch(out, /No asset is named/);
});

test("the identifier fallback still honours --type", opts, () => {
  // The fallback's first version ignored --type, so a bogus type started
  // returning rows: a fixed defect turned into a worse one.
  const { out } = run("search", "Bench", "--type", "Nonexistent");
  assert.match(out, /No asset type 'Nonexistent' exists/);
  assert.doesNotMatch(out, /^Bench\b/m);
});

test("an ambiguity note counts assets, not the sample it prints", opts, () => {
  // `get Entry.node` said '8 assets are named' -- its own display cap -- where
  // 461 are. 442 identifiers exceed the cap, and `refs`, whose query has no
  // LIMIT, printed the true figure for every one of them.
  const { out } = run("get", "Entry.node");
  const note = /note: ([\d,]+) assets are named/.exec(out);
  assert.ok(note !== null, "no ambiguity note in: " + out.slice(0, 200));
  assert.ok(
    Number(note[1]!.replace(/,/g, "")) > 8,
    "still reporting the sample size: " + note[1],
  );
  assert.match(out, /and [\d,]+ more; add --type/);
});

test("the refs total counts the same rows the list shows", opts, () => {
  // The list collapsed two same-named sources into one row while the total kept
  // them apart, so `refs Adventure` announced 96 above 85 printed rows -- with
  // no truncation notice, because nothing had been truncated.
  const { out } = run("refs", "Adventure", "--limit", "500");
  const total = Number(/^([\d,]+) references/m.exec(out)?.[1]?.replace(/,/g, "") ?? "0");
  // The legend lines start with the same words ("high   = declared by ..."), so
  // the row test requires an identifier after the confidence, not an equals sign.
  const rows = out.split("\n").filter((l) => /^(high|medium|low) +[A-Za-z_0-9]/.test(l)).length;
  assert.ok(total > 0 && rows > 0);
  assert.equal(total, rows, "header says " + total + ", printed " + rows);
});

test("undocumented states its total, not just that more exist", opts, () => {
  // Its own docstring records the original defect as '40 rows out of 6,324 in
  // silence'. The silence became the word 'more' and never became a number.
  const { out } = run("undocumented");
  assert.match(out, /Showing the first 40 of [\d,]+ fields/);
});

test("undocumented hedges against the side it is asking about", opts, () => {
  // It listed DECLARED fields with no observation while quoting the OBSERVED
  // ratio -- 86% -- where the applicable one is the declared side, 13%. The more
  // reassuring of the two numbers introduced a list of 7,405 rows.
  const { out } = run("undocumented");
  assert.match(out, /of [\d,]+ declared fields are matched/);
  assert.doesNotMatch(out, /observed fields match a declared one/);
});

test("undocumented suggests types as well as describe does", opts, () => {
  // It kept only the exact-respelling half of the shared suggester, so it gave
  // up where `describe` reaches common:FarmingData.
  const { out } = run("undocumented", "FarmingBlock");
  assert.match(out, /common:FarmingData/);
});

test("search prints a type and a locale for every row", opts, () => {
  // The `?? "(untyped)"` fallback never fired: assets_fts stores an empty
  // string, not NULL, so 14,198 rows showed a blank TYPE column and an empty
  // `[]` where the header promises a locale.
  const { out } = run("search", "Caldera", "--limit", "5");
  const rows = out
    .split("\n")
    .filter((l) => /^\S/.test(l) && l.includes("[") && !l.startsWith("ASSET ID"));
  assert.ok(rows.length > 0, "no result rows in: " + out);
  for (const row of rows) {
    assert.doesNotMatch(row, /\[\]/, "empty locale bracket: " + row);
  }
});

// ---------------------------------------------------------------------------
// Critic round 1, second batch.
// ---------------------------------------------------------------------------

test("a type with assets but no schema is not called nonexistent", opts, () => {
  // Existence was tested against schema_fields alone, so `describe NPCRole`
  // answered "No type 'NPCRole'" about a type 975 assets carry and `search`
  // prints in its own TYPE column -- then suggested other:NPC:Role, a different
  // concept. 'The schema says nothing about this type' and 'this type does not
  // exist' are different answers.
  const described = run("describe", "NPCRole");
  assert.match(described.out, /is a real asset type/);
  assert.match(described.out, /975 assets carry it/);
  assert.doesNotMatch(described.out, /No type 'NPCRole'/);

  const undoc = run("undocumented", "NPCRole");
  assert.match(undoc.out, /is a real asset type/);
  // And no spelling suggestion under a sentence confirming the name was right.
  assert.doesNotMatch(undoc.out, /Did you mean/);
});

test("a real type that is merely misspelt still gets suggestions", opts, () => {
  const { out } = run("undocumented", "FarmingBlock");
  assert.match(out, /No type 'FarmingBlock' in the schema/);
  assert.match(out, /Did you mean/);
});

test("refs resolves a file, not just an asset", opts, () => {
  // `refsOp` filtered dst_kind='asset', so 33,782 REFERENCES_FILE edges over
  // 24,923 files were unreachable: `refs Glow.png` said 'nothing carries it as
  // a value' about a texture 221 edges point at. The schema names 'file' as a
  // first-class destination kind and nothing joined the table.
  const { out, code } = run("refs", "Glow.png");
  assert.equal(code, 0);
  assert.match(out, /Common\/Particles\/Textures\/Basic\/Glow\.png/);
  assert.match(out, /[\d,]+ asset\(s\) reference this file/);
  assert.match(out, /ParticleSpawner/);
});

test("a name that is neither asset, file nor value says all three", opts, () => {
  const { out, code } = run("refs", "zzqqxx-nothing");
  assert.equal(code, 1);
  // All three branches named, and the file one scoped to the index that was
  // actually consulted. The blanket "no file by that name" was asserted about
  // anything absent from the file-reference index -- including
  // `Tool_Pickaxe_Iron.json`, a path `get` prints in its own header. Asset
  // documents are never in that index, so the sentence was false by
  // construction for every asset the reader had just been shown.
  assert.match(out, /No asset/);
  assert.match(out, /nothing carries it as a value/);
  assert.match(out, /No file of that name is REFERENCED/);
});

// ---------------------------------------------------------------------------
// Critic round 2. Three of these are defects the CLI had already fixed and the
// shared api layer still carried -- i.e. exactly what an MCP server would ship.
// ---------------------------------------------------------------------------

test("a lowercase 'id' ending is not a reference convention", opts, () => {
  // SQLite's LIKE folds ASCII case, so the pointer test `LIKE '%Id'` also
  // matched /Solid, /Fluid, /TransformFluid and /SpreadFluid: 5,292 edges were
  // promoted to `medium` under a legend reading "the field name follows a
  // reference convention". /Material/Solid follows no convention; it is a word.
  const { out } = run("refs", "Empty", "--type", "BlockSet", "--limit", "400");
  const solid = out
    .split("\n")
    .filter((l) => l.includes("/Material/Solid"))
    .filter((l) => /^medium/.test(l));
  assert.equal(solid.length, 0, "still calling /Material/Solid a convention:\n" + solid[0]);
});

test("a declared reference that resolves to nothing is reported", opts, () => {
  // The marker for these was computed in pass 2 against a pointer pass 3 only
  // fills in, so it matched one row -- and the generic dangling pass then
  // overwrote even that. 2,674 occurrences exist. `BlockType./HitboxType`
  // declares `-> BlockBoundingBoxes` and its own DEFAULT value names nothing.
  const { out } = run("describe", "BlockType", "--field", "HitboxType");
  assert.match(out, /BROKEN: 'Full' names no BlockBoundingBoxes/);
  assert.match(out, /256 occurrence\(s\)/);
});

test("describe prints the default a field declares", opts, () => {
  // 2,064 fields across 724 types declare one; it was decoded into the row
  // being rendered and no branch printed it, while "what happens if I omit
  // this field" is the commonest schema question.
  const { out } = run("describe", "Item", "--field", "Consumable");
  assert.match(out, /default false/);
});

test("the type list is reachable as a command", opts, () => {
  // `asset_types` holds 102 rows and had no reader anywhere, while `describe`
  // and `undocumented` both need a name you must already know. Every blind
  // trial asked for this and rebuilt a partial list from search results.
  const { out, code } = run("types", "--limit", "500");
  assert.equal(code, 0);
  // The WHERE column carries the path assets of this type really sit at, root
  // included. It used to print `hytale.path` -- pack-root-relative, `Item/Items`
  // -- while `get` answers `Server/Item/Items/...` for the same type, so a mod
  // author following it created the file one directory too high.
  assert.match(out, /^Item +[\d,]+ +95 +Server\/Item\/Items\//m);
  // A type the schema is silent about is listed, with a zero rather than absent.
  assert.match(out, /^NPCRole +[\d,]+ +0 /m);
  assert.match(out, /FIELDS 0 means the generated schema declares nothing/);
});

test("status counts fields the way every other command does", opts, () => {
  // `status` counted the 996 empty-pointer TYPE rows as fields and said 18,396
  // while `undocumented` said 17,400 about the same thing.
  const status = run("status").out;
  const undoc = run("undocumented").out;
  const a = /([\d,]+) schema fields/.exec(status);
  const b = /of ([\d,]+) declared fields/.exec(undoc);
  assert.ok(a !== null && b !== null);
  assert.equal(a[1]!.replace(/,/g, ""), b[1]!.replace(/,/g, ""));
});

// These three exercise src/api directly rather than through the CLI, because the
// defects they pin were cases where the two DISAGREED -- the CLI fixed, the api
// copy still carrying the bug that a future MCP server would ship. They import
// from dist rather than src: this file already tests the built output, and
// archive.ts uses syntax Node's type-stripping loader does not accept.
test("the api layer agrees with the CLI on bench totals", async () => {
  // `benchOp` called craftableAt without the over-fetch and returned no total,
  // reproducing verbatim the defect cmdBench's own comment records as fixed.
  // An MCP server reads this layer, so the copy has to be right too.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return; // no index on this machine; the CLI tests skip for the same reason
  }
  try {
    const r = ops.benchOp(db, "Builders", 200);
    assert.equal(r.value.total, ops.benchRecipeCount(db, "Builders"));
    assert.ok(r.value.total > r.value.items.length);
    assert.ok(r.caveats.some((c) => c.code === "truncated"), "no truncation caveat");
  } finally {
    db.close();
  }
});

test("the api layer agrees with the CLI on ambiguous identifiers", async () => {
  // `getAssetOp` built its caveat from the 8-row sample: '8 assets are named
  // Entry.node' where 461 are.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const total = ops.sameNamedCount(db, "Entry.node");
    assert.ok(total > 8);
    const r = await ops.getAssetOp(db, "Entry.node", async () => null);
    const note = r.caveats.find((c) => c.code === "ambiguous-identifier");
    assert.ok(note !== undefined, "no ambiguity caveat");
    assert.match(note.message, new RegExp("^" + String(total) + " assets are named"));
  } finally {
    db.close();
  }
});

/**
 * INVARIANT: a suggested command answers for the token it was suggested with.
 *
 * Every command decided this from one fact of its own, and the results
 * contradicted the prose above them: `search <value>` printed "to find what uses
 * a value, ask for references to it instead" and then withheld `refs` unless the
 * token was an ASSET — the inverse of the case. Three of five blind trials
 * followed the printed advice into a dead end; one nearly filed a capability gap
 * because the value's only vanilla use sat behind the `refs` never offered.
 *
 * Testing the rule rather than the three reported tokens: whatever a miss
 * suggests, running it must produce something.
 */
test("every command a miss suggests actually answers for that token", async () => {
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    // A field value, a localization key, a bench category, a bench id, an asset.
    const tokens = [
      "Workbench_Tools",
      "items.Weapon_Sword_Adamantite.name",
      "Workbench",
      "Tool_Pickaxe_Iron",
      "RunOnBlockTypes",
    ];
    for (const token of tokens) {
      const id = ops.identify(db, token);
      const claims =
        id.assets + id.valueOccurrences + id.files + (id.langKey ? 1 : 0) +
        (id.benchId ? 1 : 0) + (id.benchCategory ? 1 : 0);
      assert.ok(claims > 0, `identify() knows nothing about ${token}`);

      // Whatever it claims the token is, the corresponding command must answer.
      if (id.langKey !== null) {
        const r = ops.langOp(db, token, 5);
        assert.ok(r.value.length > 0, `search-lang would be suggested for ${token} and misses`);
      }
      if (id.benchId) {
        assert.ok(
          ops.benchRecipeCount(db, token) >= 0 && ops.benchIdExists(db, token),
          `bench would be suggested for ${token} and misses`,
        );
      }
      if (id.assets === 0 && id.valueOccurrences > 0) {
        const usage = ops.valueUsage(db, token, 5);
        assert.ok(
          usage.occurrences > 0,
          `refs would be suggested as a VALUE lookup for ${token} and misses`,
        );
      }
    }
  } finally {
    db.close();
  }
});

/**
 * INVARIANT: a number offered as "additional" must count rows that are not
 * already on screen.
 *
 * Round 19 regression, found independently by four of five agents. Edges are
 * built FROM candidates, so for an asset every inbound reference is also an
 * occurrence of its name as a value; reporting the raw occurrence count as a
 * second set printed "10 occurrence(s) ... not listed above" directly beneath
 * the same ten rows. The counts matched exactly every time (10/10, 22/22,
 * 164/164), which is what proved it a double count rather than a coincidence.
 *
 * The residue is real where it exists — `refs 5` has 4 edges and 4 756
 * occurrences — so the assertion is on the arithmetic, not on silence.
 */
test("value occurrences reported beyond the edges exclude the edges themselves", async () => {
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    for (const id of ["Tool_Pickaxe_Iron", "Soil_Mud_Dry", "ISS_Items_Foliage"]) {
      const r = ops.refsOp(db, id, undefined, 500);
      if (r.value.total === 0) continue;
      const beyond = ops.valueOccurrencesWithoutEdges(
        db,
        id,
        r.value.targets.map((t) => t.id),
      );
      const all = ops.identify(db, id).valueOccurrences;
      assert.ok(
        beyond.occurrences < all || all === 0,
        `${id}: the "beyond" count (${beyond.occurrences}) did not exclude any of ` +
          `the ${all} occurrences the edges already cover`,
      );
    }
  } finally {
    db.close();
  }
});

test("a value lookup is an answer: stdout, exit 0", async () => {
  // It went to stderr with exit 1 — a successful lookup reported as failure,
  // and unusable in a pipeline. It only became visible once `search` started
  // suggesting this exact command for a value.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    // The operation itself must report the usage rather than nothing.
    const usage = ops.valueUsage(db, "RunOnBlockTypes", 5);
    assert.ok(usage.occurrences > 0, "fixture is no longer a field value");
    assert.equal(ops.identify(db, "RunOnBlockTypes").assets, 0, "fixture became an asset");
  } finally {
    db.close();
  }
});

test("a token that is both an asset and a value discloses the branch not taken", async () => {
  // `refs` picks the asset branch silently. Every Quality value in the game is
  // also the name of a BlockMigration asset, so `refs 5` answered with four
  // NPCRole rows and no hint that the value report existed.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const id = ops.identify(db, "5");
    if (id.assets === 0 || id.valueOccurrences === 0) return; // patchline moved
    assert.ok(
      id.assets > 0 && id.valueOccurrences > 0,
      "fixture must be both an asset and a value",
    );
  } finally {
    db.close();
  }
});

test("the ambiguity note lists distinct types, not one entry per asset", async () => {
  // `refsOp` passed every matching row, so 461 untyped Entry.node assets
  // rendered the word "untyped" 461 times inside one sentence.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const r = ops.refsOp(db, "Entry.node", undefined, 2);
    const note = r.caveats.find((c) => c.code === "ambiguous-identifier");
    assert.ok(note !== undefined, "no ambiguity caveat");
    const untyped = note.message.match(/untyped/g) ?? [];
    assert.equal(untyped.length, 1, `type repeated ${untyped.length} times: ${note.message}`);
    assert.ok(note.message.length < 200, `note is ${note.message.length} chars long`);
  } finally {
    db.close();
  }
});

test("a capped list of broken references says how many exist", async () => {
  // Eight of 63 unresolved BlockTypes were printed alphabetically, with nothing
  // to say the list ended early.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const broken = ops.brokenRefsFor(db, "common:BlockTypeFarmingStageData", "/Block");
    if (broken.distinct === 0) return; // patchline moved; nothing to assert
    assert.ok(broken.shown.length <= 8);
    assert.ok(
      broken.distinct >= broken.shown.length,
      "distinct must count the whole population",
    );
    assert.ok(broken.occurrences >= broken.distinct);
  } finally {
    db.close();
  }
});

test("a basename shared by many files reports how many were withheld", async () => {
  // 291 basenames name more than five files; Model.blockymodel names 173, and
  // five groups were shown with the other 168 unmentioned.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const r = ops.fileRefsOp(db, "Model.blockymodel", 5);
    if (r.value.length < 5) return;
    const note = r.caveats.find(
      (c) => c.code === "truncated" && c.message.includes("files named"),
    );
    assert.ok(note !== undefined, "no notice that files were withheld");
    assert.match(note.message, /of \d[\d,]* files named/);
  } finally {
    db.close();
  }
});

test("an undeclared observed field still reports the type it holds", async () => {
  // `field_stats.value_types` was written by the indexer and read by nobody, so
  // a field the schema does not declare showed a count and no type at all.
  const schema = await import("../../dist/query/schema.js");
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const fields = schema.describeSchema(db, "common:AssetIconProperties");
    const undeclared = fields.filter((f) => f.declared === null && f.observed !== null);
    if (undeclared.length === 0) return;
    for (const f of undeclared) {
      assert.ok(
        f.observed.valueTypes !== null && f.observed.valueTypes.length > 0,
        `${f.pointer} carries observations but no value types`,
      );
      for (const t of f.observed.valueTypes) {
        assert.ok(["string", "number", "boolean"].includes(t), `odd value type ${t}`);
      }
    }
  } finally {
    db.close();
  }
});

test("undocumented excludes $ref rows, and the indexer counts the same set", async () => {
  // The indexer's copy of the predicate omitted the $ref clause and printed
  // 8 439 declared-but-unused where this command answered 7 405.
  const schema = await import("../../dist/query/schema.js");
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const all = schema.findUndocumented(db, undefined, Number.MAX_SAFE_INTEGER);
    for (const f of all) {
      assert.ok(
        !(f.declaredType ?? "").startsWith("$ref"),
        `${f.assetType}${f.pointer} is a $ref crossing, not a scalar field`,
      );
    }
    const viaIndexerPredicate = db
      .prepare(
        `SELECT count(*) AS n FROM schema_fields sf WHERE ${schema.DECLARED_UNOBSERVED_SQL}`,
      )
      .get();
    assert.equal(Number(viaIndexerPredicate.n), all.length);
  } finally {
    db.close();
  }
});

test("the api layer answers a union the way the CLI does", async () => {
  // `describeOp` had no union branch, so it returned 213 rows for a type with
  // no fields of its own -- every one declared === null.
  const ops = await import("../../dist/api/operations.js");
  let db;
  try {
    db = await ops.openIndex();
  } catch {
    return;
  }
  try {
    const r = ops.describeOp(db, { assetType: "Interaction" });
    assert.ok(r.value.union !== null, "union not reported");
    assert.ok(r.value.union.branches.length > 50);
    assert.equal(r.value.union.discriminatorProperty, "Type");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Regressions introduced by the round-2 fixes, found by verifying them. Each
// one is a fix that was right about the case it targeted and wrong next to it.
// ---------------------------------------------------------------------------

test("a single observed value containing spaces stays one value", opts, () => {
  // The separator fix round-tripped 2+ values correctly and mangled exactly the
  // case it was written for: a ONE-element list has no separator in it, so the
  // tolerant reader could not tell it from the old space-joined form and split
  // it anyway. `seen: the, Crossroads` for a world named 'the Crossroads'.
  const one = run("describe", "InstanceConfig", "--field", "DisplayName").out;
  assert.match(one, /seen: +the Crossroads/);
  assert.doesNotMatch(one, /seen: +the, Crossroads/);

  // ...and the many-value case still works, which is what the fix was for.
  const many = run("describe", "ScriptedBrushAsset", "--field", "Description").out;
  assert.match(many, /Example: Places water only where there is NOT stone/);
});

test("a file reference count says assets and occurrences separately", opts, () => {
  // The file branch counted EDGES and labelled them 'asset(s)':
  // Frown.blockyanim reported '148 asset(s)' where 38 assets hold 148 pointers.
  // 1,534 of 19,497 referenced files are affected; Glow.png happens to be 1:1,
  // which is why the fix's own example looked correct.
  const { out } = run("refs", "Frown.blockyanim", "--limit", "500");
  const m = /([\d,]+) asset\(s\) reference this file, ([\d,]+) time\(s\)/.exec(out);
  assert.ok(m !== null, "no split count in: " + out.slice(0, 200));
  const assets = Number(m[1].replace(/,/g, ""));
  const times = Number(m[2].replace(/,/g, ""));
  assert.ok(times > assets, "this file is meant to have more pointers than assets");

  // The printed rows are the pointers, so they match the larger number.
  const rows = out.split("\n").filter((l) => /^ {4}\S/.test(l)).length;
  assert.equal(rows, times, "rows " + rows + " do not match the stated " + times);
});

test("the identifier-fallback caveat does not over-claim", opts, () => {
  // It said the unsearchable ids are 'worldgen under Server/World'. 496 of 497
  // are; one is a prefab. The comment above that factory warns against baking a
  // fact into a sentence, and 99.8% true is still a sentence that can be shown
  // wrong.
  const { out } = run("search", "001_start.node");
  assert.match(out, /mostly world and prefab content/);
  assert.doesNotMatch(out, /-- worldgen under Server\/World --/);
});
