/**
 * Encoding for the value lists stored in a single column.
 *
 * `enum_values` and `observed_values` hold a list inside one TEXT column, and
 * the list used to be joined and split on a **space**. Values that contain
 * spaces are shredded by that: `describe ScriptedBrushAsset --field Description`
 * rendered two whole sentences as 25 comma-separated tokens --
 * `Example:, Places, water, only, where, ...` -- which reads as an enum of legal
 * values rather than as prose.
 *
 * This is the third delimiter bug in the project and the second of exactly this
 * shape. The discriminator map was once keyed with `\0` on the write side and a
 * space on the read side, and all 21 439 lookups missed in silence. The fix then
 * was a named builder used by both sides, and it is the fix here: the separator
 * is never written literally at a call site, and the SQL form sits next to the
 * TypeScript form so the two cannot drift.
 */

/**
 * ASCII unit separator: cannot occur in JSON string content the game ships.
 *
 * Written as an escape on purpose. The literal character is invisible in an
 * editor, in grep output and in a diff -- which is how the earlier separator
 * bug survived review, and how a sentinel constant in this project once sat in
 * the source as a bare control character nobody could see.
 */
export const VALUE_SEP = "\u001f";

/** The same separator for a `group_concat`, spelled so it stays visible. */
export const VALUE_SEP_SQL = "char(31)";

export function joinValues(values: readonly string[]): string | null {
  return values.length === 0 ? null : values.join(VALUE_SEP);
}

/**
 * Splits a stored list.
 *
 * No space fallback. A one-element list has no separator in it by
 * construction, so a tolerant reader could not tell `"the Crossroads"` -- one
 * value -- from two values joined the old way, and split it: `describe
 * InstanceConfig --field DisplayName` printed `seen: the, Crossroads`. The new
 * encoding round-tripped 2+ values correctly and mangled exactly the case it
 * was written to fix.
 *
 * The tolerance is unnecessary anyway: `SCHEMA_VERSION` gates the file, and a
 * database written by an older version is rejected at open rather than read.
 * Guessing at an encoding the version already tells us is how the ambiguity
 * got in.
 */
export function splitValues(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parts = value.split(VALUE_SEP).filter(Boolean);
  return parts.length === 0 ? null : parts;
}
