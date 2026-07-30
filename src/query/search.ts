import type { Database } from "../db/open.ts";
import { buildRelaxedMatchExpressions } from "../util/text.ts";

/**
 * Asset search.
 *
 * Every behaviour here was added because a measurement failed, and the reason is
 * recorded with it. See `docs/init/09-EVALUATION.md` §Search and
 * `docs/evaluation/`.
 */

export interface SearchHit {
  readonly logicalId: string;
  readonly type: string;
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
  /** Restrict to one asset type, e.g. "Item". */
  readonly type?: string;
  /** Interleave identifier families so one does not crowd out the rest. On by default. */
  readonly diversify?: boolean;
}

/**
 * Identifier prefixes that mark scaffolding rather than shippable content.
 *
 * 244 such assets exist: 180 `Prototype_`, 28 `Debug_`, 17 `Template_`, 13
 * `Filter_`, 6 `Test_`. They are legitimate assets and stay searchable, but they
 * must not outrank real content — `Template_Weapon_Sword` ("Template Sword")
 * topped a search for "sword" until this existed.
 *
 * Note the asset **type** does not help here: a template item is an `Item` like
 * any other. This is a naming convention, and treating it as one is the honest
 * description.
 */
const SCAFFOLDING_PREFIXES = ["Prototype_", "Debug_", "Template_", "Filter_", "Test_"];

function isScaffolding(logicalId: string): boolean {
  return SCAFFOLDING_PREFIXES.some((p) => logicalId.startsWith(p));
}

/**
 * The family an identifier belongs to, by convention: `Armor_Bronze_Chest` →
 * `Armor`.
 *
 * A heuristic, not a declared taxonomy — but a well-founded one, because vanilla
 * identifiers are systematically prefixed by family (`Armor_`, `Weapon_`, `Tool_`,
 * `Furniture_`, `Deco_`, `Food_`, `Bench_`).
 */
function family(logicalId: string): string {
  const underscore = logicalId.indexOf("_");
  return underscore > 0 ? logicalId.slice(0, underscore) : logicalId;
}

interface Row {
  logical_id: string;
  type: string;
  locale: string;
  display_name: string;
}

export function searchAssets(
  db: Database,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const { limit = 20, relax = true, type, diversify = true } = options;

  const all = buildRelaxedMatchExpressions(query);
  const expressions = relax ? all : all.slice(0, 1);

  // Localized rows before identifier-only ones.
  //
  // 32 704 assets are indexed but only 4 574 are localized, and two thirds of the
  // remainder is worldgen under Server/World and Server/Prefabs. Without this,
  // "sword" returned Server/Item/Animations/Sword.json above every weapon: an
  // animation's identifier is a cleaner lexical match than a localized item's is.
  // The pack being authored lives in its own FTS table. It cannot be folded into
  // a union VIEW the way `assets` is, because `MATCH` does not run against views
  // -- so this is the single place the overlay has to be visible in a query.
  const hasWorking =
    db
      .prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'working_fts'")
      .get() !== undefined;

  const typeFilter = type === undefined ? "" : " AND type = ?2";
  const one = (table: string, working: 0 | 1): string =>
    `SELECT logical_id, type, locale, display_name, rank, ${working} AS working
       FROM ${table} WHERE ${table} MATCH ?1${typeFilter}`;
  // Numbered parameters, so the expression binds once for both halves.
  const sql =
    `SELECT logical_id, type, locale, display_name FROM (` +
    // Unqualified: FTS5 rejects a schema-qualified name on the left of MATCH,
    // and an unqualified temp table resolves to temp anyway.
    (hasWorking
      ? `${one("assets_fts", 0)} UNION ALL ${one("working_fts", 1)}`
      : one("assets_fts", 0)) +
    // Working rows FIRST. The `locale = ''` demotion below exists to push
    // identifier-only matches under localized ones, and every working row is
    // identifier-only by construction -- so without this the pack you are
    // writing is the one thing the search can never surface.
    `) ORDER BY working DESC, (locale = '') ASC, rank LIMIT ?${type === undefined ? 2 : 3}`;
  const statement = db.prepare(sql);

  // Over-fetch so demotion and diversification have material to work with.
  const fetch = Math.max(limit * 10, 100);

  // Accumulate across relaxation levels rather than returning the first level that
  // matched anything. Stopping early conflates "found something" with "found the
  // right thing": the Ukrainian `адамантитової` matched the Russian
  // `Адамантитовое копьё` at level 1 and stopped, never reaching level 2 where the
  // Ukrainian `Адамантитова кіраса` lives.
  const candidates: SearchHit[] = [];
  const seen = new Set<string>();

  for (const [level, expression] of expressions.entries()) {
    if (candidates.length >= fetch) break;

    const rows = (
      type === undefined
        ? statement.all(expression, fetch)
        : statement.all(expression, type, fetch)
    ) as unknown as Row[];

    for (const row of rows) {
      // Keyed on identifier AND type. Deduplicating on the identifier alone
      // silently discarded every same-named asset of a different type: searching
      // `Pickaxe_Mine` returned one row while four assets carry that name
      // (CameraEffect, CameraShake, Interaction, RootInteraction), and the
      // Interaction -- the one holding the mining logic -- was invisible. Not a
      // limit truncation, which at least prints a total: a silent choice.
      //
      // Relaxation levels still dedupe correctly, because a repeat at a looser
      // level carries the same identifier and the same type.
      const key = `${row.logical_id} :: ${row.type}`;
      if (seen.has(key)) continue; // keep the strictest match
      seen.add(key);
      candidates.push({
        logicalId: row.logical_id,
        type: row.type,
        locale: row.locale,
        displayName: row.display_name,
        relaxation: level,
      });
    }
  }

  // Scaffolding sinks below real content, order otherwise preserved.
  const ranked = [
    ...candidates.filter((h) => !isScaffolding(h.logicalId)),
    ...candidates.filter((h) => isScaffolding(h.logicalId)),
  ];

  return (diversify ? interleaveFamilies(ranked) : ranked).slice(0, limit);
}

