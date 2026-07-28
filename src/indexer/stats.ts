import type { Database } from "../db/open.ts";
import { VALUE_SEP_SQL } from "../db/values.ts";
import { scopes } from "../sources/schema-doc.ts";

/**
 * Pass 3 -- field statistics.
 *
 * Aggregates the candidates collected in pass 2 into per-`(asset_type, pointer)`
 * facts, which is what gives `describe_schema` an **observed** layer beside the
 * declared one. The two answer different questions and must not be merged:
 * declared says what the game accepts, observed says what vanilla actually does
 * (`docs/init/07-PRIOR-ART.md` Academic framing).
 *
 * The observed layer is also the only route to a whole class of question the
 * schema cannot answer. `GatherType` carries no schema enum yet the corpus uses
 * exactly eight values; without corpus-inferred enums, "what else can I put here"
 * has no answer for the 13 677 of 14 628 fields that declare none.
 */

export interface StatsResult {
  readonly rows: number;
  readonly typesCovered: number;
  readonly enumCandidates: number;
  readonly schemaOnlyFields: number;
  readonly undeclaredFields: number;
  /** Polymorphic crossings a data discriminator selected a branch for. */
  readonly resolvedUnions: number;
  /** Polymorphic crossings left in the parent namespace, discriminator absent. */
  readonly unresolvedUnions: number;
  readonly elapsedMs: number;
}

/**
 * Cardinality at or below which a field's observed values are treated as an
 * enumeration rather than free text.
 *
 * GenSON never infers enums on its own and requires enum capture to be switched
 * on per node, which is why a cardinality pre-pass exists at all
 * (`docs/init/07-PRIOR-ART.md` GenSON). The threshold is deliberately generous:
 * a false enum is visible and harmless in `describe_schema`, whereas a missed one
 * silently withholds the answer.
 */
const ENUM_MAX_CARDINALITY = 40;

/**
 * Minimum occurrences before low cardinality means anything. A pointer seen twice
 * with two distinct values is not an enum, it is a coincidence.
 */
const ENUM_MIN_OCCURRENCES = 8;

/**
 * Rewrites candidate pointers so they join to schema fields.
 *
 * Array indices are collapsed at extraction time, but **dynamic map keys cannot
 * be**: at that point `Type` in `/Tags/Type/0` is indistinguishable from an
 * ordinary property name. Only the schema knows `Tags` is an
 * `additionalProperties` map, so the collapse has to happen here, walking each
 * pointer segment by segment against the type's known pointers and substituting
 * `*` wherever the literal segment is absent but a wildcard exists.
 *
 * Measured impact: without it only **683 of 14 628** schema fields joined to
 * observed data, making 95 % of the schema look unused. `/Tags/Type/*` against
 * `/Tags/*​/*`, `/BlockType/State/Definitions/Corner_Left/...` against
 * `/BlockType/State/Definitions/*​/...` and so on.
 */
/**
 * Picks the union branch a discriminator value selects.
 *
 * The generator names branches `<discriminator><family>`: `Single` +
 * `ItemDropContainer`, `Solidity` + `MaterialProviderAsset`. The obvious rule --
 * strip the branches' longest common suffix and match the remainder exactly --
 * fails in both directions, because the common suffix is a character-level
 * accident rather than a name boundary:
 *
 * - over-strips: `SingleItemDropContainer` / `MultipleItemDropContainer` share
 *   `leItemDropContainer`, leaving `Sing` and `Multip`
 * - under-strips: `ConstantThicknessLayer` / `NoiseThickness` share nothing, so
 *   `ConstantThickness` matches no key at all
 *
 * Longest-prefix does both correctly. `branches` is sorted shortest-first, so an
 * exact name wins over a longer one that merely extends it -- `Single` picks
 * `SingleMusicContainer` rather than `SingleTrackMusicContainer`.
 */
