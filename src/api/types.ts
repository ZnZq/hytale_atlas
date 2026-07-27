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
  | "names-not-values";

/** Every operation returns its answer alongside what qualifies it. */
export interface Result<T> {
  readonly value: T;
  readonly caveats: readonly Caveat[];
}

export function ok<T>(value: T, caveats: readonly Caveat[] = []): Result<T> {
  return { value, caveats };
}

/** Builds a caveat, keeping the wording in one place per code. */
export const caveat = {
  truncated: (shown: number, what: string): Caveat => ({
    code: "truncated",
    message: `Showing the first ${shown} ${what}; more exist.`,
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
  ambiguousIdentifier: (id: string, types: readonly string[]): Caveat => ({
    code: "ambiguous-identifier",
    message: `${types.length} assets are named '${id}' (${types.join(", ")}).`,
  }),
  joinIncomplete: (joined: number, observed: number): Caveat => ({
    code: "join-incomplete",
    message:
      `Only ${joined} of ${observed} observed fields match a declared one, so ` +
      "absence from this list is weaker evidence than it reads as.",
  }),
  namesNotValues: (): Caveat => ({
    code: "names-not-values",
    message:
      "This searches identifiers and localized names, not field values. To find " +
      "what uses a value, ask for references to it instead.",
  }),
};