/**
 * Longest run of one identifier family before the rest get a turn.
 *
 * Three is enough to show a query is about that family and short enough that a
 * second sense is visible within the first screen.
 */
const MAX_FAMILY_RUN = 3;

/**
 * Breaks up long runs of one identifier family, keeping rank order otherwise.
 *
 * An ambiguous query should surface both senses rather than twenty variants of
 * one. A search for "chest" returned twenty-odd `Armor_*_Chest` cuirasses and no
 * storage chest at all, because relevance alone has no reason to prefer variety —
 * and both senses are the same asset **type**, so type filtering cannot separate
 * them either.
 *
 * **This used to round-robin**, one hit per family per pass, and that inverted
 * the failure: a query naming a family got at most one of its members per cycle,
 * so `pickaxe` -- where every relevant asset is a `Tool_` -- pushed
 * `Tool_Pickaxe_Iron` from rank 9 to rank 53 and off a 30-row page entirely,
 * while `Ingredient_Bar_Adamantite` sat second. Two agents reported the same
 * shape on different queries.
 *
 * Capping the RUN keeps both properties: the strongest matches stay at the top
 * in rank order, and no family can monopolise the page. A deferred hit keeps its
 * relative order, so nothing is lost -- only postponed.
 */
function interleaveFamilies(hits: readonly SearchHit[]): SearchHit[] {
  // Rank order is kept; only a run that has gone on too long is interrupted, by
  // pulling forward the nearest hit of another family. Nothing is demoted more
  // than the length of that run.
  //
  // Two stronger reorderings were tried and both broke the case they were not
  // aimed at. One-per-family round-robin buried `Tool_Pickaxe_Iron` at rank 53,
  // because a family places its Nth member only on its Nth cycle. Batches of
  // three fixed that ordering in principle but not in practice: with sixteen
  // families competing, a family's second turn arrives forty-odd rows later.
  // Rank is the signal worth preserving -- variety is a garnish on it, not a
  // replacement for it.
  const remaining = [...hits];
  const out: SearchHit[] = [];
  let current: string | null = null;
  let run = 0;

  while (remaining.length > 0) {
    let index = 0;
    if (current !== null && run >= MAX_FAMILY_RUN) {
      const other = remaining.findIndex((h) => family(h.logicalId) !== current);
      if (other >= 0) index = other;
    }
    const [hit] = remaining.splice(index, 1);
    const key = family(hit!.logicalId);
    run = key === current ? run + 1 : 1;
    current = key;
    out.push(hit!);
  }
  return out;
}
