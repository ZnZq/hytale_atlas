import type { Database } from "../db/open.ts";
import { buildRelaxedMatchExpressions } from "../util/text.ts";

/**
 * Asset search.
 *
 * Two behaviours here are not incidental and should not be "simplified" away:
 *
 * 1. **Progressive relaxation.** Queries are tried strictest-first and only
 *    loosened when nothing matched. SQLite has no stemmer for Cyrillic, and
 *    Ukrainian and Russian decline heavily, so a user typing `кірасу` needs the
 *    suffix trimmed before `кіраса` is reachable. Running the loosest query
 *    directly would cost precision on every well-formed query to help the
 *    malformed ones.
 * 2. **Grouping by asset.** One asset has a row per locale, so an unguarded query
 *    returns it once per language it matched in.
 */

export interface SearchHit {
  readonly logicalId: string;
  /** Locale whose text matched, e.g. "uk-UA". */
  readonly locale: string;
  readonly displayName: string;
  /** How much the query had to be loosened: 0 means it matched as typed. */
  readonly relaxation: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Stop at the strictest expression that matches. On by default. */
  readonly relax?: boolean;
}

export function searchAssets(
  db: Database,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const { limit = 20, relax = true } = options;

  const expressions = relax
    ? buildRelaxedMatchExpressions(query)
    : buildRelaxedMatchExpressions(query).slice(0, 1);

  const statement = db.prepare(
    `SELECT logical_id, locale, display_name
       FROM assets_fts
      WHERE assets_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
  );

  for (const [level, expression] of expressions.entries()) {
    const rows = statement.all(expression, limit * 5) as {
      logical_id: string;
      locale: string;
      display_name: string;
    }[];
    if (rows.length === 0) continue;

    // Collapse per-locale rows, keeping the best-ranked locale for each asset.
    const seen = new Map<string, SearchHit>();
    for (const row of rows) {
      if (seen.has(row.logical_id)) continue;
      seen.set(row.logical_id, {
        logicalId: row.logical_id,
        locale: row.locale,
        displayName: row.display_name,
        relaxation: level,
      });
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  }
  return [];
}
