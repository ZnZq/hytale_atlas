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
  | "identifier-only";

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
  /** Rendered form. Optional while the commands are being moved across. */
  readonly text?: string;
}

export function ok<T>(value: T, caveats: readonly Caveat[] = []): Result<T> {
  return { value, caveats };
}

/** Builds a result that carries its own rendering. */
export function rendered<T>(
  value: T,
  text: string,
  caveats: readonly Caveat[] = [],
): Result<T> {
  return { value, caveats, text };
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
  ambiguousIdentifier: (
    id: string,
    types: readonly string[],
    total = types.length,
    distinctTypes = types.length,
  ): Caveat => ({
    code: "ambiguous-identifier",
    message:
      `${total} assets are named '${id}' (${types.join(", ")}` +
      (distinctTypes > types.length ? ", and more" : "") +
      ").",
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
  joinIncomplete: (joined: number, total: number, side: "observed" | "declared"): Caveat => ({
    code: "join-incomplete",
    message:
      `Only ${joined} of ${total} ${side} fields are matched by the other layer` +
      (side === "declared"
        ? ", so a field can appear here because the join missed it rather than because " +
          "vanilla never uses it."
        : ", so absence from the observed layer is weaker evidence than it reads as."),
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
