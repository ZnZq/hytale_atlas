/**
 * The operation layer: one implementation, two front ends.
 *
 * The CLI renders these results as text; the MCP server will serialise the same
 * objects. Neither may compute anything of its own -- if a front end has to
 * decide something, that decision belongs here.
 *
 * **Caveats are data, not prose.** This is the whole point of the layer, and it
 * is not a stylistic preference: nearly every defect found while testing this
 * tool against uninformed agents was a *statement*, not a computation. `unused`
 * meant "extraction never looked", not "the game does not use it". A schema
 * search miss was reported as proof when it was evidence. A reference list
 * omitted 20 202 untyped assets in silence. A field count meant "files that
 * declare it" while the neighbouring command resolved inheritance first.
 *
 * Every one of those was a sentence in a print statement. Writing MCP against
 * the raw query functions would have reproduced the bugs, not the fixes, because
 * the fixes live in the sentences. So the sentences travel with the data.
 */

/** Something the caller must know to read the result correctly. */
export interface Caveat {
  /** Stable identifier, so a front end can suppress or restyle one. */
  readonly code: CaveatCode;
  /** One sentence, plain, addressed to whoever asked the question. */
  readonly message: string;
}

export type CaveatCode =
  /** More results exist than were returned. */
  | "truncated"
  /** The query had to be loosened to match anything; hits may be unrelated. */
  | "relaxed"
  /** A miss here is evidence, not proof: the index is lexical. */
  | "lexical-only"
  /** Untyped world and prefab assets contribute no references. */
  | "untyped-blind-spot"
  /** Counts predate inheritance; `get` resolves the parent chain first. */
  | "pre-inheritance"
  /** Absence from the observed layer says nothing for this shape. */
  | "container-no-observations"
  /** Observed values exist but are too many to enumerate. */
  | "cardinality-elided"
  /** Several assets share this identifier; one was chosen. */
  | "ambiguous-identifier"
  /** The declared/observed join is incomplete, so absence is weak evidence. */
  | "join-incomplete"
  /** This index stores identifiers and names, not field values. */
  | "names-not-values"
  /** Found by identifier only: these rows are not in the search index. */
  | "identifier-only"
  /** The pointer misses here because the schema tree continues in another type. */
  | "crosses-into"
  /** Recipes require this bench id, but no asset provides a station carrying it. */
  | "bench-undeclared"
  /** The caller's pointer was rewritten before it arrived; this is what was read. */
  | "pointer-repaired"
  /** Part of this answer comes from a third-party pack, not from the game. */
  | "third-party"
  | "working-pack"
  | "shadowed"
  | "shadowed-shown"
  | "contested-packs";

/**
 * Every operation returns its answer alongside what qualifies it.
 *
 * `text` is the answer RENDERED -- the exact bytes a person should see. It lives
 * here, beside the data, because two front ends rendering the same result
 * independently is how this project's front ends drifted: `cmdDescribe` computed
 * its own totals, markers and legends while `describeOp` computed them again,
 * and every round of blind trials found another place the two disagreed. The CLI
 * writes `text` to stdout and the MCP server returns it verbatim, so identical
 * output is a property of the design rather than of anyone's diligence.
 *
 * The structured `value` travels with it and is not redundant: a model acts on
 * `origins`, `declared`/`observed` and the caveat CODES, none of which survive
 * being flattened into prose.
 */
export interface Result<T> {
  readonly value: T;
  readonly caveats: readonly Caveat[];
  /**
   * The same answer WITHOUT the rows that `value` already carries.
   *
   * A tabular row is a second, lossier copy of structured data the caller was
   * handed anyway -- and an MCP client pays for both. What is NOT in `value` is
   * the prose: the qualifications, the explanations of what a column means, the
   * next step to take. That is the part worth serving to a model, and this field
   * is it. Absent where an answer has no table to drop.
   */
  readonly prose?: string;
  /** Rendered form. Optional while the commands are being moved across. */
  readonly text?: string;
}

export function ok<T>(value: T, caveats: readonly Caveat[] = []): Result<T> {
  return { value, caveats };
}

/**
 * The caveat lines that close a rendered answer.
 *
 * `text` is SELF-CONTAINED: it ends with these, so a front end writes one string
 * and cannot forget the qualifications. The CLI used to render them from its own
 * copy of this loop, and `status` -- the first command moved across -- silently
 * stopped printing its join ratio because the new path wrote `text` and the old
 * loop was where the caveats had lived.
 *
 * The structured `caveats` travel alongside regardless: a model reads codes, a
 * person reads lines.
 */
