import type { Database } from "../db/open.ts";
import { setMeta } from "../db/open.ts";
import type { AssetTypeInfo, GeneratedSchemaSet } from "../sources/schema-doc.ts";
import { expandIdentifiers, normalizeSearchText } from "../util/text.ts";

/**
 * Writes the generated schema into the index, and derives the path - type map
 * that pass 1 needs.
 */

export interface SchemaIngestResult {
  readonly types: number;
  readonly fields: number;
  readonly definitions: number;
  readonly ftsRows: number;
  readonly prefixes: number;
}

/**
 * Maps a corpus path to an asset type.
 *
 * Built from the `.vscode/settings.json` globs rather than from `hytale.path`,
 * because the globs carry the pack root (`/Server/Audio/AmbienceFX/**-/*.json`)
 * while `hytale.path` is root-relative (`Audio/AmbienceFX`) and would leave us
 * guessing which root it hangs from.
 *
 * Longest prefix wins: `Server/Item/Items` and `Server/Item/Groups` are distinct
 * types under a shared parent, and a shortest-match rule would collapse them.
 */
export class TypeResolver {
  /** Sorted longest-first so the first match is the most specific. */
  readonly #prefixes: readonly { prefix: string; suffix: string | null; type: string }[];

  constructor(types: readonly AssetTypeInfo[]) {
    const prefixes: { prefix: string; suffix: string | null; type: string }[] = [];
    const seen = new Set<string>();

    /**
     * Dedup key for a (path prefix, type) pair.
     *
     * A named helper rather than an inline template literal: this key was built
     * with a raw control character as its separator, which reads as a plain space
     * in every editor. The identical construction in `stats.ts` was later half-
     * edited to use an actual space on one side, and every lookup missed while
     * both maps were correctly populated.
     */
    const prefixKey = (prefix: string, typeId: string): string => `${prefix} ${typeId}`;

    for (const type of types) {
      // Path alone does not identify a type. ParticleSystem and ParticleSpawner
      // both live under Server/Particles/ and differ only by suffix. Matching on
      // prefix alone gave one of them all 2,344 files and the other none, which
      // then made every reference to a particle system look like a broken one.
      const suffix =
        type.fileExtension !== null && type.fileExtension !== ".json"
          ? type.fileExtension
          : null;

      for (const glob of type.fileMatch) {
        const prefix = globToPrefix(glob);
        if (prefix === null) continue;
        const key = prefixKey(prefix, type.id);
        if (seen.has(key)) continue;
        seen.add(key);
        prefixes.push({ prefix, suffix, type: type.id });
      }
      // Fall back to hytale.path under the two known roots when a type has no
      // glob binding - 102 of 102 had one on the release patchline, but the
      // bindings file is written separately and could go missing.
      if (type.fileMatch.length === 0 && type.schemaPath !== null) {
        for (const root of ["Server/", "Common/"]) {
          const prefix = `${root}${type.schemaPath}/`;
          const key = prefixKey(prefix, type.id);
          if (seen.has(key)) continue;
          seen.add(key);
          prefixes.push({ prefix, suffix, type: type.id });
        }
      }
    }

    // Suffix-qualified entries first, then longest path: a type identified by
    // both path and suffix is strictly more specific than one identified by path
    // alone, however the path lengths compare.
    prefixes.sort((a, b) => {
      const bySuffix = Number(b.suffix !== null) - Number(a.suffix !== null);
      return bySuffix !== 0 ? bySuffix : b.prefix.length - a.prefix.length;
    });
    this.#prefixes = prefixes;
  }

  get size(): number {
    return this.#prefixes.length;
  }

  resolve(path: string): string | null {
    for (const { prefix, suffix, type } of this.#prefixes) {
      if (!path.startsWith(prefix)) continue;
      if (suffix !== null && !path.endsWith(suffix)) continue;
      return type;
    }
    return null;
  }
}

/**
 * File suffixes that hold an asset document, from the schema's own declarations.
 *
 * **Not all assets are `.json`.** The release schema declares three types with
 * other suffixes, all of which contain JSON regardless of what they are called:
 *
 * | Type | Suffix | Files |
 * |---|---|---|
 * | `ParticleSpawner` | `.particlespawner` | 1 744 |
 * | `ParticleSystem` | `.particlesystem` | 598 |
 * | `InstanceConfig` | `instance.bson` | 33 |
 *
 * Filtering the walk on `.json` skipped 2 375 assets. `ParticleSystem` is itself
 * the declared target of 31 reference fields, so every reference to a particle
 * effect resolved to nothing.
 */
export function assetSuffixes(types: readonly AssetTypeInfo[]): string[] {
  const suffixes = new Set<string>([".json"]);
  for (const type of types) {
    if (type.fileExtension !== null && type.fileExtension.length > 0) {
      suffixes.add(type.fileExtension);
    }
  }
  return [...suffixes];
}

