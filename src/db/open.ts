import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PIPELINE_VERSION, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

/**
 * Opening and initialising an index database.
 *
 * Uses Node's built-in `node:sqlite` rather than `better-sqlite3`. Verified on
 * Node 24.16 / SQLite 3.53: FTS5 and WAL both work. That removes the native build
 * step entirely, which matters for a tool whose primary audience is no-code pack
 * authors running `npx` — see `docs/init/06-CLI-UX.md` §Distribution.
 */

export interface OpenOptions {
  /** Open read-only. The frozen cache needs no coordination after it is built. */
  readonly readOnly?: boolean;
  /** Milliseconds to wait on a locked database before erroring. */
  readonly busyTimeoutMs?: number;
}

export type Database = DatabaseSync;

/**
 * Opens a database, applying pragmas and creating the schema if absent.
 *
 * WAL is not optional: a user may run two agent sessions against one project, or
 * an MCP server alongside a CLI `validate`. Concurrent readers with one writer is
 * exactly that workload (`docs/init/03-ARCHITECTURE.md` §Concurrency).
 */
export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const { readOnly = false, busyTimeoutMs = 5_000 } = options;

  if (!readOnly && path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path, { readOnly });

  // WAL is persistent, so setting it on a read-only handle is both unnecessary
  // and an error. Everything else is per-connection.
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    // NORMAL is the right durability trade for a rebuildable index: a crash can
    // cost the last transaction, and the answer to that is to re-index.
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  db.exec("PRAGMA foreign_keys = ON");

  if (!readOnly) migrate(db);

  return db;
}

function userVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? 0;
}

/**
 * Brings an empty or older database up to {@link SCHEMA_VERSION}.
 *
 * There is deliberately no downgrade path and no in-place migration between
 * versions yet. The index is a derived artifact: when the schema changes, the
 * cheap and correct answer is to discard and rebuild, not to migrate. Revisit
 * only once rebuilding costs a user real time.
 */
export function migrate(db: Database): void {
  const current = userVersion(db);

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `index was written by a newer version of hytale-atlas ` +
        `(schema ${current} > ${SCHEMA_VERSION}). Run 'hytale-atlas clean' to rebuild.`,
    );
  }
  if (current === SCHEMA_VERSION) return;

  db.exec("BEGIN");
  try {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * The monotonic epoch counter.
 *
 * Exactly one exists, in `meta`. Every tool response carries the current value so
 * an agent holding a result from epoch 41 can tell that its picture may be stale
 * when a later response says 47 — without a separate call to find out.
 */
export function currentEpoch(db: Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as
    | { value?: string }
    | undefined;
  return row?.value === undefined ? 0 : Number(row.value);
}

/** Bumps the epoch. Called once per drained change batch, never per file. */
export function bumpEpoch(db: Database): number {
  const next = currentEpoch(db) + 1;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('epoch', ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(String(next));
  return next;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Whether an open database was finished, and by which indexer.
 *
 * The only reliable way to recognise a partial index. Counting rows does not
 * work: a build that dies mid-pipeline leaves a database with tens of thousands
 * of assets and nothing else, and every count you would think to check is a
 * legitimate value for some earlier stage. `meta.pipeline` is written once, last,
 * by `cmdIndex` -- so its ABSENCE means the build never reached the end, and a
 * value other than `PIPELINE_VERSION` means it finished under indexer logic that
 * wrote different content (`SCHEMA_VERSION` cannot see that; see schema.ts).
 *
 * Shared deliberately: `status` reports this state and the MCP bootstrap acts on
 * it, and the two must not be able to disagree about whether an index is usable.
 */
export function pipelineState(db: Database): "ready" | "incomplete" | "stale" {
  const written = getMeta(db, "pipeline");
  if (written === null) return "incomplete";
  return written === String(PIPELINE_VERSION) ? "ready" : "stale";
}
