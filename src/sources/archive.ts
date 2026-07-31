import type { SourceStamp } from "../util/paths.ts";
import { stat } from "node:fs/promises";
import type { Entry, ZipFile } from "yauzl";
import yauzl from "yauzl";

/**
 * Random-access reader for `Assets.zip`.
 *
 * The release archive measures **3.43 GB across 60 148 entries**, so nothing here
 * may unpack wholesale or hold entry contents in memory. What makes this
 * affordable is that the ZIP central directory is a compact index at the end of
 * the file: it yields every path and size without touching compressed data.
 *
 * Measured on the release archive:
 *
 * | Operation | Cost |
 * |---|---|
 * | Read the central directory (60 148 entries) | **~4.0 s** |
 * | `list()` over a 3 641-entry prefix | ~1 ms |
 * | Decompress one asset JSON | ~0.13 ms |
 *
 * The 4 s is yauzl's per-entry event walk, not the format: reading the same
 * directory through .NET's `ZipArchive` takes ~0.5 s. Earlier drafts of the design
 * quoted that 0.5 s and called pass 1 "effectively free" — it is not, and the
 * difference is our reader rather than the archive. Acceptable because it happens
 * once per game version and is then cached; if it ever stops being acceptable,
 * hand-rolling the central-directory read is the fix, not a different design.
 *
 * See `docs/init/02-DOMAIN.md` §Vanilla asset corpus.
 */

export interface ArchiveEntry {
  /** Path inside the archive, always forward-slashed. */
  readonly path: string;
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  /**
   * CRC-32 recorded by the archive. A free per-entry change signal — no
   * decompression required — though too weak to use as a content identity.
   */
  readonly crc32: number;
  /**
   * Where this entry's LOCAL header starts, so a later read can seek to it
   * instead of re-reading the central directory. Absent for sources that are not
   * zips -- a directory has no such thing.
   */
  readonly localHeaderOffset?: number;
  /** Zip compression method: 0 stored, 8 deflate. Absent for non-zip sources. */
  readonly compression?: number;
}

/**
 * The read surface every asset source offers.
 *
 * Exists because `AssetArchive` carries `#private` fields, which make it
 * NOMINALLY distinct in TypeScript -- a structurally identical directory reader
 * would still be rejected wherever the class is named as a type. Consumers that
 * only read should say `AssetSource` and stay indifferent to zip or folder.
 */
export interface AssetSource {
  readonly path: string;
  readonly entries: readonly ArchiveEntry[];
  readonly size: number;
  has(path: string): boolean;
  list(prefix: string): readonly ArchiveEntry[];
  readBuffer(path: string): Promise<Buffer>;
  readText(path: string): Promise<string>;
  close(): void;
}

/** Directory entries are excluded; only files are listed. */
function isDirectoryEntry(entry: Entry): boolean {
  return entry.fileName.endsWith("/");
}

function openZipFile(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries lets us drive the walk; autoClose:false keeps the handle open
    // for random access afterwards, which is the whole point of this class.
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) reject(err);
      else resolve(zipfile);
    });
  });
}

export class AssetArchive implements AssetSource {
  readonly #zip: ZipFile;
  readonly #entries: readonly ArchiveEntry[];
  readonly #byPath: ReadonlyMap<string, Entry>;
  #closed = false;

  private constructor(
    zip: ZipFile,
    entries: readonly ArchiveEntry[],
    byPath: ReadonlyMap<string, Entry>,
    readonly path: string,
  ) {
    this.#zip = zip;
    this.#entries = entries;
    this.#byPath = byPath;
  }

  /** Opens the archive and reads its central directory. */
  static async open(path: string): Promise<AssetArchive> {
    const zip = await openZipFile(path);
    const entries: ArchiveEntry[] = [];
    const byPath = new Map<string, Entry>();

    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (entry: Entry) => {
        if (!isDirectoryEntry(entry)) {
          entries.push({
            path: entry.fileName,
            uncompressedSize: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            crc32: entry.crc32,
            // Carried out of the walk so the indexer can record it. Reading one
            // entry later then costs a seek rather than a second enumeration of
            // all 60,148 -- see sources/zip-entry.ts.
            localHeaderOffset: entry.relativeOffsetOfLocalHeader,
            compression: entry.compressionMethod,
          });
          byPath.set(entry.fileName, entry);
        }
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.on("error", reject);
      zip.readEntry();
    });

    return new AssetArchive(zip, entries, byPath, path);
  }

  get entries(): readonly ArchiveEntry[] {
    return this.#entries;
  }

  get size(): number {
    return this.#entries.length;
  }

  has(path: string): boolean {
    return this.#byPath.has(path);
  }

  /** Entries whose path starts with `prefix`. Cheap — no decompression. */
  list(prefix: string): readonly ArchiveEntry[] {
    return this.#entries.filter((e) => e.path.startsWith(prefix));
  }

  /**
   * Decompresses one entry.
   *
   * @throws if the entry does not exist, so a typo in a path fails loudly rather
   *         than silently yielding nothing.
   */
  async readBuffer(path: string): Promise<Buffer> {
    if (this.#closed) throw new Error(`archive is closed: ${this.path}`);
    const entry = this.#byPath.get(path);
    if (entry === undefined) {
      throw new Error(`entry not found in ${this.path}: ${path}`);
    }

    return new Promise<Buffer>((resolve, reject) => {
      this.#zip.openReadStream(entry, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
      });
    });
  }

  async readText(path: string): Promise<string> {
    return (await this.readBuffer(path)).toString("utf8");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#zip.close();
  }
}

/** Cheap identity for deciding whether a cached hash is still valid. */
export async function archiveStamp(
  path: string,
): Promise<{ size: number; mtimeMs: number }> {
  const s = await stat(path);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

/**
 * The same stamp, carrying its own path -- what `frozenKey` keys a source SET by.
 *
 * Separate from `archiveStamp` because the path belongs to the identity, not to
 * the file metadata, and every caller was already passing both.
 */
export async function sourceStamp(path: string): Promise<SourceStamp> {
  const s = await stat(path);
  return { path, size: s.size, mtimeMs: s.mtimeMs };
}