export function caveatBlock(caveats: readonly Caveat[]): string {
  if (caveats.length === 0) return "";
  return `\n${caveats
    .map((c) => `${c.code === "truncated" ? "... " : "note: "}${c.message}\n`)
    .join("")}`;
}

/**
 * Shortens a description to fit one line, visibly.
 *
 * Silent truncation is the failure this surface keeps making in different
 * costumes: this cut a field description mid-word with no ellipsis, and the cut
 * sentence was the one that would have settled whether an area-mining primitive
 * exists. Lives here rather than in the CLI because the operations render now,
 * and a second copy is how the two front ends drifted in the first place.
 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Builds a result that carries its own rendering. */
export function rendered<T>(
  value: T,
  text: string,
  caveats: readonly Caveat[] = [],
  prose?: string,
): Result<T> {
  return { value, caveats, text, ...(prose === undefined ? {} : { prose }) };
}

/**
 * The line every capped list prints, in one place.
 *
 * Each command wrote its own and they disagreed on wording and on whether a
 * total was included at all.
 */
export function truncationLine(shown: number, what: string, total?: number): string {
  return total === undefined
    ? `\n... showing the first ${shown} ${what}; more exist.\n`
    : `\n... showing ${shown} of ${total} ${what}; raise the limit for more.\n`;
}

