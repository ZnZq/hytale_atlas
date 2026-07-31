/**
 * `.lang` parsing and translation-key resolution.
 *
 * Localization is the join between what a user says and what the files are
 * called, and therefore the foundation of search: `items.Armor_Adamantite_Chest.name`
 * resolves to "Adamantite Cuirass", so a query for "cuirass" matches nothing in
 * the identifier space. See `docs/init/03-ARCHITECTURE.md` §Localization.
 *
 * Format, measured against the release corpus (121 files, five locales):
 *
 * ```
 * # === section ===
 * items.Tool_Pickaxe_Iron.name = Iron Pickaxe
 * builderTools.pastedBlocks = Pasted {count, plural,\
 *     one {1 block}\
 *     other {{count, number} blocks}}
 * ```
 *
 * Three properties that break naive parsers, all observed rather than guessed:
 *
 * 1. **Line continuation.** A trailing `\` joins with the next line. 147 lines in
 *    `en-US/server.lang` do this, in runs of up to 11. Continuation bodies contain
 *    no `=`, so a line-at-a-time parser silently drops them — and 148 lines have a
 *    pre-`=` segment that is not a key for exactly this reason.
 * 2. **ICU MessageFormat** with nested braces in values. Harmless once
 *    continuations are joined, because the value is simply everything after the
 *    first `=`.
 * 3. **A root prefix on references but not on stored keys.** Assets reference
 *    `server.items.X.name`; the key written in the file is `items.X.name`. A
 *    literal join returns zero matches across the entire corpus.
 */

/** Roots that may prefix a reference but are absent from the stored key. */
const REFERENCE_ROOTS: readonly string[] = ["server", "common"];

/**
 * Recognises a string that is a translation reference rather than prose.
 *
 * Deliberately not tied to a field name. Measured across 1 729 asset files, keys
 * arrive under at least eight different fields — `Name` (445), `Value` (244),
 * `Description` (39), `InteractionHint`, `DeathMessageKey`, `TitleKey`,
 * `SubtitleKey`, `NameTranslationKey` — so an allowlist of fields would miss most
 * of them.
 */
const REFERENCE_PATTERN = new RegExp(
  // `[.]` rather than an escaped dot: this is a template literal, where a
  // lone backslash is dropped silently. Written the usual way, the dots
  // became "any character" and `serverXitemsYname` passed as a translation
  // reference. A character class needs no escape and cannot be mangled.
  `^(?:${REFERENCE_ROOTS.join("|")})[.][A-Za-z0-9_]+(?:[.][A-Za-z0-9_]+)+$`,
);

/*
 * There was a SQL twin of this prefix rule here, `referenceKeySql`, built for the
 * LOCALIZED_BY edge join. It is gone: the join now matches a key by its OWN
 * `root` column, which is the general rule this special-cased. Stripping a fixed
 * pair of roots was wrong for the other 34 in this corpus, and the edges for all
 * of them were simply never drawn.
 */

export function isTranslationReference(value: string): boolean {
  return REFERENCE_PATTERN.test(value);
}

/**
 * Strips the root prefix from a reference to obtain the key as stored.
 *
 * Only `server.` was observed in the vanilla corpus; `common.` is accepted on the
 * assumption that `Common/Languages/…` behaves symmetrically, which is **not**
 * verified — no asset under `Server/` referenced it.
 */
export function referenceToKey(reference: string): string {
  const dot = reference.indexOf(".");
  if (dot < 0) return reference;
  const root = reference.slice(0, dot);
  return REFERENCE_ROOTS.includes(root) ? reference.slice(dot + 1) : reference;
}

/**
 * Parses one `.lang` file.
 *
 * Later definitions of the same key win, matching last-write-wins overlay
 * semantics rather than silently keeping the first.
 */
