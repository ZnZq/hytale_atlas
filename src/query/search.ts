import type { Database } from "../db/open.ts";
import { buildRelaxedMatchExpressions } from "../util/text.ts";

/**
 * Asset search.
 *
 * Three behaviours here are load-bearing and were each added because a
 * measurement failed. See `docs/init/09-EVALUATION.md` §Search.
 */

export interface SearchHit {
  readonly logicalId: string;
  /** Locale whose text matched, or "" when only the identifier did. */
  readonly locale: string;
  readonly displayName: string;
  /** How much the query had to be loosened: 0 means it matched as typed. */
  readonly relaxation: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Try progressively looser queries. On by default. */
  readonly relax?: boolean;
}

/**
 * Localized rows before identifier-only rows, then by relevance.
 *
 * 32 704 assets are indexed but only 4 574 are localized — two thirds of the
 * remainder is worldgen under `Server/World` and `Server/Prefabs`. Without this
 * ordering, a search for "sword" returns `Server/Item/Animations/Sword.json`
 * above every weapon, because an animation's identifier is a cleaner lexical
 * match than a localized item's is. A localized asset is something a player can
 * see and name; an unlocalized one is usually internal plumbing.
 *
 * Unlocalized assets are still returned — someone may genuinely be looking for a
 * prefab — they simply lose ties.
 */
const ORDER_BY = "ORDER BY (locale = '') ASC, rank";

export function searchAssets(
  db: Database,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const { limit = 20, relax = true } = options;

  const all = buildRelaxedMatchExpressions(query);
  const expressions = relax ? all : all.slice(0, 1);

  const statement = db.prepare(
    `SELECT logical_id, locale, display_name
       FROM assets_fts
      WHERE assets_fts MATCH ?
      ${ORDER_BY}
      LIMIT ?`,
  );

  // Accumulate across relaxation levels rather than returning the first level
  // that matched anything.
  //
  // Stopping at the first non-empty level conflates "found something" with "found
  // the right thing": the Ukrainian query `адамантитової` matched the Russian
  // `Адамантитовое копьё` at level 1 and stopped, never reaching level 2 where the
  // Ukrainian `Адамантитова кіраса` lives. Strict results still rank first,
  // because levels are visited in order and the first occurrence of an asset wins.
  const seen = new Map<string, SearchHit>();

  for (const [level, expression] of expressions.entries()) {
    if (seen.size >= limit) break;

    const rows = statement.all(expression, limit * 5) as {
      logical_id: string;
      locale: string;
      display_name: string;
    }[];

    for (const row of rows) {
      if (seen.has(row.logical_id)) continue; // keep the strictest match
      seen.set(row.logical_id, {
        logicalId: row.logical_id,
        locale: row.locale,
        displayName: row.display_name,
        relaxation: level,
      });
      if (seen.size >= limit) break;
    }
  }

  return [...seen.values()];
}