/** Builds a caveat, keeping the wording in one place per code. */
export const caveat = {
  /**
   * `total` is optional because not every list can count its own tail cheaply,
   * but pass it wherever it is known: "more exist" is the weakest honest thing
   * this sentence can say. `undocumented` showed 40 rows of 7,405 and the
   * word "more" was all a reader got -- the defect its own docstring records is
   * the silence, and "more" is only marginally louder than silence.
   */
  // "Use --limit <n>" named a CLI flag, and this layer is also served over MCP
  // where the argument is `limit` and no flags exist. A remedy the caller cannot
  // apply is the same defect as no remedy, in a costume.
  truncated: (shown: number, what: string, total?: number): Caveat => ({
    code: "truncated",
    message:
      total === undefined
        ? `Showing the first ${shown} ${what}; more exist.`
        : `Showing the first ${shown} of ${total} ${what}; raise the limit for more.`,
  }),
  relaxed: (query: string, level: number, widened: boolean): Caveat => ({
    code: "relaxed",
    message:
      `Nothing matched "${query}" as written. ` +
      (widened ? "Showing fields matching any term" : "Showing loosened matches") +
      (level > 0 ? ` (word endings trimmed ${level}x)` : "") +
      " -- these may be unrelated.",
  }),
  lexicalOnly: (): Caveat => ({
    code: "lexical-only",
    message:
      "This is evidence, not proof. The index is lexical: a capability spelled in " +
      "other words would not match.",
  }),
  untypedBlindSpot: (count: number): Caveat => ({
    code: "untyped-blind-spot",
    message:
      `${count} untyped assets -- world and prefab content -- are indexed and ` +
      "searchable but contribute no references. A structure placing this block by " +
      "name will not appear.",
  }),
  preInheritance: (): Caveat => ({
    code: "pre-inheritance",
    message:
      "Counts cover files that declare the field themselves. 'get' resolves " +
      "inheritance first, so it can show a value on assets not counted here.",
  }),
  containerNoObservations: (): Caveat => ({
    code: "container-no-observations",
    message:
      "This is a container, and only scalar leaves are counted. Absence of " +
      "observed values says nothing about whether the corpus uses it.",
  }),
  cardinalityElided: (distinct: number): Caveat => ({
    code: "cardinality-elided",
    message: `${distinct} distinct values -- too many to enumerate.`,
  }),
  // `total` is separate from `types` because the type list is a SAMPLE. Using
  // its length said "8 assets are named Entry.node" where 461 are.
  //
  // `types` must be DISTINCT type names, and `distinctTypes` how many exist.
  // Given one entry per asset, the parenthesis rendered the word "untyped" 461
  // times in a single sentence; and comparing `total` -- a count of assets --
  // against the length of a list of types put ", and more" after a complete
  // list whenever several assets shared one type.
  // `chosen` and the hidden COUNT were both CLI-only prose. The command printed
  // "Showing the Item one" and "... and 453 more; add --type <Type> to choose",
  // while the caveat -- the half that reaches a model -- said only "and more".
  // Which asset you are actually looking at is the entire point of the sentence.
  ambiguousIdentifier: (
    id: string,
    types: readonly string[],
    total = types.length,
    distinctTypes = types.length,
    chosen?: string,
  ): Caveat => ({
    code: "ambiguous-identifier",
    message:
      `${total} assets are named '${id}' (${types.join(", ")}` +
      (distinctTypes > types.length ? `, and ${distinctTypes - types.length} more type(s)` : "") +
      ")." +
      (chosen === undefined ? "" : ` Showing the ${chosen} one.`) +
      // The remedy has to fit the case. `Entry.node` names 461 assets and every
      // one is untyped, so "add --type <Type> to choose" -- printed unconditionally
      // -- was advice that cannot work, offered at the exact moment a reader most
      // needs a way forward.
      (distinctTypes > 1
        ? ` Add --type <Type> to choose (the 'type' argument over MCP).`
        : total > 1
          ? ` All ${total} are ${chosen ?? types[0] ?? "the same type"}, so a type filter ` +
            `cannot narrow this -- tell them apart by path.`
          : ""),
  }),
  /**
   * Stated over the side the reader's question is on.
   *
   * `undocumented` lists DECLARED fields with no observation, so the risk it
   * carries is measured on the declared side -- 2 457 of 18 396, 13% -- while
   * this sentence quoted the observed side, 2 457 of 2 875, 86%. The most
   * reassuring of the two ratios introduced a list of 7 405 rows.
   */
  // The hazard runs the opposite way depending on what the list contains, and
  // one wording served both. `undocumented` LISTS the unmatched, so a failed
  // join puts a field INTO the results -- it is presence that the ratio
  // undermines, not absence. `status` reports the ratio itself, where the
  // reader's risk is trusting the observed layer to be complete.
  /**
   * Names the packs an answer drew on, when any of them is not the game.
   *
   * Measured, not theorised: with 31 packs indexed, agents called `Multitools`,
   * `Gravestones`, `Perfect Parries` and `WansWonderWeapon` assets "vanilla" --
   * one of them concluding that a mod's plugin interaction was "compiled into
   * the engine". They were right whenever the pack prefixed its identifiers and
   * wrong whenever it did not, which makes correctness a property of someone
   * else's naming convention rather than of this index.
   *
   * A modder who builds on an asset believing it ships with the game writes a
   * pack that breaks for everyone who does not have that mod -- silently, at
   * runtime, which is the failure this whole tool exists to prevent.
   */
  /**
   * Several packs define one identifier and only one of them is loaded.
   *
   * Whole-asset replacement, not a merge (02-DOMAIN.md): the shadowed files are
   * inert. Worth saying out loud because the winner looks exactly like any other
   * answer -- a reader asking what vanilla adamantite armour does gets a mod's
   * version under the vanilla name, with nothing on screen to suggest a second
   * definition ever existed.
   */
  /**
   * Two third-party packs claim one identifier, and neither is the base game.
   *
   * The engine has no per-asset priority at all -- `PackSource.overrides()`
   * settles duplicate pack REGISTRATIONS, never assets (02-DOMAIN.md). Asset
   * collisions go to whichever pack loaded last. When one side is the base game
   * that is a safe bet, because it registers first; between two packs there is
   * nothing to bet on, and calling either one the winner would dress this
   * index's arbitrary row order as a fact about the game.
   */
  contestedPacks: (logicalId: string, packs: readonly string[], shown?: string): Caveat => ({
    code: "contested-packs",
    message:
      `${packs.join(" and ")} both define '${logicalId}', and neither is the ` +
      `base game. The engine keeps whichever pack loaded last and has no ` +
      `priority rule to fall back on, so which one a running game uses cannot ` +
      `be worked out from here. Treat the two as a conflict to resolve, not as ` +
      `one winner and one loser.` +
      // Only the pinned view HAS a shown file. The disambiguation view returns
      // no document at all, and saying "the shown file" there described
      // something that was not on screen -- the same slip this caveat's sibling
      // carried, found by the same round of testing.
      (shown === undefined
        ? ""
        : ` You are looking at ${shown}'s file; whether a running game uses it ` +
          `is unknown.`),
  }),

  /** The caller asked for a definition the game does not load. */
  shadowedShown: (logicalId: string, shown: string, winner: string): Caveat => ({
    code: "shadowed-shown",
    message:
      `You are looking at ${shown}'s '${logicalId}', which the game does NOT ` +
      `load -- ${winner} defines the same identifier and wins. This file is ` +
      `inert: nothing in a running game reads it. Useful for seeing what ` +
      `${winner} replaced, not for predicting behaviour.`,
  }),
  shadowed: (logicalId: string, winner: string, losers: readonly string[]): Caveat => ({
    code: "shadowed",
    message:
      `'${logicalId}' is defined by ${losers.length + 1} packs: ${winner}, ` +
      `${losers.join(", ")}. No document was returned, because choosing one ` +
      `would be choosing for you -- a pack replaces the whole file rather than ` +
      `merging into it, and the engine keeps whichever pack loaded last, which ` +
      `this index cannot observe. ${winner} is the expected winner (packs load ` +
      `after the base game). Ask again naming the pack you want.`,
  }),
  /**
   * The answer touched the pack currently being written.
   *
   * Deliberately not the third-party caveat, which says "requires that pack to be
   * installed" -- true of someone else's mod, false of your own working copy, and
   * exactly the kind of sentence that is right in one context and misleading in
   * the next. What matters here instead is that this content is unverified: it is
   * a draft, frequently written by the same model now reading it back.
   */
  workingPack: (): Caveat => ({
    code: "working-pack",
    message:
      "This answer includes assets from the pack you are AUTHORING, marked " +
      "[working]. They are drafts: nothing has validated them, and they are not " +
      "evidence of what the game does. Treat them as what you wrote, not as " +
      "what exists.",
  }),

  thirdParty: (packs: readonly string[]): Caveat => ({
    code: "third-party",
    message:
      `This answer includes assets from ${packs.length} third-party pack(s): ` +
      `${packs.join(", ")}. They are NOT part of the game -- anything built on ` +
      `them requires that pack to be installed. Names carry no hint of this: ` +
      `most packs do not prefix their identifiers, so a plausible-looking ` +
      `name is not evidence of vanilla. Rows and values sourced from a pack ` +
      `are marked with it in square brackets; unmarked ones are the game's.`,
  }),
  /**
   * What the tool actually READ, when that is not what the caller typed.
   *
   * A JSON Pointer starts with '/', which MSYS rewrites into a Windows path, so
   * `--field /BlockType` arrives as `C:/Program Files/Git/BlockType` and an agent
   * concluded the flag was entirely broken. The CLI printed this on stderr and
   * the served value carried a bare `repairedFrom` with nothing to say what it
   * meant -- a field a blind trial listed among the markers it had to guess at.
   */
  pointerRepaired: (asTyped: string, asRead: string): Caveat => ({
    code: "pointer-repaired",
    message:
      `The pointer arrived as '${asTyped}' -- your shell rewrote it -- and was read ` +
      `as '${asRead}'. Under Git Bash, write it without the leading slash.`,
  }),
  /**
   * The one sentence that turns a dead end into a route.
   *
   * Not "no such field": the field tree crosses into another type at a `$ref`,
   * and the remainder is declared THERE. Every agent of round 22 hit this on a
   * different pointer and four of the five concluded the capability was absent
   * from the game.
   */
  crossesInto: (pointer: string, into: string, continueAt: string): Caveat => ({
    code: "crosses-into",
    message:
      `'${pointer}' is a reference, so the tree continues in '${into}' -- the rest of ` +
      `your pointer is declared there, not here. Describe '${into}' with field ` +
      `'${continueAt}'.`,
  }),
  // Each side qualifies absence from the OTHER one, and the two were crossed:
  // `status` quoted 2 457 of 2 875 observed fields -- 85% -- under a sentence
  // about absence from the observed layer, whose real ratio is 2 457 of 17 400
  // declared, 14%. The number read as high confidence while the sentence it
  // qualified was six times shakier than that.
  joinIncomplete: (joined: number, total: number, side: "observed" | "declared"): Caveat => ({
    code: "join-incomplete",
    message:
      `Only ${joined} of ${total} ${side} fields are matched by the other layer` +
      (side === "declared"
        ? ", so a field can be missing from the observed layer because the join missed it " +
          "rather than because vanilla never uses it."
        : ", so a field vanilla uses can be missing from the declared layer, and absence " +
          "there is weaker evidence than it reads as."),
  }),
  // `unsearchable` is measured, not written down. A hard-coded 497 was true of
  // one archive on one day, and this file has already had to correct several
  // numbers that were baked into a sentence.
  identifierOnly: (count: number, unsearchable: number): Caveat => ({
    code: "identifier-only",
    message:
      `Nothing matched in the search index, so these ${count} row(s) come from a ` +
      // 'worldgen under Server/World' was 496 of 497 -- one is a prefab. The
      // comment above this object warns against baking a fact into a sentence,
      // and a 99.8%-true clause is still a sentence that can be shown wrong.
      `literal identifier lookup instead. ${unsearchable} identifiers -- mostly ` +
      "world and prefab content -- are indexed as assets but carry no searchable " +
      "name, so they are reachable this way only.",
  }),
  namesNotValues: (): Caveat => ({
    code: "names-not-values",
    message:
      "This searches identifiers and localized names, not field values. To find " +
      "what uses a value, ask for references to it instead.",
  }),
};
