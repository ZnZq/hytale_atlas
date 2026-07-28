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

/**
 * Bump on any change to the DDL below.
 *
 * There is no in-place migration: the index is a derived artifact, so the cheap
 * and correct answer is to rebuild. The cache path carries this version, which
 * makes a bump orphan old databases rather than silently reusing one whose shape
 * no longer matches.
 */
export const SCHEMA_VERSION = 16;

/**
 * Version of the indexing PIPELINE, written to `meta.pipeline` only after every
 * stage has finished.
 *
 * Two problems, one marker.
 *
 * **A half-written index is indistinguishable from a whole one.** Stages commit
 * separately, and `epoch` is bumped by the FIRST of them, so a build that died
 * after the corpus walk leaves 35 074 assets, zero edges and zero field stats --
 * a database that opens cleanly and answers "nothing references that" about the
 * entire corpus. Presence of the file proves nothing; presence of this key
 * proves the pipeline reached the end.
 *
 * **A complete index can still be out of date in CONTENT.** `SCHEMA_VERSION`
 * guards the database's SHAPE and is part of the cache path, so changing it
 * orphans old files. But most indexer fixes change what gets written without
 * touching a single column: reading `hytaleAssetRef` from anyOf branches added
 * 363 declared targets, the path-length exemption added 957 file edges, and the
 * dangling rule stopped marking 39 320 resolved references. Every one left the
 * shape identical, so an existing index stayed silently wrong.
 *
 * **Bump this whenever a change alters what indexing writes.** Not for a
 * refactor, not for rendering, not for a query — for anything that would make a
 * freshly built index differ from an existing one.
 */
export const PIPELINE_VERSION = 1;

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
  -- The .lang file's stem, which IS the reference root: a key stored as
  -- 'items.Foo.name' in server.lang is referenced by an asset as
  -- 'server.items.Foo.name'. Without it the tool printed the stored form and
  -- a modder pasting it back got a dead key -- reported in four blind trials
  -- -- and 'wordlists.runes.algas', whose root is 'wordlists', was declared a
  -- 'real miss' while server.runes.algas wrongly resolved.
  root    TEXT,
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
  -- Which table dst points into: 'asset' | 'file' | 'lang_key'.
  --
  -- dst is a foreign key into a DIFFERENT table depending on kind, and SQLite
  -- cannot express that. A query that joins assets on dst without filtering kind
  -- silently matches lang_key row ids against asset ids and returns confident
  -- nonsense -- which is exactly what an early diagnostic query did, reporting a
  -- localization key as a high-confidence reference to a FlockAsset.
  --
  -- Always filter on dst_kind (or kind) when joining.
  dst_kind     TEXT NOT NULL DEFAULT 'asset',
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
  -- Where the value literally sits, array indices included, so a broken entry can
  -- be named exactly rather than as "one of Recipe.Input".
  json_pointer     TEXT NOT NULL,
  -- The same location with array indices collapsed to a star, which is the form
  -- schema_fields uses. Stored rather than computed in SQL because SQLite has no
  -- regex replace, and this is the join key that attaches declared reference
  -- types to observed values.
  --
  -- (No backticks in this file: SCHEMA_SQL is a template literal, and one here
  -- silently terminates it -- the compiler then reads the SQL as arithmetic.)
  schema_pointer   TEXT NOT NULL DEFAULT '',
  -- Namespace schema_pointer is expressed in, after rebasing across any $ref the
  -- path crossed. An Item pointer /BlockType/Gathering/... lands in the BlockType
  -- namespace as /Gathering/..., because Item./BlockType is a ref, not a
  -- container. Filled by pass 3; NULL until then.
  schema_scope     TEXT,
  raw_value        TEXT NOT NULL,
  -- 'string' | 'number' | 'boolean'. Only strings can be references, so edge
  -- resolution filters on this; the observed layer counts all of them.
  --
  -- Collecting strings alone was a silent, systematic lie. Every numeric and
  -- boolean field -- 1 963 of them -- was absent from field_stats and therefore
  -- labelled 'unused' by describe_schema, including ItemLevel, which real items
  -- plainly set. 'unused' read as a fact about the corpus while it was really a
  -- fact about what extraction bothered to look at.
  value_kind       TEXT NOT NULL DEFAULT 'string',
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
  -- Values actually seen in the corpus for a field the schema gives no enum for.
  -- 13 677 of 14 628 fields declare none -- GatherType among them -- so without
  -- this there is no answer to "what else can I put here" for most of the schema.
  --
  -- Kept in a separate column from enum_values on purpose: an inferred set is
  -- what vanilla happens to use, a declared one is what the game accepts, and
  -- presenting the first as the second would be a lie.
  observed_values   TEXT,
  -- Discriminator value that selects this definition, read from the schema's own
  -- prose. Derived from the branch NAME it would be wrong: SelectInteraction is
  -- selected by 'Selector', which is not a prefix of it.
  type_constant     TEXT,
  -- Union discriminator, declared by the schema in hytaleSchemaTypeField.
  -- The property is NOT always 'Type': 229 declarations say Type, 14 say Id and
  -- one says Op, and hardcoding Type meant those 15 unions never resolved.
  discriminator_property TEXT,
  -- Space separated, positionally aligned with ref_scope. No declared value
  -- contains a space (checked across all 244 declarations).
  discriminator_values   TEXT,
  title             TEXT,
  description       TEXT,
  -- Asset type this field points at, from hytale.hytaleAssetRef. 932 fields carry
  -- it across 70 distinct targets. This is what turns a reference edge from a
  -- string-collision guess into a declared fact.
  reference_target  TEXT,
  -- Namespace the pointer continues in when this field is a $ref, e.g.
  -- Item./BlockType has ref_scope 'BlockType' and common:ItemTool for a shared
  -- definition. Every namespace is flattened once and $refs are edges between
  -- them, so an observed pointer is rebased across those edges rather than
  -- matched against an inlined copy.
  ref_scope         TEXT,
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
-- Observed values live here as well as on schema_fields, because an UNDECLARED
-- field has no schema_fields row to hang them on. common:BenchRequirement./Set is
-- used by 69 assets and declared nowhere; describe could say it existed and
-- nothing else, which is a dead end rather than an answer.
CREATE TABLE IF NOT EXISTS field_stats (
  asset_type   TEXT NOT NULL,
  json_pointer TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  of_total     INTEGER NOT NULL DEFAULT 0,
  value_types  TEXT,
  target_types TEXT,
  cardinality  INTEGER,
  -- Values seen, when few enough to enumerate. NOT the legal set.
  observed_values TEXT,
  PRIMARY KEY (asset_type, json_pointer)
) STRICT;

