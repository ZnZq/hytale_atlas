/**
 * Index storage schema.
 *
 * SQLite with an edge table and recursive CTEs, per `docs/init/03-ARCHITECTURE.md`
 * §Storage: the workload is tens to hundreds of thousands of nodes, read-mostly
 * after indexing, with queries typically 1–3 hops. A graph database buys little
 * and costs deployment complexity, which is fatal for a tool whose premise is
 * `npx` and go.
 *
 * The same schema serves both layers. The **frozen** database holds vanilla and
 * third-party archives and is shared across every project on the machine; the
 * **hot** database holds one project and is rebuilt per file. Queries run against
 * the union; only hot is ever written during editing.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- ---------------------------------------------------------------------------
-- Bookkeeping
-- ---------------------------------------------------------------------------

-- Global key/value: epoch, source hashes, tool version, patchline, tier.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Packs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS packs (
  id          INTEGER PRIMARY KEY,
  -- manifest Group:Name, which is how the Asset Editor addresses a pack
  -- (vanilla is Hytale:Hytale). Identifies the pack, never an asset.
  group_name  TEXT,
  name        TEXT NOT NULL,
  version     TEXT,
  path        TEXT NOT NULL,
  -- 'vanilla' | 'archive' | 'directory'
  kind        TEXT NOT NULL,
  -- Load priority, lower wins, mirroring AssetPack$PackSource.overrides():
  -- CLI=0 < CLASSPATH=1 < MODS=2 < RUNTIME=3. Ties inside one source category
  -- are NOT resolved by that enum -- see OPEN-QUESTIONS.md Q5.
  priority    INTEGER NOT NULL DEFAULT 2,
  source_hash TEXT,
  UNIQUE (path)
) STRICT;

-- ---------------------------------------------------------------------------
-- Asset types
--
-- Populated from the generated schema, whose every root carries hytale.path and
-- hytale.extension. NOT derived from directory depth: a second-level directory
-- is not a type (Server/Item alone holds 14 unrelated groupings), and the JAR's
-- 39 asset.type subpackages do not map onto the archive's 51 directories.
-- See OPEN-QUESTIONS.md Q4.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS asset_types (
  id             TEXT PRIMARY KEY,
  -- Path relative to the pack root, e.g. 'Item/Groups', 'NPC/Attitude/Roles'.
  schema_path    TEXT,
  file_extension TEXT,
  -- 'codec' when it came from the generated schema, 'inferred' otherwise.
  source         TEXT NOT NULL DEFAULT 'inferred'
) STRICT;

-- ---------------------------------------------------------------------------
-- Assets
--
-- An Asset is one physical definition in one pack, NOT a logical identity. Two
-- packs defining Sword_Iron produce two rows; exactly one carries is_effective.
-- That makes overlay semantics a queryable fact rather than a side effect.
--
-- logical_id = '<type>:<basename without extension>'. Identity is path-derived;
-- organisational nesting is not part of it (OPEN-QUESTIONS.md Q16).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assets (
  id                 INTEGER PRIMARY KEY,
  pack_id            INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  logical_id         TEXT NOT NULL,
  type               TEXT REFERENCES asset_types(id),
  path               TEXT NOT NULL,
  is_effective       INTEGER NOT NULL DEFAULT 1,
  content_hash       TEXT,
  -- Stamp of the global epoch at which this asset last changed. NOT a second
  -- counter -- there is exactly one, in meta. Makes whats_changed(since) a
  -- single indexed range scan.
  last_changed_epoch INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pack_id, path)
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY,
  pack_id      INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  -- 'model' | 'texture' | 'audio' | 'ui' | 'other'
  kind         TEXT NOT NULL DEFAULT 'other',
  content_hash TEXT,
  UNIQUE (pack_id, path)
) STRICT;

-- ---------------------------------------------------------------------------
-- Localization
--
-- The join between human intent and machine identifiers, and therefore the
-- foundation of search. Assets reference keys explicitly via
-- TranslationProperties, so LOCALIZED_BY edges are observed, not derived.
--
-- Trap: the reference reads 'server.items.X.name' while the key stored in the
-- file is 'items.X.name' -- the prefix corresponds to the Server/ root the lang
-- file lives under. Store the key as written and normalise on lookup.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lang_keys (
  id      INTEGER PRIMARY KEY,
  pack_id INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  locale  TEXT NOT NULL,
  value   TEXT NOT NULL,
  UNIQUE (pack_id, key, locale)
) STRICT;

-- ---------------------------------------------------------------------------
-- Graph
--
-- json_pointer is the most important property in the model: it makes schema
-- inference possible, joins corpus data to extracted schema on the same key, and
-- lets an agent be told *where* a relationship lives rather than merely that it
-- does.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edges (
  id           INTEGER PRIMARY KEY,
  src          INTEGER NOT NULL,
  dst          INTEGER NOT NULL,
  -- DEFINED_IN | OVERRIDES | INHERITS_FROM | REFERENCES | REFERENCES_FILE
  -- | LOCALIZED_BY | INSTANCE_OF | DEPENDS_ON
  --
  -- INHERITS_FROM (the Parent field) is deliberately distinct from OVERRIDES:
  -- inheritance is intra-corpus and explicit, overriding is cross-pack and
  -- identity-based. Conflating them makes impact analysis wrong both ways.
  kind         TEXT NOT NULL,
  json_pointer TEXT,
  -- 'high' | 'medium' | 'low'. Low-confidence edges are kept, never discarded at
  -- index time: they serve the "did you mean" case and schema may promote them.
  confidence   TEXT NOT NULL DEFAULT 'low',
  role         TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- Unresolved candidates
--
-- The mechanism that makes incremental indexing possible at all. Every string
-- scalar that failed to resolve is persisted here, so that when an asset is
-- later added, the edges that should point at it are one indexed lookup away
-- rather than a full corpus walk. Removing an asset demotes incoming edges back
-- to candidates marked dangling; it never deletes them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS candidates (
  id               INTEGER PRIMARY KEY,
  asset_id         INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  json_pointer     TEXT NOT NULL,
  raw_value        TEXT NOT NULL,
  resolved_edge_id INTEGER REFERENCES edges(id) ON DELETE SET NULL,
  dangling         INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ---------------------------------------------------------------------------
-- Schema: declared (from the game) and observed (from the corpus)
--
-- Kept apart deliberately. describe_schema is a summary of the repository;
-- validate_pack is a constraint every document must satisfy. Different
-- artifacts -- do not collapse them (07-PRIOR-ART.md §Academic framing).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_fields (
  asset_type        TEXT NOT NULL,
  json_pointer      TEXT NOT NULL,
  declared_type     TEXT,
  optional          INTEGER,
  default_value     TEXT,
  -- 1 when the generated schema emitted a non-finite default (NaN/Infinity),
  -- which means *unset* rather than a default of null. See util/json.ts.
  default_unset     INTEGER NOT NULL DEFAULT 0,
  enum_values       TEXT,
  title             TEXT,
  description       TEXT,
  -- Per-field inheritance semantics from hytale.inheritsProperty /
  -- hytale.mergesProperties. Answers OPEN-QUESTIONS.md Q18 at field granularity.
  inherits_property INTEGER NOT NULL DEFAULT 0,
  merges_properties INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_type, json_pointer)
) STRICT;

-- Shared $ref targets, stored once.
--
-- 70 of 104 generated schemas reference common.json, and inlining resolved copies
-- would multiply ~7 MB by 70. Store definitions once and resolve at query time.
CREATE TABLE IF NOT EXISTS schema_defs (
  source_file TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  PRIMARY KEY (source_file, name)
) STRICT;

-- Aggregate statistics from the corpus. Computed over inheritance-resolved
-- assets: raw files undercount, because an inherited field never appears in the
-- child document.
CREATE TABLE IF NOT EXISTS field_stats (
  asset_type   TEXT NOT NULL,
  json_pointer TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  of_total     INTEGER NOT NULL DEFAULT 0,
  value_types  TEXT,
  target_types TEXT,
  cardinality  INTEGER,
  PRIMARY KEY (asset_type, json_pointer)
) STRICT;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_edges_src        ON edges (src, kind);
CREATE INDEX IF NOT EXISTS idx_edges_dst        ON edges (dst, kind);
CREATE INDEX IF NOT EXISTS idx_candidates_value ON candidates (raw_value);
CREATE INDEX IF NOT EXISTS idx_candidates_asset ON candidates (asset_id);
CREATE INDEX IF NOT EXISTS idx_assets_logical   ON assets (logical_id);
CREATE INDEX IF NOT EXISTS idx_assets_epoch     ON assets (last_changed_epoch);
CREATE INDEX IF NOT EXISTS idx_assets_type      ON assets (type);
CREATE INDEX IF NOT EXISTS idx_lang_key         ON lang_keys (key, locale);
CREATE INDEX IF NOT EXISTS idx_files_path       ON files (path);

-- ---------------------------------------------------------------------------
-- Full-text search
--
-- Identifiers alone do not answer natural-language queries: they are machine
-- names, and users describe things in prose. items.Armor_Adamantite_Chest.name
-- resolves to "Adamantite Cuirass" -- a search for "cuirass" matches nothing in
-- the identifier space. Localized values are therefore indexed alongside IDs.
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5 (
  logical_id,
  type,
  display_name,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Searching the schema itself, which answers "where does capability X live, and
-- does it exist at all" -- the one question corpus search structurally cannot,
-- because absence is invisible to a search over what exists.
CREATE VIRTUAL TABLE IF NOT EXISTS schema_fts USING fts5 (
  asset_type,
  json_pointer,
  title,
  description,
  enum_values,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
