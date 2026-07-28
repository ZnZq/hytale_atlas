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
import { collectCandidates } from "./references.ts";

/**
 * Builds the frozen index: assets, files, localization, FTS and pass-2 candidates.
 *
 * Passes 1 and 2 share one walk over the archive. Pass 1 collects the symbol
 * table (assets, files, lang keys); pass 2 records every string scalar as a
 * candidate. Resolution is deliberately left to `resolveCandidates()` afterwards,
 * because a candidate can only be matched once the symbol table is complete, and
 * a second walk over 3.4 GB to achieve that would cost more than the indexed join
 * it replaces (`docs/init/03-ARCHITECTURE.md` Indexing: three passes).
 */

export interface BuildOptions {
  /** Archive roots to walk for asset JSON. */
  readonly roots?: readonly string[];
  /**
   * Assigns an asset type to each path.
   *
   * Supplied by schema ingestion, which must therefore run first. Without it every
   * asset is untyped, and search cannot tell an item from a worldgen prefab or an
   * animation -- the defect the first evaluation run measured.
   */
  readonly types?: { resolve(path: string): string | null };
  /**
   * Roots indexed as assets but excluded from pass-2 candidate extraction.
   *
   * Measured on the release corpus: `Server/Prefabs/` alone produced **20.6 of
   * 21.2 million candidates** from 7 812 files -- about 2 600 strings each -- and
   * `Server/World/` a further 365 thousand. They are voxel data, not authored
   * references: the top values are `Empty` (5.9M), `Rock_Stone` (2.2M) and
   * `Rock_Slate` (1.4M), one per block placed.
   *
   * Combined with 2 564 colliding `logical_id`s (461 files are named
   * `Entry.node`), the cross product produced 60.8 million edges of which 60.7
   * million were low-confidence, and a 7.5 GB database -- larger than the 3.4 GB
   * archive it indexes.
   *
   * These roots stay searchable and typed; they simply contribute no edges.
   */
  readonly skipCandidatesIn?: readonly string[];
  /**
   * Filename suffixes that hold an asset document.
   *
   * Defaults to `.json` alone, which is wrong for any real corpus -- see
   * `assetSuffixes()` in `./schema.ts`. Callers with a schema should pass its
   * declared extensions.
   */
  readonly assetSuffixes?: readonly string[];
  /** Reports progress; called every `progressEvery` assets. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly progressEvery?: number;
}

/** Voxel-data roots: indexed as assets, excluded from the reference graph. */
export const DEFAULT_CANDIDATE_EXCLUSIONS: readonly string[] = [
  "Server/Prefabs/",
  "Server/World/",
];

export interface BuildResult {
  readonly assets: number;
  readonly typed: number;
  readonly localized: number;
  readonly ftsRows: number;
  readonly langKeys: number;
  readonly files: number;
  readonly candidates: number;
  readonly locales: readonly string[];
  readonly elapsedMs: number;
}

/** Classifies a non-JSON archive entry, for the `files` table. */
function fileKind(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png": case "jpg": case "jpeg": case "tga": return "texture";
    case "blockymodel": case "bbmodel": return "model";
    case "ogg": case "wav": case "mp3": return "audio";
    case "ui": return "ui";
    default: return "other";
  }
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
export function collectReferences(
  node: unknown,
  pointer = "",
  out: Reference[] = [],
  /**
   * Whether a string is a translation reference.
   *
   * Defaults to the shape test, but the indexer passes one that also accepts a
   * value the catalog actually holds a key for. Two rules described the same
   * thing and disagreed: `LOCALIZED_BY` joins any value with two dots after
   * stripping a `server.`/`common.` root, while this test demanded the root be
   * present. Nine assets -- the `npcRoles.Test_Motion_*` roles, whose keys carry
   * no root -- got a localization edge and an identifier-only search row, so the
   * index knew their names and search could not find them by one.
   */
  isReference: (value: string) => boolean = isTranslationReference,
): Reference[] {
  if (typeof node === "string") {
    if (isReference(node)) {
      const segments = pointer.split("/");
      out.push({ pointer, reference: node, role: segments[segments.length - 1] ?? "" });
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectReferences(v, `${pointer}/${i}`, out, isReference));
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectReferences(v, `${pointer}/${escapePointer(k)}`, out, isReference);
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
  readonly files: readonly {
    locale: string;
    /** The file's stem, which is the root an asset prefixes when referencing. */
    root: string;
    entries: ReadonlyMap<string, string>;
  }[];
}

/** Reads every `.lang` file in the archive exactly once. */
export async function loadLangCatalog(archive: AssetArchive): Promise<LoadedLang> {
  const langEntries = archive.entries.filter((e) => e.path.endsWith(".lang"));

  const fallbackEntry = langEntries.find((e) => e.path.endsWith("/fallback.lang"));
  const fallbacks = fallbackEntry
    ? parseFallbacks(await archive.readText(fallbackEntry.path))
    : new Map<string, string>();

  const catalog = new LangCatalog({ fallbacks });
  const files: { locale: string; root: string; entries: ReadonlyMap<string, string> }[] = [];

  for (const entry of langEntries) {
    const locale = localeFromPath(entry.path);
    if (locale === null) continue; // fallback.lang is a locale map, not a locale
    const entries = parseLang(await archive.readText(entry.path));
    catalog.add(locale, entries);
    files.push({ locale, root: basename(entry.path, extname(entry.path)), entries });
  }
  return { catalog, files };
}

export async function buildSearchIndex(
  archive: AssetArchive,
  db: Database,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const {
    roots = ["Server/"],
    types,
    skipCandidatesIn = DEFAULT_CANDIDATE_EXCLUSIONS,
    assetSuffixes = [".json"],
    onProgress,
    progressEvery = 2000,
  } = options;
  const started = Date.now();

  const { catalog, files: langFiles } = await loadLangCatalog(archive);

  /**
   * The same question `LOCALIZED_BY` asks, so the two cannot disagree: either the
   * value carries a known root, or the catalog holds a key by that name. The
   * two-dot floor matches the SQL join and keeps ordinary prose out.
   */
  const isReference = (value: string): boolean =>
    isTranslationReference(value) ||
    (value.split(".").length > 2 && catalog.resolveAll(value).length > 0);

  db.exec("BEGIN");
  try {
    // Rebuilt, not appended to. `assets` and `files` carry ON CONFLICT guards and
    // `schema_fts` is cleared by schema ingestion, but `candidates` and
    // `assets_fts` had neither, so a second run over one database silently
    // doubled both. Nothing does that today -- `index --force` deletes the file
    // first -- which is exactly why the hazard was invisible.
    db.exec("DELETE FROM candidates");
    db.exec("DELETE FROM assets_fts");

    db.prepare(
      "INSERT INTO packs (id, group_name, name, path, kind, priority) VALUES (1,'Hytale','Hytale',?,'vanilla',3)" +
        " ON CONFLICT (path) DO NOTHING",
    ).run(archive.path);

    let langKeys = 0;
    const insLang = db.prepare(
      "INSERT INTO lang_keys (pack_id, key, locale, value, root) VALUES (1,?,?,?,?)" +
        " ON CONFLICT (pack_id, key, locale) DO UPDATE SET value = excluded.value",
    );
    for (const { locale, root, entries } of langFiles) {
      for (const [key, value] of entries) {
        insLang.run(key, locale, value, root);
        langKeys++;
      }
    }

    // Non-JSON entries become File nodes, so that a reference to
    // "Icons/ItemsGenerated/X.png" can be told from a dangling one.
    const insFile = db.prepare(
      "INSERT INTO files (pack_id, path, kind) VALUES (1,?,?)" +
        " ON CONFLICT (pack_id, path) DO NOTHING",
    );
    let files = 0;
    for (const entry of archive.entries) {
      if (entry.path.endsWith(".lang")) continue;
      if (assetSuffixes.some((s) => entry.path.endsWith(s))) continue;
      insFile.run(entry.path, fileKind(entry.path));
      files++;
    }

    const insAsset = db.prepare(
      "INSERT INTO assets (pack_id, logical_id, type, path, last_changed_epoch) VALUES (1,?,?,?,0)" +
        " ON CONFLICT (pack_id, path) DO NOTHING",
    );
    const insCandidate = db.prepare(
      "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind)" +
        " VALUES (?,?,?,?,?)",
    );
    const assetIdOf = db.prepare("SELECT id FROM assets WHERE pack_id = 1 AND path = ?");
    const insFts = db.prepare(
      "INSERT INTO assets_fts (logical_id, type, locale, display_name, description) VALUES (?,?,?,?,?)",
    );

    const assetEntries = archive.entries.filter(
      (e) =>
        assetSuffixes.some((s) => e.path.endsWith(s)) &&
        roots.some((r) => e.path.startsWith(r)),
    );

    let assets = 0;
    let typed = 0;
    let localized = 0;
    let ftsRows = 0;
    let candidates = 0;

    for (const entry of assetEntries) {
      const id = assetIdFromPath(entry.path);
      const assetType = types?.resolve(entry.path) ?? null;
      if (assetType !== null) typed++;
      insAsset.run(id, assetType, entry.path);
      assets++;

      let doc: unknown;
      try {
        doc = JSON.parse(await archive.readText(entry.path));
      } catch {
        continue; // malformed asset: still indexed by id, just not localized
      }

      // Pass 2: every string scalar becomes a candidate, resolved later by an
      // indexed join rather than by a second walk over the archive.
      //
      // Voxel roots are skipped -- see skipCandidatesIn. They stay searchable and
      // typed; they contribute no edges.
      if (!skipCandidatesIn.some((prefix) => entry.path.startsWith(prefix))) {
        const row = assetIdOf.get(entry.path) as { id: number } | undefined;
        if (row !== undefined) {
          for (const candidate of collectCandidates(doc)) {
            insCandidate.run(
              row.id,
              candidate.pointer,
              candidate.schemaPointer,
              candidate.value,
              candidate.kind,
            );
            candidates++;
          }
        }
      }

      const refs = collectReferences(doc, "", [], isReference);
      if (refs.length === 0) {
        // No display name anywhere. Index the identifier alone so the asset is at
        // least reachable -- this is the population validate_pack will flag.
        insFts.run(id, assetType ?? "", "", normalizeSearchText(id.replace(/_/g, " ")), "");
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
        // The TRANSLATION alone. The identifier used to be folded in here so a
        // query could match either -- but `logical_id` is an indexed FTS column
        // in its own right and `unicode61` splits it on underscores, so the fold
        // bought nothing for search and cost the display: this column is printed
        // verbatim under a heading that says `name`, and it read as
        // `Burn You burned to death!` (identifier + the DeathMessageKey
        // translation) and `Weapon Sword Adamantite Adamantite Sword`. One
        // column cannot be both the search text and the label; the search half
        // was already covered elsewhere.
        insFts.run(id, assetType ?? "", locale, normalizeSearchText(name), normalizeSearchText(description));
        ftsRows++;
      }

      if (onProgress && assets % progressEvery === 0) onProgress(assets, assetEntries.length);
    }

    setMeta(db, "source_archive", archive.path);
    setMeta(db, "locales", catalog.locales.join(","));
    bumpEpoch(db);
    db.exec("COMMIT");

    return {
      assets,
      typed,
      localized,
      ftsRows,
      langKeys,
      files,
      candidates,
      locales: catalog.locales,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