/**
 * `/Server/Audio/AmbienceFX/**-/*.json` - `Server/Audio/AmbienceFX/`.
 * Returns null for a glob with no literal directory prefix.
 */
function globToPrefix(glob: string): string | null {
  const withoutLeadingSlash = glob.startsWith("/") ? glob.slice(1) : glob;
  const wildcard = withoutLeadingSlash.search(/[*?]/);
  const literal = wildcard < 0 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, wildcard);
  const lastSlash = literal.lastIndexOf("/");
  if (lastSlash < 0) return null;
  return literal.slice(0, lastSlash + 1);
}

export function ingestSchemas(db: Database, set: GeneratedSchemaSet): SchemaIngestResult {
  db.exec("BEGIN");
  try {
    const insType = db.prepare(
      "INSERT INTO asset_types (id, schema_path, file_extension, source) VALUES (?,?,?,'codec')" +
        " ON CONFLICT (id) DO UPDATE SET schema_path = excluded.schema_path," +
        " file_extension = excluded.file_extension, source = 'codec'",
    );
    for (const type of set.types) {
      insType.run(type.id, type.schemaPath, type.fileExtension);
    }

    const insField = db.prepare(
      `INSERT INTO schema_fields
         (asset_type, json_pointer, declared_type, optional, default_value, default_unset,
          enum_values, title, description, reference_target, ref_scope, inherits_property, merges_properties,
          type_constant, discriminator_property, discriminator_values)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (asset_type, json_pointer) DO UPDATE SET
         declared_type = excluded.declared_type, optional = excluded.optional,
         default_value = excluded.default_value, default_unset = excluded.default_unset,
         enum_values = excluded.enum_values, title = excluded.title,
         description = excluded.description,
         reference_target = excluded.reference_target,
         ref_scope = excluded.ref_scope,
         inherits_property = excluded.inherits_property,
         merges_properties = excluded.merges_properties,
         type_constant = excluded.type_constant,
         discriminator_property = excluded.discriminator_property,
         discriminator_values = excluded.discriminator_values`,
    );
    const insFts = db.prepare(
      "INSERT INTO schema_fts (asset_type, json_pointer, terms, title, description, enum_values)" +
        " VALUES (?,?,?,?,?,?)",
    );

    db.exec("DELETE FROM schema_fts");
    let ftsRows = 0;

    for (const field of set.fields) {
      const enumValues = field.enumValues === null ? null : field.enumValues.join(" ");
      insField.run(
        field.assetType,
        field.pointer,
        field.declaredType,
        field.optional ? 1 : 0,
        field.defaultValue,
        field.defaultUnset ? 1 : 0,
        enumValues,
        field.title,
        field.description,
        field.referenceTarget,
        field.refScope,
        field.inheritsProperty ? 1 : 0,
        field.mergesProperties ? 1 : 0,
        field.typeConstant,
        field.discriminatorProperty,
        field.discriminatorValues,
      );

      // Every field, not only those carrying prose. Restricting to documented
      // fields indexed 7 464 of 17 400 and made `search-schema GatherType` report
      // that nothing declares the capability -- while `describe` printed the field
      // and its 14 observed values.
      insFts.run(
        field.assetType,
        field.pointer,
        normalizeSearchText(expandIdentifiers(`${field.assetType} ${field.pointer}`)),
        normalizeSearchText(field.title ?? ""),
        normalizeSearchText(field.description ?? ""),
        normalizeSearchText(enumValues ?? ""),
      );
      ftsRows++;
    }

    const insDef = db.prepare(
      "INSERT INTO schema_defs (source_file, name, body) VALUES (?,?,?)" +
        " ON CONFLICT (source_file, name) DO UPDATE SET body = excluded.body",
    );
    for (const def of set.definitions) {
      insDef.run(def.sourceFile, def.name, def.body);
    }

    setMeta(db, "schema_types", String(set.types.length));
    setMeta(db, "schema_fields", String(set.fields.length));
    db.exec("COMMIT");

    return {
      types: set.types.length,
      fields: set.fields.length,
      definitions: set.definitions.length,
      ftsRows,
      prefixes: new TypeResolver(set.types).size,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Assigns `assets.type` from the resolver, for assets indexed before it existed. */
export function applyTypes(db: Database, resolver: TypeResolver): number {
  const rows = db.prepare("SELECT id, path FROM assets WHERE type IS NULL").all() as {
    id: number;
    path: string;
  }[];

  const update = db.prepare("UPDATE assets SET type = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    let assigned = 0;
    for (const row of rows) {
      const type = resolver.resolve(row.path);
      if (type !== null) {
        update.run(type, row.id);
        assigned++;
      }
    }
    db.exec("COMMIT");
    return assigned;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
