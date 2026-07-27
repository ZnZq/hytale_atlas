import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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

export class AssetArchive {
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

/**
 * SHA-256 of the archive itself, used as the frozen-layer cache key.
 *
 * Keyed by content, never by version string: several patchlines commonly coexist
 * on one machine (`docs/init/OPEN-QUESTIONS.md` Q6), and a version string cannot
 * distinguish them reliably.
 *
 * This reads the whole file. Callers should cache the result against
 * (path, size, mtime) rather than recomputing it per run.
 */
export async function hashArchive(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Cheap identity for deciding whether a cached hash is still valid. */
export async function archiveStamp(
  path: string,
): Promise<{ size: number; mtimeMs: number }> {
  const s = await stat(path);
  return { size: s.size, mtimeMs: s.mtimeMs };
}