function selectBranch(
  branches: readonly { local: string; target: string; constant: string | null }[],
  discriminator: string,
): string | undefined {
  // The schema's own declaration wins. Each branch states its discriminator in
  // prose on its /Type field -- "must be set to the constant value \"Selector\""
  // -- and that is authoritative where the name is only a convention.
  // `SelectInteraction` is selected by `Selector`, which is not a prefix of it,
  // so name-matching reported every one of its fields as unused while vanilla
  // pickaxes and hatchets use it in their swing chains.
  for (const branch of branches) {
    if (branch.constant === discriminator) return branch.target;
  }
  for (const branch of branches) {
    if (branch.local.startsWith(discriminator)) return branch.target;
  }
  return undefined;
}

/**
 * Key into the discriminator map.
 *
 * A named builder rather than two inline template literals, because the write and
 * read sites drifted apart once already: one used a raw control character as the
 * separator and the other a space, so every one of 21 439 lookups missed while
 * both maps were correctly populated.
 */
function discriminatorKey(assetId: number, pointer: string): string {
  return `${assetId} ${pointer}`;
}

function normalisePointersAgainstSchema(db: Database): {
  changed: number;
  resolvedUnions: number;
  unresolvedUnions: number;
} {
  const byType = new Map<string, Set<string>>();
  /**
   * '<namespace>|<pointer>' -> namespace the pointer continues in.
   *
   * Only single-target crossings are recorded. A multi-target `ref_scope` is a
   * polymorphic union whose branch is chosen by a discriminator in the data, so
   * the pointer alone cannot say where it continues.
   */
  const refScopes = new Map<string, string>();
  /**
   * '<namespace>|<pointer>' -> discriminator value -> branch namespace.
   *
   * The other half of a polymorphic crossing: given the sibling `Type` from the
   * data, this says which branch it selects.
   */
  const unionBranches = new Map<
    string,
    { local: string; target: string; constant: string | null }[]
  >();
  /** '<namespace>|<pointer>' -> field carrying this union's discriminator. */
  const discriminatorAt = new Map<string, string>();
  /** Namespace -> the discriminator value the schema says selects it. */
  const declaredConstant = new Map<string, string>();
  for (const row of db
    .prepare(
      "SELECT asset_type, type_constant FROM schema_fields" +
        " WHERE json_pointer = '/Type' AND type_constant IS NOT NULL",
    )
    .all() as unknown as { asset_type: string; type_constant: string }[]) {
    declaredConstant.set(row.asset_type, row.type_constant);
  }

  for (const row of db
    .prepare(
      "SELECT asset_type, json_pointer, ref_scope, discriminator_property, discriminator_values" +
        " FROM schema_fields",
    )
    .all() as unknown as {
    asset_type: string;
    json_pointer: string;
    ref_scope: string | null;
    discriminator_property: string | null;
    discriminator_values: string | null;
  }[]) {
    let set = byType.get(row.asset_type);
    if (set === undefined) {
      set = new Set();
      byType.set(row.asset_type, set);
    }
    set.add(row.json_pointer);
    const targets = scopes(row.ref_scope);
    if (targets.length === 1) {
      refScopes.set(`${row.asset_type}|${row.json_pointer}`, targets[0]!);
    } else if (targets.length > 1) {
      // hytaleSchemaTypeField, when present, states both the property that
      // carries the discriminator and its value per branch, positionally. That
      // is exact; everything below it is reconstruction.
      const key = `${row.asset_type}|${row.json_pointer}`;
      const declaredValues = scopes(row.discriminator_values);
      if (row.discriminator_property !== null) {
        discriminatorAt.set(key, row.discriminator_property);
      }
      const branches = targets
        .map((target, index) => ({
          local: target.slice(target.lastIndexOf(":") + 1),
          target,
          constant:
            declaredValues.length === targets.length
              ? declaredValues[index]!
              : (declaredConstant.get(target) ?? null),
        }))
        .sort((a, b) => a.local.length - b.local.length || a.local.localeCompare(b.local));
      unionBranches.set(key, branches);
    }
  }

  /**
   * `(asset, pointer)` -> the `Type` value sitting there.
   *
   * Keyed on the RAW pointer, with real array indices, because the discriminator
   * is per instance: two entries of `/Container/Containers` routinely take
   * different branches, and a wildcarded key would collapse them together.
   */
  // Every property any union declares as its discriminator, not just `Type`.
  // Collecting `/Type` alone meant the 15 unions keyed on `Id` or `Op` had no
  // value to look up even once the declaration was read.
  const properties = new Set(["Type", ...discriminatorAt.values()]);
  const discriminators = new Map<string, string>();

  /**
   * asset -> the asset its `/Parent` names, when one exists.
   *
   * The discriminator is inheritable. `Weapon_Sword_Primary_Swing_Left_Damage`
   * declares only `Parent: "DamageEntityParent"`; the `Type: "DamageEntity"` that
   * says which union branch it is lives in that parent. 152 of 1 341 Interaction
   * assets are shaped this way, so their fields never reached a branch namespace
   * and `common:DamageEntityInteraction/Parent` -- the primary inheritance
   * mechanism of every weapon in the game -- was reported as used by nobody.
   */
  const parentOf = new Map<number, number>();
  for (const row of db
    .prepare(
      `SELECT c.asset_id, p.id AS parent_id
         FROM candidates c
         JOIN assets self ON self.id = c.asset_id
         JOIN assets p ON p.logical_id = c.raw_value AND p.type IS self.type
        WHERE c.json_pointer = '/Parent' AND c.value_kind = 'string' AND p.id <> c.asset_id`,
    )
    .all() as unknown as { asset_id: number; parent_id: number }[]) {
    parentOf.set(row.asset_id, row.parent_id);
  }
  for (const property of properties) {
    for (const row of db
      .prepare(
        "SELECT asset_id, json_pointer, raw_value FROM candidates" +
          " WHERE value_kind = 'string' AND json_pointer LIKE '%/' || ?",
      )
      .all(property) as unknown as {
      asset_id: number;
      json_pointer: string;
      raw_value: string;
    }[]) {
      discriminators.set(discriminatorKey(row.asset_id, row.json_pointer), row.raw_value);
    }
  }

  /**
   * Walks a pointer, substituting wildcards for dynamic map keys and **switching
   * namespace** whenever it crosses a `$ref`.
   *
   * `Item` + `/BlockType/Gathering/Breaking/GatherType` becomes
   * `BlockType` + `/Gathering/Breaking/GatherType`, because `Item./BlockType` is a
   * ref rather than a container. Without the switch the tail matches nothing:
   * only 819 of 10,501 observed pointers joined.
   */
  /**
   * The discriminator at a position, following `/Parent` when the asset itself
   * is silent.
   *
   * Bounded by the chain length so a cycle in the corpus cannot hang the pass;
   * inheritance in this corpus is at most a few links deep.
   */
  const discriminatorFor = (assetId: number, pointer: string, property: string): string | undefined => {
    let at: number | undefined = assetId;
    for (let hops = 0; at !== undefined && hops < 8; hops++) {
      const found = discriminators.get(discriminatorKey(at, `${pointer}/${property}`));
      if (found !== undefined) return found;
      at = parentOf.get(at);
    }
    return undefined;
  };

  let resolvedUnions = 0;
  let unresolvedUnions = 0;

  const align = (
    startType: string,
    pointer: string,
    rawPointer: string,
    assetId: number,
  ): { type: string; pointer: string } => {
    let type = startType;

    // The asset's own type may itself be a pure union -- a file that IS an
    // Interaction lands on a namespace declaring nothing but 102 branches. Resolve
    // it before walking, from the document's own root discriminator, or 5 000-odd
    // observations sit on a namespace with no fields to join to.
    const startBranches = unionBranches.get(`${type}|`);
    if (startBranches !== undefined) {
      const discriminator = discriminatorFor(assetId, "", discriminatorAt.get(`${type}|`) ?? "Type");
      const branch =
        discriminator === undefined ? undefined : selectBranch(startBranches, discriminator);
      if (branch !== undefined && byType.has(branch)) {
        resolvedUnions++;
        type = branch;
      } else {
        unresolvedUnions++;
      }
    }

    let prefix = "";
    let pointers = byType.get(type);

    const segments = pointer.split("/").slice(1);
    // Same segment count by construction: the schema pointer is the raw one with
    // array indices replaced by `*`.
    const rawSegments = rawPointer.split("/").slice(1);
    let rawPrefix = "";

    for (let i = 0; i < segments.length; i++) {
      if (pointers === undefined) break;
      const segment = segments[i]!;

      const literal = `${prefix}/${segment}`;
      const wildcard = `${prefix}/*`;
      const next = pointers.has(literal)
        ? literal
        : pointers.has(wildcard)
          ? wildcard
          : literal;
      const rawNext = `${rawPrefix}/${rawSegments[i] ?? segment}`;

      let scope = refScopes.get(`${type}|${next}`);

      // A polymorphic crossing cannot be rebased from the pointer alone: which
      // branch applies is decided by a discriminator in the *data*. Blindly
      // following the first branch attributed 2,732 observations to
      // `common:ChoiceItemDropContainer./Item/ItemId` -- a field that definition
      // does not have.
      //
      // The sibling `Type` decides it, and the generator's naming makes the map
      // mechanical: `Type: "Fixed"` selects the branch named `FixedTradeSlot`.
      // Where the discriminator is missing or names no branch we stay put rather
      // than guess.
      if (scope === undefined) {
        const branches = unionBranches.get(`${type}|${next}`);
        if (branches !== undefined) {
          const discriminator = discriminatorFor(
            assetId,
            rawNext,
            discriminatorAt.get(`${type}|${next}`) ?? "Type",
          );
          const branch =
            discriminator === undefined ? undefined : selectBranch(branches, discriminator);
          if (branch === undefined) {
            unresolvedUnions++;
            prefix = next;
            rawPrefix = rawNext;
            continue;
          }
          resolvedUnions++;
          scope = branch;
        }
      }

      // Only step into the target namespace when there is something left to
      // consume. A ref crossed on the LAST segment means the value sits at the
      // reference field itself, not inside what it points to -- crossing anyway
      // produced 1,868 rows attributed to `RootInteraction` with an empty
      // pointer, which is not a field at all.
      if (scope !== undefined && byType.has(scope) && i < segments.length - 1) {
        type = scope;
        // A namespace may be nothing but a union: Interaction.json is `anyOf`
        // over 102 concrete definitions and declares no field of its own, so
        // landing there is not the end of the journey. Take the second hop with
        // the discriminator sitting at this same position in the data.
        const rootBranches = unionBranches.get(`${type}|`);
        if (rootBranches !== undefined) {
          const discriminator = discriminatorFor(
            assetId,
            rawNext,
            discriminatorAt.get(`${type}|`) ?? "Type",
          );
          const branch =
            discriminator === undefined ? undefined : selectBranch(rootBranches, discriminator);
          if (branch !== undefined && byType.has(branch)) {
            resolvedUnions++;
            type = branch;
          } else {
            unresolvedUnions++;
          }
        }
        pointers = byType.get(type);
        prefix = "";
        rawPrefix = rawNext;
        continue;
      }
      prefix = next;
      rawPrefix = rawNext;
    }
    return { type, pointer: prefix };
  };

  const rows = db
    .prepare(
      `SELECT c.id, c.schema_pointer, c.json_pointer, c.asset_id, a.type
         FROM candidates c JOIN assets a ON a.id = c.asset_id
        WHERE a.type IS NOT NULL`,
    )
    .all() as unknown as {
    id: number;
    schema_pointer: string;
    json_pointer: string;
    asset_id: number;
    type: string;
  }[];

  const update = db.prepare(
    "UPDATE candidates SET schema_pointer = ?, schema_scope = ? WHERE id = ?",
  );
  let changed = 0;
  for (const row of rows) {
    if (byType.get(row.type) === undefined) continue;
    const aligned = align(row.type, row.schema_pointer, row.json_pointer, row.asset_id);
    update.run(aligned.pointer, aligned.type, row.id);
    if (aligned.pointer !== row.schema_pointer || aligned.type !== row.type) changed++;
  }
  return { changed, resolvedUnions, unresolvedUnions };
}

