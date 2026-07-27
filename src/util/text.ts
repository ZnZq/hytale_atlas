/**
 * Search-text normalisation.
 *
 * **Must be applied symmetrically** — to text before it is indexed, and to query
 * terms before they are matched. Applying it to only one side silently breaks
 * search for the affected languages, which is exactly the bug an asymmetric first
 * attempt produced during development.
 *
 * SQLite's `unicode61` tokenizer handles Latin and Cyrillic well, including case
 * folding. Two gaps were measured against the five locales the corpus ships, and
 * neither is fixable by choosing a different built-in tokenizer:
 *
 * 1. **CJK has no word boundaries.** `unicode61` treats a run of ideographs as a
 *    single token, so `洞穴蜘蛛` ("Cave Spider") is one token. Prefix indexing
 *    rescues *leading* substrings (`洞穴*`) but not trailing ones — and the
 *    meaningful noun in a Chinese compound is usually at the **end**. A user
 *    searching `蜘蛛` ("spider") found nothing.
 * 2. **Ukrainian Ґ does not fold to Г.** They are distinct Cyrillic letters, not
 *    diacritic variants, so `remove_diacritics 2` leaves them apart. Ukrainians
 *    routinely type `г` for `ґ`, and `гоблінський` missed `Ґоблінський трон`.
 *
 * `trigram` was evaluated as an alternative and is worse: it matches nothing at
 * all for two-character CJK words, because a trigram needs three characters.
 */

/**
 * CJK ideographs, including Extension A and the compatibility block. Deliberately
 * excludes kana and Hangul, which do have word-ish boundaries `unicode61` copes
 * with.
 */
const CJK_IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿]/u;

const UKRAINIAN_GHE_UPPER = "Ґ"; // Ґ
const UKRAINIAN_GHE_LOWER = "ґ"; // ґ

/**
 * Prepares text for the FTS index and for query matching.
 *
 * Segmenting each ideograph into its own token is what makes infix search work:
 * `洞穴蜘蛛` becomes `洞 穴 蜘 蛛`, so the phrase query `"蜘 蛛"` matches in the
 * middle of the compound where a prefix query never could.
 */
export function normalizeSearchText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (CJK_IDEOGRAPH.test(ch)) {
      out += ` ${ch} `;
    } else if (ch === UKRAINIAN_GHE_UPPER) {
      out += "Г"; // Г
    } else if (ch === UKRAINIAN_GHE_LOWER) {
      out += "г"; // г
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** True when the text contains at least one ideograph. */
export function containsIdeograph(text: string): boolean {
  return CJK_IDEOGRAPH.test(text);
}

/** Escapes a term for use inside an FTS5 double-quoted string. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export interface MatchOptions {
  /**
   * Append the FTS5 prefix operator to each term.
   *
   * Note what this does and does not buy. FTS5 prefix matching requires the
   * **query** to be a prefix of the **indexed** term, so it helps a user who types
   * a stem (`кірас*` finds `кіраса`) and does nothing for one who types a full
   * inflected form (`кірасу*` misses `кіраса` — they diverge at the last letter).
   *
   * An earlier revision of this file claimed prefix matching "substitutes for the
   * stemmer Cyrillic does not have". It does not, and a test written against the
   * realistic case caught it. See {@link relaxTerm}.
   */
  readonly prefix?: boolean;

  /**
   * Characters to trim from the end of long terms before prefix matching.
   *
   * Crude suffix stripping, which is what makes full inflected forms reachable:
   * Slavic inflection is overwhelmingly suffixal, so `кірасу` → `кірас*` finds
   * `кіраса`. Applied only to terms long enough to survive it — trimming a short
   * word matches far too much.
   */
  readonly trimSuffix?: number;
}

/** Below this length a term is never trimmed; the result would be too broad. */
const MIN_STEM_LENGTH = 5;

/** Ideographs are single-character tokens already and must never be trimmed. */
function isTrimmable(term: string): boolean {
  return term.length >= MIN_STEM_LENGTH && !CJK_IDEOGRAPH.test(term);
}

/**
 * Trims up to `by` characters from a term, refusing to go below the minimum stem
 * length. Returns the term unchanged when trimming is not safe.
 */
export function relaxTerm(term: string, by: number): string {
  if (by <= 0 || !isTrimmable(term)) return term;
  const keep = Math.max(MIN_STEM_LENGTH - 1, term.length - by);
  return term.slice(0, keep);
}

/**
 * Builds an FTS5 `MATCH` expression from free user text.
 *
 * Terms are ANDed. Each is normalised, quoted, and optionally given the prefix
 * operator. Quoting is what keeps FTS5 operators the user happened to type
 * (`AND`, `NOT`, `*`, `^`) from being interpreted as syntax.
 *
 * Returns null when the query has no usable terms, so callers can distinguish
 * "no results" from "nothing was asked".
 */
export function buildMatchExpression(
  query: string,
  options: MatchOptions = {},
): string | null {
  const { prefix = true, trimSuffix = 0 } = options;

  const terms = normalizeSearchText(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;

  // A segmented ideograph run must stay one phrase: "蜘 蛛" is a two-token phrase
  // meaning 蜘蛛, whereas ANDing the tokens would match any name containing both
  // characters anywhere. Group consecutive single-ideograph terms back together.
  const grouped: string[] = [];
  let run: string[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      grouped.push(quote(run.join(" ")));
      run = [];
    }
  };
  for (const term of terms) {
    if (term.length === 1 && CJK_IDEOGRAPH.test(term)) {
      run.push(term);
    } else {
      flushRun();
      // Prefix operators are meaningless on ideographs, which are already
      // single-character tokens after segmentation.
      grouped.push(quote(relaxTerm(term, trimSuffix)) + (prefix ? "*" : ""));
    }
  }
  flushRun();

  return grouped.join(" AND ");
}

/**
 * Match expressions to try in order, strictest first.
 *
 * The search layer should run these until one returns results. Progressive
 * relaxation rather than one loose query keeps precision for the common case: an
 * exact-stem query is not diluted by matches that only a two-character trim could
 * reach.
 *
 * Three levels are enough for the Slavic inflection observed in the corpus — one
 * character covers most case endings (`кірасу` → `кірас`), two or three reach
 * adjectival agreement (`адамантитової` → `адамантито`).
 */
export function buildRelaxedMatchExpressions(
  query: string,
  options: Omit<MatchOptions, "trimSuffix"> = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const trimSuffix of [0, 1, 2, 3]) {
    const expr = buildMatchExpression(query, { ...options, trimSuffix });
    if (expr !== null && !seen.has(expr)) {
      seen.add(expr);
      out.push(expr);
    }
  }
  return out;
}
