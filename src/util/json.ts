import { readFileSync } from "node:fs";

/**
 * Tolerant JSON reading for the game's generated schemas.
 *
 * `--generate-asset-schema` emits bare `NaN` where a codec's default is a
 * non-finite number, which `JSON.parse` rejects. On the release patchline this is
 * three occurrences in `common.json`, all in one place:
 *
 * ```
 * "Normal": { "default": { "X": NaN, "Y": NaN, "Z": NaN } }
 * ```
 *
 * i.e. "this vector has no meaningful default". `Infinity` does not currently
 * appear but is the same class of defect and is handled.
 *
 * **Why not a regex.** The obvious fix — replacing `/(?<=[:\[,\s])(NaN|Infinity)/`
 * — happens to work on this input, but the same corpus contains **640 occurrences
 * of these words inside string literals** (field descriptions are prose). One
 * description reading `... the value NaN, which ...` would be silently corrupted
 * into `... the value null, which ...`. The scanner below tracks string state, so
 * it cannot make that mistake.
 *
 * Repairs are reported rather than applied silently: a `default` that was `NaN`
 * means *unset*, which is a more useful thing to tell a pack author than
 * `default: null`.
 */

export type NonFiniteToken = "NaN" | "Infinity" | "-Infinity";

export interface Repair {
  /** RFC 6901 JSON Pointer to the repaired value. */
  readonly pointer: string;
  readonly token: NonFiniteToken;
}

export interface LenientParseResult<T> {
  readonly value: T;
  /** Empty when the input was already valid JSON. */
  readonly repairs: readonly Repair[];
}

/**
 * Marker substituted for a non-finite literal so the document can be parsed, then
 * walked to recover exact locations. Chosen to be something no real schema string
 * would contain; a collision is checked for rather than assumed.
 */
const SENTINEL_PREFIX = "hytale-atlas:nonfinite:";
const SENTINEL_SUFFIX = "";

const TOKENS: readonly NonFiniteToken[] = ["-Infinity", "Infinity", "NaN"];

function isIdentifierChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Rewrites bare non-finite literals to sentinel strings, skipping anything inside
 * a string literal. Returns null when there was nothing to rewrite.
 */
function substituteNonFinite(text: string): string | null {
  let out: string[] | null = null;
  let last = 0;
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    // Only `-`, `I` and `N` can begin one of the tokens; skip the rest cheaply.
    if (ch === "-" || ch === "I" || ch === "N") {
      const match = TOKENS.find((t) => text.startsWith(t, i));
      if (match !== undefined && !isIdentifierChar(text[i + match.length])) {
        out ??= [];
        out.push(text.slice(last, i));
        out.push(JSON.stringify(SENTINEL_PREFIX + match + SENTINEL_SUFFIX));
        i += match.length;
        last = i;
        continue;
      }
    }
    i++;
  }

  if (out === null) return null;
  out.push(text.slice(last));
  return out.join("");
}

function readSentinel(value: unknown): NonFiniteToken | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith(SENTINEL_PREFIX) || !value.endsWith(SENTINEL_SUFFIX)) return null;
  const token = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length);
  return (TOKENS as readonly string[]).includes(token) ? (token as NonFiniteToken) : null;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Replaces sentinels with null in place, recording where each one was. */
function collectRepairs(node: unknown, pointer: string, repairs: Repair[]): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = collectRepairs(node[i], `${pointer}/${i}`, repairs);
    }
    return node;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = collectRepairs(obj[key], `${pointer}/${escapePointerSegment(key)}`, repairs);
    }
    return obj;
  }
  const token = readSentinel(node);
  if (token !== null) {
    repairs.push({ pointer, token });
    return null;
  }
  return node;
}

/**
 * Parses JSON, tolerating bare `NaN`, `Infinity` and `-Infinity`.
 *
 * Valid input takes a fast path with no scanning — which is what almost all input
 * is, and the affected file is ~7 MB, so this is worth the branch.
 *
 * @param source label used in error messages, e.g. the file path
 * @throws SyntaxError if the document is malformed for any other reason
 */
export function parseJsonLenient<T = unknown>(
  text: string,
  source = "<input>",
): LenientParseResult<T> {
  try {
    return { value: JSON.parse(text) as T, repairs: [] };
  } catch (firstError) {
    const substituted = substituteNonFinite(text);
    if (substituted === null) {
      throw new SyntaxError(
        `${source}: invalid JSON and no non-finite literals to repair — ` +
          `${(firstError as Error).message}`,
      );
    }
    if (text.includes(SENTINEL_PREFIX)) {
      throw new SyntaxError(
        `${source}: input already contains the repair sentinel; refusing to guess`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(substituted);
    } catch (secondError) {
      throw new SyntaxError(
        `${source}: still invalid after repairing non-finite literals — ` +
          `${(secondError as Error).message}`,
      );
    }

    const repairs: Repair[] = [];
    const value = collectRepairs(parsed, "", repairs) as T;
    return { value, repairs };
  }
}

/** Convenience wrapper over {@link parseJsonLenient} for a file on disk. */
export function readJsonFileLenient<T = unknown>(path: string): LenientParseResult<T> {
  return parseJsonLenient<T>(readFileSync(path, "utf8"), path);
}

/**
 * True when a repair sits on a schema `default`, i.e. the field has no meaningful
 * default rather than a default of null. Callers rendering `describe_schema`
 * should say "unset" for these.
 */
export function isUnsetDefault(repair: Repair): boolean {
  return /\/default(\/|$)/.test(repair.pointer);
}

/**
 * Escapes one JSON Pointer segment (RFC 6901): `~` becomes `~0`, `/` becomes `~1`.
 *
 * Was copied verbatim into three modules -- the asset resolver, the reference
 * indexer and the schema reader -- which is three chances for a pointer written
 * one way and read another. Small enough that nobody minded; exactly the size at
 * which a divergence goes unnoticed.
 */
export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
