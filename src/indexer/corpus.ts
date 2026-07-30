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
import { escapeSegment, parseJsonLenient } from "../util/json.ts";
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
  /**
   * Assets whose JSON could not be parsed even leniently.
   *
   * They are still indexed by identifier -- so `search` finds them -- but they
   * contribute no candidates, no edges and no localization. That used to be
   * swallowed by a bare `continue`, so neither the build nor `status` could say
   * how many assets were silently inert, and a reader hitting one had no way to
   * tell a corpus-wide problem from a single bad file.
   */
  readonly parseFailures: number;
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
      collectReferences(v, `${pointer}/${escapeSegment(k)}`, out, isReference);
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
    /** The archive path, which is the file a modder actually edits. */
    path: string;
    /** Index into the archives array this came from, so rows carry a pack. */
    archiveIndex: number;
    entries: ReadonlyMap<string, string>;
  }[];
}

/** Reads every `.lang` file in the archive exactly once. */
export async function loadLangCatalog(
  archives: readonly AssetArchive[],
): Promise<LoadedLang> {
  // Merged across every pack, later packs last so their strings win. A mod that
  // renames a vanilla item does it here, and reading only the first archive
  // would leave the index showing the old name beside the mod's new asset.
  const langEntries = archives.flatMap((a) =>
    a.entries.filter((e) => e.path.endsWith(".lang")).map((e) => ({ e, a })),
  );

  const fallbackEntry = langEntries.find((x) => x.e.path.endsWith("/fallback.lang"));
  const fallbacks = fallbackEntry
    ? parseFallbacks(await fallbackEntry.a.readText(fallbackEntry.e.path))
    : new Map<string, string>();

  const catalog = new LangCatalog({ fallbacks });
  const files: {
    locale: string;
    root: string;
    path: string;
    archiveIndex: number;
    entries: ReadonlyMap<string, string>;
  }[] = [];

  for (const { e: entry, a: from } of langEntries) {
    const locale = localeFromPath(entry.path);
    if (locale === null) continue; // fallback.lang is a locale map, not a locale
    const entries = parseLang(await from.readText(entry.path));
    catalog.add(locale, entries);
    files.push({
      locale,
      root: basename(entry.path, extname(entry.path)),
      path: entry.path,
      archiveIndex: archives.indexOf(from),
      entries,
    });
  }
  return { catalog, files };
}

/** One archive and the `packs` row it belongs to. */
export interface PackSource {
  readonly archive: AssetArchive;
  readonly packId: number;
}

/**
 * Walks every pack into one index.
 *
 * Vanilla is just the first pack. That was always the schema's intent -- `packs`
 * carries a priority and `assets` an `is_effective` flag -- but the walk hardcoded
 * `pack_id = 1`, so the design existed and the code could not use it.
 */
export async function buildSearchIndex(
  sources: readonly PackSource[],
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

  const archives = sources.map((s) => s.archive);
  const { catalog, files: langFiles } = await loadLangCatalog(archives);

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

    let langKeys = 0;
    const insLang = db.prepare(
      "INSERT INTO lang_keys (pack_id, key, locale, value, root, source_path) " +
        "VALUES (?,?,?,?,?,?)" +
        " ON CONFLICT (pack_id, key, locale) DO UPDATE SET value = excluded.value, " +
        "source_path = excluded.source_path",
    );
    for (const { locale, root, path, entries, archiveIndex } of langFiles) {
      const packId = sources[archiveIndex]?.packId ?? sources[0]!.packId;
      for (const [key, value] of entries) {
        insLang.run(packId, key, locale, value, root, path);
        langKeys++;
      }
    }

    // Non-JSON entries become File nodes, so that a reference to
    // "Icons/ItemsGenerated/X.png" can be told from a dangling one.
    let files = 0;
    let assets = 0;
    let typed = 0;
    let localized = 0;
    let ftsRows = 0;
    let candidates = 0;
    let parseFailures = 0;

    // One pass per pack, in priority order. Everything above this line is
    // global -- the merged language catalogue, the shared statement cache --
    // and everything inside belongs to exactly one archive.
    for (const { archive, packId } of sources) {
      const insFile = db.prepare(
        "INSERT INTO files (pack_id, path, kind) VALUES (?,?,?)" +
          " ON CONFLICT (pack_id, path) DO NOTHING",
      );
      for (const entry of archive.entries) {
        if (entry.path.endsWith(".lang")) continue;
        if (assetSuffixes.some((s) => entry.path.endsWith(s))) continue;
        insFile.run(packId, entry.path, fileKind(entry.path));
        files++;
      }

      const insAsset = db.prepare(
        "INSERT INTO assets (pack_id, logical_id, type, path, last_changed_epoch) VALUES (?,?,?,?,0)" +
          " ON CONFLICT (pack_id, path) DO NOTHING",
      );
      const insCandidate = db.prepare(
        "INSERT INTO candidates (asset_id, json_pointer, schema_pointer, raw_value, value_kind)" +
          " VALUES (?,?,?,?,?)",
      );
      const assetIdOf = db.prepare("SELECT id FROM assets WHERE pack_id = ? AND path = ?");
      const insFts = db.prepare(
        "INSERT INTO assets_fts (logical_id, type, locale, display_name, description) VALUES (?,?,?,?,?)",
      );

      const assetEntries = archive.entries.filter(
        (e) =>
          assetSuffixes.some((s) => e.path.endsWith(s)) &&
          roots.some((r) => e.path.startsWith(r)),
      );


      // Counted per pack for the progress line, because its denominator is per
      // pack. `assets` is the run-wide total, so reporting it against this
      // pack's size printed lines like `parsed 35,500 / 1,128` for every mod
      // after the first -- which reads as a corrupted counter or a runaway loop,
      // during the slowest command the tool has.
      let packAssets = 0;
      for (const entry of assetEntries) {
        const id = assetIdFromPath(entry.path);
        const assetType = types?.resolve(entry.path) ?? null;
        if (assetType !== null) typed++;
        insAsset.run(packId, id, assetType, entry.path);
        assets++;
        packAssets++;

        let doc: unknown;
        try {
          // LENIENT, like the schema ingest. The repo ships a parser written for
          // this corpus's own quirk -- bare NaN and Infinity literals, which
          // `JSON.parse` rejects outright -- and it was wired into the schema
          // reader only, so the asset walk went on failing on the exact shape it
          // handles. Anything still unparseable is COUNTED rather than dropped
          // in silence.
          doc = parseJsonLenient(await archive.readText(entry.path)).value;
        } catch {
          parseFailures++;
          continue; // malformed asset: still indexed by id, just not localized
        }

        // Pass 2: every string scalar becomes a candidate, resolved later by an
        // indexed join rather than by a second walk over the archive.
        //
        // Voxel roots are skipped -- see skipCandidatesIn. They stay searchable and
        // typed; they contribute no edges.
        if (!skipCandidatesIn.some((prefix) => entry.path.startsWith(prefix))) {
          const row = assetIdOf.get(packId, entry.path) as { id: number } | undefined;
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

        if (onProgress && packAssets % progressEvery === 0) {
          onProgress(packAssets, assetEntries.length);
        }
      }
    }

    setMeta(db, "source_archive", sources.map((x) => x.archive.path).join(""));
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
      parseFailures,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