export function parseLang(text: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const logical of joinContinuations(text)) {
    const line = logical.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue; // no separator: not an entry

    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Joins backslash-continued physical lines into logical ones.
 *
 * The trailing `\` is dropped and the following line appended verbatim, including
 * its indentation — ICU MessageFormat tolerates the whitespace, and preserving it
 * keeps the value byte-faithful to what the game reads.
 */
function* joinContinuations(text: string): Generator<string> {
  let pending: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const trimmedEnd = raw.trimEnd();
    const continues = trimmedEnd.endsWith("\\");
    const body = continues ? trimmedEnd.slice(0, -1) : raw;

    pending = pending === null ? body : pending + body;

    if (!continues) {
      yield pending;
      pending = null;
    }
  }
  if (pending !== null) yield pending; // file ended on a continuation
}

/**
 * Parses `fallback.lang`, which maps regional variants onto base locales
 * (`en-GB = en-US`). It uses the same syntax as any other lang file.
 *
 * Note it references base locales the corpus does not ship — `de-DE`, `es-ES`,
 * `fr-FR` and others — so a fallback target is not guaranteed to exist.
 */
export function parseFallbacks(text: string): Map<string, string> {
  return parseLang(text);
}

export interface LangCatalogOptions {
  /** Locale used when a key is missing everywhere else. */
  readonly defaultLocale?: string;
  /** Contents of `fallback.lang`, if present. */
  readonly fallbacks?: ReadonlyMap<string, string>;
}

/**
 * Every locale's strings, with fallback resolution.
 *
 * Holds all locales rather than one: search covers every shipped language
 * regardless of the user's display setting, because someone working in Ukrainian
 * may still search an English name they saw in a tutorial.
 */
export class LangCatalog {
  readonly #byLocale = new Map<string, Map<string, string>>();
  readonly #fallbacks: ReadonlyMap<string, string>;
  readonly #defaultLocale: string;

  constructor(options: LangCatalogOptions = {}) {
    this.#fallbacks = options.fallbacks ?? new Map();
    this.#defaultLocale = options.defaultLocale ?? "en-US";
  }

  /** Merges entries into a locale. Later files override earlier ones. */
  add(locale: string, entries: ReadonlyMap<string, string>): void {
    let target = this.#byLocale.get(locale);
    if (target === undefined) {
      target = new Map();
      this.#byLocale.set(locale, target);
    }
    for (const [key, value] of entries) target.set(key, value);
  }

  get locales(): readonly string[] {
    return [...this.#byLocale.keys()].sort();
  }

  size(locale: string): number {
    return this.#byLocale.get(locale)?.size ?? 0;
  }

  /** Looks up a stored key in one locale, with no fallback. */
  getExact(key: string, locale: string): string | undefined {
    return this.#byLocale.get(locale)?.get(key);
  }

  /**
   * Resolves a **reference** (`server.items.X.name`) in one locale, following the
   * fallback chain and finally the default locale.
   *
   * Returns the value and the locale it actually came from, so a caller can tell
   * a real translation from a fallback — which matters for the missing-translation
   * check in `validate_pack`.
   */
  resolve(
    reference: string,
    locale: string,
  ): { value: string; locale: string } | undefined {
    const key = referenceToKey(reference);
    const seen = new Set<string>();

    let current: string | undefined = locale;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const value = this.getExact(key, current);
      if (value !== undefined) return { value, locale: current };
      current = this.#fallbacks.get(current);
    }

    if (!seen.has(this.#defaultLocale)) {
      const value = this.getExact(key, this.#defaultLocale);
      if (value !== undefined) return { value, locale: this.#defaultLocale };
    }
    return undefined;
  }

  /** Every locale in which a reference resolves, for indexing across languages. */
  resolveAll(reference: string): { locale: string; value: string }[] {
    const key = referenceToKey(reference);
    const out: { locale: string; value: string }[] = [];
    for (const [locale, entries] of this.#byLocale) {
      const value = entries.get(key);
      if (value !== undefined) out.push({ locale, value });
    }
    return out;
  }
}

/**
 * Derives a locale from a lang file path.
 *
 * `Server/Languages/en-US/server.lang` → `en-US`.
 * `Server/Languages/fallback.lang` → null, since it is a locale map, not a locale.
 */
export function localeFromPath(path: string): string | null {
  const match = /\/Languages\/([A-Za-z]{2}(?:-[A-Za-z0-9]+)?)\//.exec(path);
  return match?.[1] ?? null;
}