-- ---------------------------------------------------------------------------
-- Value links
--
-- Strings whose legal values are declared elsewhere in the corpus rather than
-- named by the schema. JSON Schema has no vocabulary for "this field draws its
-- values from that field", so these joins are invisible to the reference resolver
-- however well it works: the marker it needs (hytaleAssetRef) is absent, and the
-- values are not asset ids to fall back on.
--
-- Each link is ONE declared line in src/indexer/value-links.ts; the field shapes,
-- union branches and namespaces are all read from the schema. A generic value-set
-- containment detector was measured as a way to avoid declaring them at all and
-- rejected: 49 pairs survived coverage >= 0.8, roughly 6 were real, and it missed
-- benches entirely. It is a discovery tool, not a mechanism.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS value_links (
  link         TEXT NOT NULL,
  value        TEXT NOT NULL,
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  json_pointer TEXT NOT NULL,
  -- 'declares' names the value; 'references' uses it.
  role         TEXT NOT NULL,
  -- References only: 0 when nothing declares this value. Kept rather than
  -- dropped -- vanilla ships broken ones, so these are validate_pack findings.
  resolved     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (link, asset_id, json_pointer, role)
) STRICT;

-- ---------------------------------------------------------------------------
-- Crafting benches
--
-- Recipe.BenchRequirement[].Id names a BENCH, not an asset: values like
-- 'Builders' and 'Farmingbench' are declared inside Bench_* items at
-- /BlockType/Bench/Id. Without these tables the reverse lookup ("what can I
-- craft here") has nothing to join to. Measured: 1 957 requirements across
-- 1 928 items, 21 distinct bench ids, 96.0% resolving to a declared bench.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS benches (
  id         TEXT PRIMARY KEY,
  -- Which union branch declared it: Crafting | Processing | DiagramCrafting |
  -- StructuralCrafting. Read from the data's own discriminator, not guessed --
  -- the schema declares it as an enum on all four branches.
  bench_type TEXT
) STRICT;

-- A bench id may be declared by more than one asset, so this is a separate table
-- rather than a column. Vanilla already does it: 16 declarations, 15 distinct
-- ids, with 'Farmingbench' declared by BOTH Bench_Farming and Bench_Trough.
-- Holding the asset on benches directly meant ON CONFLICT DO NOTHING silently
-- discarded Bench_Trough -- it appeared nowhere in the index at all.
CREATE TABLE IF NOT EXISTS bench_declarations (
  bench_id TEXT NOT NULL REFERENCES benches(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (bench_id, asset_id)
) STRICT;

-- Keyed by (bench, category), never by category alone: 'Decorative' is declared
-- by both Builders and Farmingbench, and 'All' by both Farmingbench and
-- Loombench. Those two collisions cover 100 of 1 364 category matches, so a
-- global lookup would be ambiguous exactly where it is used most.
CREATE TABLE IF NOT EXISTS bench_categories (
  bench_id    TEXT NOT NULL REFERENCES benches(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  -- Nesting comes from BenchCategory.ItemCategories, NOT from a nested
  -- 'Categories'. An earlier revision guessed the latter: the guessed shape
  -- matched nothing (parent_id was null for all 67 rows) while the 12 real
  -- nested categories the schema does declare were dropped on the floor.
  parent_id   TEXT,
  -- Localization key, stored with its 'server.' root already stripped so it
  -- joins lang_keys directly. 38 of 53 declared names carry that prefix and none
  -- resolve without removing it.
  name_key    TEXT,
  icon        TEXT,
  PRIMARY KEY (bench_id, category_id)
) STRICT;

CREATE TABLE IF NOT EXISTS bench_requirements (
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  json_pointer TEXT NOT NULL,
  bench_id     TEXT NOT NULL,
  -- 0 when bench_id names no declared bench. 58 of those are the literal 'TODO',
  -- shipped by vanilla itself -- a validation finding, not a parse failure.
  resolved     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, json_pointer)
) STRICT;

CREATE TABLE IF NOT EXISTS bench_requirement_categories (
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  json_pointer TEXT NOT NULL,
  category_id  TEXT NOT NULL,
  PRIMARY KEY (asset_id, json_pointer, category_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_bench_req_bench ON bench_requirements (bench_id);
CREATE INDEX IF NOT EXISTS idx_value_links_value ON value_links (link, value, role);

CREATE INDEX IF NOT EXISTS idx_edges_src        ON edges (src, kind);
CREATE INDEX IF NOT EXISTS idx_edges_dst        ON edges (dst, kind);
CREATE INDEX IF NOT EXISTS idx_candidates_value ON candidates (raw_value);
CREATE INDEX IF NOT EXISTS idx_candidates_schema_ptr ON candidates (schema_scope, schema_pointer);
CREATE INDEX IF NOT EXISTS idx_schema_fields_ref ON schema_fields (reference_target);
CREATE INDEX IF NOT EXISTS idx_candidates_asset ON candidates (asset_id);
-- NOTE: idx_candidates_asset_ptr is created in pass 3, not here. Declaring it up
-- front made every one of 479 000 candidate inserts maintain a second wide index
-- and the build stopped finishing at all -- see computeFieldStats().
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
--
-- ALL locales are indexed, one row per (asset, locale). The vanilla corpus ships
-- five: en-US, pt-BR, ru-RU, uk-UA, zh-CN. A single display_name column would
-- have quietly made search English-only while lang_keys pretended otherwise.
-- Cost is trivial -- 3 762 items x 5 locales is under 19 000 rows -- and carrying
-- the locale lets a result say which language it matched in.
--
-- Callers must GROUP BY logical_id: one asset can match in several locales.
--
-- Text on BOTH sides -- indexed values and query terms -- goes through
-- util/text.ts normalizeSearchText(). It segments CJK ideographs into individual
-- tokens and folds Ukrainian Ґ to Г. Applying it to only one side silently breaks
-- search for those languages. Never insert into this table directly.
--
-- Measured tokenizer behaviour across all five locales:
--   unicode61 remove_diacritics 2  handles Latin and Cyrillic including case
--                                  folding (КОВАЛЬНЯ -> Ковальня). Treats a run of
--                                  ideographs as ONE token, and does not fold
--                                  Ґ (U+0490) to Г -- both fixed by normalisation.
--   trigram                        worse: no CJK match at all, because 锻炉 is two
--                                  characters and a trigram needs three.
--
-- prefix='2 3' serves stem queries in inflected languages. It does NOT solve
-- inflection on its own: FTS5 requires the *query* to be a prefix of the
-- *indexed* term, so кірасу misses кіраса (they diverge at the last letter).
-- Full inflected forms are reached by progressive suffix trimming at query time
-- -- see buildRelaxedMatchExpressions() in util/text.ts.
--
-- One-character prefixes are deliberately absent: segmentation already makes each
-- ideograph its own token, so prefix='1' would only bloat the index.
-- ---------------------------------------------------------------------------

-- locale is UNINDEXED: it is a result attribute, not searchable text. Indexing it
-- would let a query for "ru" match every Russian row, because unicode61 splits
-- "ru-RU" into two "ru" tokens. It stays retrievable, which is what ranking needs.
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5 (
  logical_id,
  type,
  locale UNINDEXED,
  display_name,
  description,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- Searching the schema itself, which answers "where does capability X live, and
-- does it exist at all" -- the one question corpus search structurally cannot,
-- because absence is invisible to a search over what exists.
-- No locale column: the generated schema's prose is English-only, because it comes
-- from the game's own source rather than from the translation files.
-- Every field is indexed, including the 9 936 with no prose at all. Indexing only
-- fields carrying a title or description left 'GatherType' -- a real field, used
-- by 1 757 assets -- unfindable, and search_schema answered 'nothing declares this
-- capability', which is worse than no answer.
--
-- 'terms' carries the pointer and type name split into words (GatherType ->
-- Gather Type) so a capability can be found in the words a human would use. It is
-- separate from json_pointer because that column is returned verbatim and joins
-- back to schema_fields.
CREATE VIRTUAL TABLE IF NOT EXISTS schema_fts USING fts5 (
  asset_type,
  json_pointer,
  terms,
  title,
  description,
  enum_values,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
`;
