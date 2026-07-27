import { basename, extname } from "node:path";

import type { Database } from "../db/open.ts";
import { bumpEpoch, setMeta } from "../db/open.ts";
import type { AssetArchive } from "../sources/archive.ts";
import {
  LangCatalog,
  isTranslationReference,
  localeFromPath,
  parseFallbacks,
  parseLang,
} from "../sources/lang.ts";
import { normalizeSearchText } from "../util/text.ts";

/**
 * Builds the search slice of the index: assets, localization, and FTS.
 *
 * **This is deliberately not pass 1.** It skips asset types, reference edges,
 * candidates and inheritance, because the point is to measure the project's
 * central claim — that indexing localized strings makes natural-language search
 * work — before building anything that depends on the answer
 * (`docs/init/09-EVALUATION.md` §Search). Asset type resolution needs the
 * generated schema's type table and is the next slice.
 */

export interface BuildOptions {
  /** Archive roots to walk for asset JSON. */
  readonly roots?: readonly string[];
  /** Reports progress; called every `progressEvery` assets. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly progressEvery?: number;
}

export interface BuildResult {
  readonly assets: number;
  readonly localized: number;
  readonly ftsRows: number;
  readonly langKeys: number;
  readonly locales: readonly string[];
  readonly elapsedMs: number;
}

/** A translation reference found inside an asset document. */
interface Reference {
  readonly pointer: string;
  readonly reference: string;
  /** Last pointer segment, e.g. "Name" or "Description". */
  readonly role: string;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Collects translation references from a parsed document.
 *
 * Matches on the **shape** of the string rather than an allowlist of field names:
 * measured across 1 729 asset files, keys arrive under at least eight different
 * fields, `Value` being the second most common after `Name`.
 */
export function collectReferences(node: unknown, pointer = "", out: Reference[] = []): Reference[] {
  if (typeof node === "string") {
    if (isTranslationReference(node)) {
      const segments = pointer.split("/");
      out.push({ pointer, reference: node, role: segments[segments.length - 1] ?? "" });
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectReferences(v, `${pointer}/${i}`, out));
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectReferences(v, `${pointer}/${escapePointer(k)}`, out);
    }
  }
  return out;
}

/**
 * Identity is path-derived: the basename without extension, excluding
 * organisational nesting. See `docs/init/OPEN-QUESTIONS.md` Q16.
 */
export function assetIdFromPath(path: string): string {
  return basename(path, extname(path));
}

export interface LoadedLang {
  readonly catalog: LangCatalog;
  /** Per-file parsed entries, kept so the caller can persist them without re-reading. */
  readonly files: readonly { locale: string; entries: ReadonlyMap<string, string> }[];
}

/** Reads every `.lang` file in the archive exactly once. */
export async function loadLangCatalog(archive: AssetArchive): Promise<LoadedLang> {
  const langEntries = archive.entries.filter((e) => e.path.endsWith(".lang"));

  const fallbackEntry = langEntries.find((e) => e.path.endsWith("/fallback.lang"));
  const fallbacks = fallbackEntry
    ? parseFallbacks(await archive.readText(fallbackEntry.path))
    : new Map<string, string>();

  const catalog = new LangCatalog({ fallbacks });
  const files: { locale: string; entries: ReadonlyMap<string, string> }[] = [];

  for (const entry of langEntries) {
    const locale = localeFromPath(entry.path);
    if (locale === null) continue; // fallback.lang is a locale map, not a locale
    const entries = parseLang(await archive.readText(entry.path));
    catalog.add(locale, entries);
    files.push({ locale, entries });
  }
  return { catalog, files };
}

export async function buildSearchIndex(
  archive: AssetArchive,
  db: Database,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const { roots = ["Server/"], onProgress, progressEvery = 2000 } = options;
  const started = Date.now();

  const { catalog, files: langFiles } = await loadLangCatalog(archive);

  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO packs (id, group_name, name, path, kind, priority) VALUES (1,'Hytale','Hytale',?,'vanilla',3)" +
        " ON CONFLICT (path) DO NOTHING",
    ).run(archive.path);

    let langKeys = 0;
    const insLang = db.prepare(
      "INSERT INTO lang_keys (pack_id, key, locale, value) VALUES (1,?,?,?)" +
        " ON CONFLICT (pack_id, key, locale) DO UPDATE SET value = excluded.value",
    );
    for (const { locale, entries } of langFiles) {
      for (const [key, value] of entries) {
        insLang.run(key, locale, value);
        langKeys++;
      }
    }

    const insAsset = db.prepare(
      "INSERT INTO assets (pack_id, logical_id, path, last_changed_epoch) VALUES (1,?,?,0)" +
        " ON CONFLICT (pack_id, path) DO NOTHING",
    );
    const insFts = db.prepare(
      "INSERT INTO assets_fts (logical_id, type, locale, display_name, description) VALUES (?,'',?,?,?)",
    );

    const candidates = archive.entries.filter(
      (e) => e.path.endsWith(".json") && roots.some((r) => e.path.startsWith(r)),
    );

    let assets = 0;
    let localized = 0;
    let ftsRows = 0;

    for (const entry of candidates) {
      const id = assetIdFromPath(entry.path);
      insAsset.run(id, entry.path);
      assets++;

      let doc: unknown;
      try {
        doc = JSON.parse(await archive.readText(entry.path));
      } catch {
        continue; // malformed asset: still indexed by id, just not localized
      }

      const refs = collectReferences(doc);
      if (refs.length === 0) {
        // No display name anywhere. Index the identifier alone so the asset is at
        // least reachable — this is the population validate_pack will flag.
        insFts.run(id, "", normalizeSearchText(id.replace(/_/g, " ")), "");
        ftsRows++;
        continue;
      }
      localized++;

      // Group resolved strings per locale so one row carries a locale's name and
      // description together, which is how ranking should see them.
      const perLocale = new Map<string, { name: string; description: string }>();
      for (const ref of refs) {
        const slot = ref.role.toLowerCase().includes("desc") ? "description" : "name";
        for (const { locale, value } of catalog.resolveAll(ref.reference)) {
          const bucket = perLocale.get(locale) ?? { name: "", description: "" };
          bucket[slot] = bucket[slot] ? `${bucket[slot]} ${value}` : value;
          perLocale.set(locale, bucket);
        }
      }

      for (const [locale, { name, description }] of perLocale) {
        insFts.run(
          id,
          locale,
          normalizeSearchText(`${id.replace(/_/g, " ")} ${name}`),
          normalizeSearchText(description),
        );
        ftsRows++;
      }

      if (onProgress && assets % progressEvery === 0) onProgress(assets, candidates.length);
    }

    setMeta(db, "source_archive", archive.path);
    setMeta(db, "locales", catalog.locales.join(","));
    bumpEpoch(db);
    db.exec("COMMIT");

    return {
      assets,
      localized,
      ftsRows,
      langKeys,
      locales: catalog.locales,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
