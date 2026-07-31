import { open as openFile, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Reading ONE entry out of a zip, given where it starts.
 *
 * `AssetArchive.open` reads the central directory to build a path->entry map,
 * which is the right thing for the indexer -- it walks every entry anyway. It is
 * the wrong thing for `get`, which wants a single file: the game's Assets.zip
 * holds 60,148 entries and enumerating them costs ~103us each, so `get` spent
 * 12-23s building a 60,000-name directory to read one 2 KB document. Measured on
 * the release archive: open 12,314ms, readText 6ms.
 *
 * The central directory is a derived artifact, and this project already keeps
 * derived artifacts in the index. So the offsets are recorded at build time and
 * a read becomes a seek.
 *
 * SAFETY OF THE CACHED OFFSET. The index is keyed by a stamp of the archive, so
 * an archive that changes gets a different database; offsets can never be read
 * against a file they did not come from. The local header signature is checked
 * anyway, because a silent wrong answer here would be indistinguishable from a
 * real asset.
 */

/** What the index records so an entry can be found again without the directory. */
export interface StoredEntry {
  /** Offset of the LOCAL file header, as recorded in the central directory. */
  readonly offset: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Nothing else occurs in this corpus. */
  readonly compression: number;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_FIXED_SIZE = 30;
const STORED = 0;
const DEFLATE = 8;

/**
 * A handle held open across several reads.
 *
 * `get` resolves a parent chain, so one answer is up to 16 reads of the same
 * archive; opening the file once per answer rather than once per read is the
 * difference between one syscall and sixteen.
 */
export class ZipReader {
  readonly #file: FileHandle;
  #closed = false;

  private constructor(
    file: FileHandle,
    readonly path: string,
  ) {
    this.#file = file;
  }

  static async open(path: string): Promise<ZipReader> {
    return new ZipReader(await openFile(path, "r"), path);
  }

  async read(entry: StoredEntry): Promise<Buffer> {
    if (this.#closed) throw new Error(`archive reader for ${this.path} is closed`);

    const header = Buffer.allocUnsafe(LOCAL_HEADER_FIXED_SIZE);
    await this.#file.read(header, 0, LOCAL_HEADER_FIXED_SIZE, entry.offset);
    if (header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(
        `no local file header at offset ${entry.offset} of ${this.path} -- ` +
          `the recorded offsets do not belong to this archive`,
      );
    }

    // The name and extra fields are stored AGAIN in the local header, and their
    // lengths there are not required to match the central directory's. The data
    // start is therefore computable only from this header, never from the
    // directory record -- a zip written by a tool that pads the local extra field
    // would otherwise be read from the wrong byte.
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = entry.offset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength;

    const raw = Buffer.allocUnsafe(entry.compressedSize);
    if (entry.compressedSize > 0) {
      await this.#file.read(raw, 0, entry.compressedSize, start);
    }
    if (entry.compression === STORED) return raw;
    if (entry.compression === DEFLATE) return inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${entry.compression} in ${this.path}`);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#file.close();
  }
}