export function computeFieldStats(db: Database): StatsResult {
  const started = Date.now();

  // Built here rather than declared with the table: the edge post-processing
  // below correlates every edge with the candidate that produced it on exactly
  // this pair, and without it the passes never finish -- but carrying it through
  // 479 000 inserts is worse, and stalled the build outright.
  db.exec("CREATE INDEX IF NOT EXISTS idx_candidates_asset_ptr ON candidates (asset_id, json_pointer)");

  db.exec("BEGIN");
  try {
    const normalised = normalisePointersAgainstSchema(db);
    db.exec("DELETE FROM field_stats");

    // Per (type, pointer): how often it appears, across how many assets, how many
    // distinct values, and a sample. Candidates already exclude the voxel roots,
    // so worldgen cannot dominate the statistics.
    db.exec(`
      INSERT INTO field_stats
        (asset_type, json_pointer, count, of_total, value_types, target_types, cardinality)
      SELECT
        c.schema_scope,
        c.schema_pointer,
        count(*)                                   AS count,
        count(DISTINCT c.asset_id)                 AS of_total,
        NULL,
        NULL,
        count(DISTINCT c.raw_value)                AS cardinality
      FROM candidates c
      JOIN assets a ON a.id = c.asset_id
      WHERE c.schema_scope IS NOT NULL
      GROUP BY c.schema_scope, c.schema_pointer
    `);

    // Which asset types a pointer actually resolves to, from the edges pass 2
    // built. This is the observed counterpart of schema_fields.reference_target:
    // where both exist they should agree, and where they disagree that is a
    // finding rather than a bug.
    db.exec(`
      UPDATE field_stats SET target_types = (
        -- The shared encoding, like the other two value columns. This one was
        -- left space-joined, and when the tolerant space fallback was removed
        -- from the reader it began decoding as ONE type: the API returned
        -- ["ItemPlayerAnimations ParticleSystem"], a string that is not an
        -- asset type. Two encodings for one decoder is the bug, not the split.
        SELECT group_concat(t, ${VALUE_SEP_SQL}) FROM (
          SELECT DISTINCT d.type AS t
            FROM candidates c
            JOIN assets s ON s.id = c.asset_id
            JOIN edges e ON e.src = c.asset_id
                        AND e.json_pointer = c.json_pointer
                        AND e.dst_kind = 'asset'
            JOIN assets d ON d.id = e.dst
           WHERE s.type = field_stats.asset_type
             AND c.schema_pointer = field_stats.json_pointer
             AND d.type IS NOT NULL
           LIMIT 8))
      WHERE EXISTS (
        SELECT 1 FROM schema_fields sf
         WHERE sf.asset_type = field_stats.asset_type
           AND sf.json_pointer = field_stats.json_pointer
           AND sf.reference_target IS NOT NULL)
    `);

    // Values on the observed row itself, so an UNDECLARED field can still say
    // what it holds. Without this, describe reported common:BenchRequirement./Set
    // as used by 69 assets and could say nothing more about it -- the reader is
    // left knowing a field exists and having no way to learn what goes in it.
    db.exec(`
      UPDATE field_stats
         SET observed_values = (
               SELECT group_concat(v, ${VALUE_SEP_SQL}) FROM (
                 SELECT DISTINCT c.raw_value AS v
                   FROM candidates c
                  WHERE c.schema_scope = field_stats.asset_type
                    AND c.schema_pointer = field_stats.json_pointer
                  ORDER BY c.raw_value
                  LIMIT ${ENUM_MAX_CARDINALITY}))
       WHERE cardinality BETWEEN 1 AND ${ENUM_MAX_CARDINALITY}
    `);

    // Observed enumerations: low distinct-value count over enough occurrences.
    // Stored on schema_fields so describe_schema reads one row per field, with
    // the source marked -- an inferred enum must never be presented as the
    // complete legal set the way a declared one can be.
    db.exec(`
      UPDATE schema_fields
         SET observed_values = (
               SELECT group_concat(v, ${VALUE_SEP_SQL}) FROM (
                 SELECT DISTINCT c.raw_value AS v
                   FROM candidates c
                   JOIN assets a ON a.id = c.asset_id
                  WHERE c.schema_scope = schema_fields.asset_type AND c.schema_pointer = schema_fields.json_pointer
                  ORDER BY c.raw_value
                  LIMIT ${ENUM_MAX_CARDINALITY}))
       WHERE enum_values IS NULL
         AND EXISTS (
               SELECT 1 FROM field_stats fs
                WHERE fs.asset_type = schema_fields.asset_type
                  AND fs.json_pointer = schema_fields.json_pointer
                  AND fs.cardinality BETWEEN 1 AND ${ENUM_MAX_CARDINALITY}
                  AND fs.count >= ${ENUM_MIN_OCCURRENCES})
    `);

    // Promote references the schema declares, now that pointers are rebased.
    //
    // Confidence is decided in pass 2, before this pass rewrites pointers across
    // `$ref` boundaries -- so a declared reference reached through one could never
    // qualify. `Item./BlockType/PhysicalMaterialId` is declared
    // `-> PhysicalMaterial` and used by 1 547 assets, yet every edge from it was
    // labelled `medium` ("the field name follows a convention"), contradicting
    // what `describe` said about the very same field.
    //
    // The condition is the same one pass 2 uses; only the pointer it joins on has
    // improved.
    db.exec(`
      UPDATE edges SET confidence = 'high'
       WHERE kind = 'REFERENCES' AND confidence <> 'high'
         AND EXISTS (
               SELECT 1
                 FROM candidates c
                 JOIN schema_fields sf
                       ON sf.asset_type = c.schema_scope
                      AND sf.json_pointer = c.schema_pointer
                      AND sf.reference_target IS NOT NULL
                 JOIN assets d ON d.id = edges.dst AND d.type = sf.reference_target
                WHERE c.asset_id = edges.src
                  AND c.json_pointer = edges.json_pointer)
    `);

    // Drop heuristic edges the schema contradicts.
    //
    // Pass 2 excludes declared fields from the heuristic tier, but it joins on the
    // UN-rebased pointer, so a reference reached through a `$ref` was invisible to
    // that guard and got an edge to every same-named asset. `Rock_Stone_Cobble`
    // therefore pointed at both the ResourceType it declares and an unrelated Item
    // of the same name, and `refs --type` looked like a no-op on the lower tiers
    // because those rows were identical whichever target was asked about.
    //
    // The schema names one target type. Anything else at that pointer is a name
    // collision, not a weak reference.
    //
    // Declared but unverified: raise to medium.
    //
    // Three tiers, one rule each:
    //   high   the schema declares the target type AND the destination has it
    //   medium the schema declares the field is a reference, but the destination
    //          type does not match, or the field name follows a convention
    //   low    neither -- the value merely collides with an identifier
    //
    // The middle tier exists because a declared target type is often unusable in
    // practice: BlockTypeToPlace declares -> BlockType, and exactly one asset of
    // 35 074 has that type, while thousands of blocks are Items carrying an
    // embedded BlockType. Seed_Place, which literally places Rock_Stone, was
    // therefore labelled "often coincidence".
    //
    // An earlier attempt DEMOTED such edges instead, on the reasoning that a type
    // mismatch means a name collision. That was a regression: it buried real
    // references, and one round of review introduced it while the next found it.
    // The schema saying a field IS a reference outranks any name heuristic; it
    // simply does not outrank a verified one.
    db.exec(`
      UPDATE edges SET confidence = 'medium'
       WHERE kind = 'REFERENCES' AND confidence = 'low'
         AND EXISTS (
               SELECT 1 FROM candidates c
                 JOIN schema_fields sf
                       ON sf.asset_type = c.schema_scope
                      AND sf.json_pointer = c.schema_pointer
                      AND sf.reference_target IS NOT NULL
                WHERE c.asset_id = edges.src AND c.json_pointer = edges.json_pointer)
    `);

    // A Parent nested inside an inline object is inheritance, not a name
    // collision.
    //
    // Only the top-level `/Parent` was treated as such, so
    // `Tool_Sickle_Copper` overriding a selector through
    // `/InteractionVars/Swing_Left_Selector/Interactions/0/Parent`, and
    // `Block_Explosion` through `/Next/Interactions/0/Parent`, came out `low` --
    // the tier whose legend says 'often coincidence'. Two blind trials caught
    // one command printing `high` and `low` for the same mechanism, differing
    // only in depth.
    //
    // It has to happen HERE rather than in pass 2: `schema_scope` is assigned
    // by the alignment above, so in pass 2 the test matches nothing at all --
    // which is exactly what the first attempt did, silently.
    //
    // The type test cannot be the containing asset's type: an Item holds an
    // inline Interaction. It is 'the destination's type is a root union that
    // declares this candidate's own scope as a branch', which is what makes the
    // inline object that type in the first place.
    db.exec(`
      UPDATE edges SET kind = 'INHERITS_FROM', confidence = 'high'
       WHERE kind = 'REFERENCES'
         AND json_pointer LIKE '%/Parent' AND json_pointer <> '/Parent'
         AND EXISTS (
               SELECT 1 FROM candidates c
                 JOIN assets d ON d.id = edges.dst
                 JOIN schema_fields r
                       ON r.json_pointer = '' AND r.ref_scope IS NOT NULL
                      AND r.asset_type = d.type
                      AND ' ' || r.ref_scope || ' ' LIKE '% ' || c.schema_scope || ' %'
                WHERE c.asset_id = edges.src
                  AND c.json_pointer = edges.json_pointer
                  AND c.schema_scope IS NOT NULL)
    `);

    // A declared reference that resolves to nothing.
    //
    // Pass 2 ran this joined on `schema_pointer`, which pass 3 only fills in
    // above -- the same trap the nested-Parent rule fell into -- so it marked
    // one row. Joined on the aligned scope it finds 2 674 occurrences: 2 175 of
    // `Item./Categories/*` naming an ItemCategory that does not exist, 256 of
    // `BlockType./HitboxType` naming a BlockBoundingBoxes called 'Full'.
    //
    // These are the findings `validate` will report. Recorded now so the data
    // exists before the command does.
    db.exec(`
      UPDATE candidates SET dangling = 2
       WHERE value_kind = 'string'
         AND schema_scope IS NOT NULL
         AND lower(raw_value) NOT IN ('none','default','null','true','false','any','all')
         AND EXISTS (SELECT 1 FROM schema_fields sf
                      WHERE sf.asset_type = candidates.schema_scope
                        AND sf.json_pointer = candidates.schema_pointer
                        AND sf.reference_target IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM assets a
                                         WHERE a.logical_id = candidates.raw_value
                                           AND a.type = sf.reference_target))
    `);

    const one = (sql: string): number =>
      (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;

    const result: StatsResult = {
      rows: one("SELECT count(*) AS n FROM field_stats"),
      typesCovered: one("SELECT count(DISTINCT asset_type) AS n FROM field_stats"),
      enumCandidates: one("SELECT count(*) AS n FROM schema_fields WHERE observed_values IS NOT NULL"),
      // Declared but never used: the input to find_undocumented.
      //
      // Containers are excluded. Candidates are string scalars only, so an object
      // or array pointer can never appear in field_stats however heavily it is
      // used -- counting them made 95% of the schema look unused when the real
      // figure is far smaller.
      schemaOnlyFields: one(`
        SELECT count(*) AS n FROM schema_fields sf
         WHERE ifnull(sf.declared_type,'') NOT IN ('object','array','anyOf','oneOf')
           AND ifnull(sf.declared_type,'') NOT LIKE '%object%'
           AND ifnull(sf.declared_type,'') NOT LIKE '%array%'
           AND NOT EXISTS (SELECT 1 FROM field_stats fs
                            WHERE fs.asset_type = sf.asset_type
                              AND fs.json_pointer = sf.json_pointer)`),
      // Used but never declared: either our pointer normalisation is wrong, or the
      // corpus carries fields the schema does not describe. Both are worth seeing.
      undeclaredFields: one(`
        SELECT count(*) AS n FROM field_stats fs
         WHERE NOT EXISTS (SELECT 1 FROM schema_fields sf
                            WHERE sf.asset_type = fs.asset_type
                              AND sf.json_pointer = fs.json_pointer)`),
      resolvedUnions: normalised.resolvedUnions,
      unresolvedUnions: normalised.unresolvedUnions,
      elapsedMs: Date.now() - started,
    };

    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
