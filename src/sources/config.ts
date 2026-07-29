import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

/**
 * `hytale-atlas.json` -- what a directory says about which sources to index.
 *
 * The tool is meant to be run with `npx` inside a pack or plugin project, and
 * detection alone cannot answer everything it needs: which install to read when
 * several patchlines are present, where a relocated Assets.zip lives, and --
 * the reason this file exists now -- **which third-party packs take part in the
 * index**. Mods are not discoverable from the game directory alone: a plugin jar
 * carrying assets sits in `UserData/Mods` beside jars that carry none, and a pack
 * a modder is developing sits nowhere near the install at all.
 *
 * Three rules, each a lesson this project already paid for:
 *
 * 1. **A typo must not be silence.** An unknown key is reported, not ignored.
 *    The whole defect history here is answers that were quietly wrong; a config
 *    that drops `assetsZip` because the field is called `assets` would be the
 *    same failure in a new place.
 * 2. **A path that does not exist is reported, not dropped.** Otherwise "no mods
 *    were indexed" reads as "you have no mods".
 * 3. **Relative paths resolve against the CONFIG FILE, not the cwd.** A config
 *    committed to a repository has to mean the same thing from any directory.
 */

export interface ModSources {
  /** A directory to scan for packs. Every `.jar`/`.zip` in it is a candidate. */
  readonly dir: string | null;
  /** Individual archives or unpacked pack directories, added explicitly. */
  readonly include: readonly string[];
  /** Filenames to skip, matched case-insensitively with `*` as a wildcard. */
  readonly exclude: readonly string[];
}

export interface AtlasConfig {
  /** Absolute path of the file this came from, or null when there is none. */
  readonly path: string | null;
  readonly assets: string | null;
  readonly serverJar: string | null;
  readonly patchline: string | null;
  /**
   * Directory of generated asset schemas -- what `generate-schema` produced.
   *
   * Belongs here because it is the field the relative default gets wrong the
   * moment the tool is run from somewhere else: `local/schema-release` resolved
   * against the CWD, so indexing from a pack directory silently produced a
   * tier-1 index with every asset untyped, and said so in one line among twenty.
   */
  readonly schema: string | null;
  /**
   * Where to keep the built index. Null means the per-user cache directory.
   *
   * Worth overriding for a shared build machine, a fast scratch disk, or simply
   * to keep a project's index beside the project. The path is part of no cache
   * key: moving the directory does not invalidate anything, it just relocates it.
   */
  readonly cacheDir: string | null;
  readonly mods: ModSources;
  /**
   * Standing answer to the one prompt that guards code execution.
   *
   * There is exactly one, on purpose. Indexing mod assets reads archives and
   * runs nothing, so it asks for no consent at all -- a prompt that guards
   * nothing teaches people to click through the prompt that guards something.
   * This flag covers only the case where the game server LOADS mod plugins and
   * their Java executes with the user's privileges.
   */
  readonly consent: {
    /** Let the server LOAD mod plugins during schema generation. Code runs. */
    readonly runModPlugins: boolean;
  };
  /**
   * Anything wrong with the file, in the caller's words rather than a throw.
   *
   * A malformed config must not stop `status` from running -- that is the one
   * command whose job is to explain why nothing works.
   */
  readonly problems: readonly string[];
}

export const CONFIG_FILENAME = "hytale-atlas.json";

const EMPTY: AtlasConfig = {
  path: null,
  assets: null,
  serverJar: null,
  patchline: null,
  schema: null,
  cacheDir: null,
  mods: { dir: null, include: [], exclude: [] },
  consent: { runModPlugins: false },
  problems: [],
};

/** Every key the file may carry. Anything else is a typo worth naming. */
const KNOWN_KEYS = new Set([
  "$schema",
  "assets",
  "serverJar",
  "patchline",
  "schema",
  "cacheDir",
  "mods",
  "consent",
]);
const KNOWN_CONSENT_KEYS = new Set(["runModPlugins"]);
const KNOWN_MOD_KEYS = new Set(["dir", "include", "exclude"]);

/**
 * Finds the config by walking up from `cwd`, the way `package.json` is found.
 *
 * Walking up rather than reading only `cwd` is what makes `npx hytale-atlas` work
 * from a subdirectory of a pack, which is where a modder actually is when they
 * want to ask a question about the file they are editing.
 */
export function findConfigFile(cwd: string = process.cwd()): string | null {
  let dir = resolve(cwd);
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

function asString(value: unknown, key: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`'${key}' must be a non-empty string; ignoring it.`);
    return null;
  }
  return value;
}

function asStrings(value: unknown, key: string, problems: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`'${key}' must be an array of strings; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry === "string" && entry.trim().length > 0) out.push(entry);
    else problems.push(`'${key}[${i}]' is not a non-empty string; ignoring that entry.`);
  }
  return out;
}

/** Resolves against the config file's own directory, never the cwd. */
function against(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/**
 * Reads a config file. Never throws: a broken file is a reported problem.
 */
export function readConfig(file: string): AtlasConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      ...EMPTY,
      path: file,
      problems: [`${CONFIG_FILENAME} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`],
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY, path: file, problems: [`${CONFIG_FILENAME} must contain a JSON object.`] };
  }

  const base = dirname(file);
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      problems.push(
        `Unknown key '${key}'. Known keys: ${[...KNOWN_KEYS].filter((k) => k !== "$schema").join(", ")}.`,
      );
    }
  }

  const assets = asString(obj["assets"], "assets", problems);
  const serverJar = asString(obj["serverJar"], "serverJar", problems);
  const patchline = asString(obj["patchline"], "patchline", problems);
  const schema = asString(obj["schema"], "schema", problems);
  const cacheDir = asString(obj["cacheDir"], "cacheDir", problems);

  let mods: ModSources = { dir: null, include: [], exclude: [] };
  const rawMods = obj["mods"];
  if (rawMods !== undefined && rawMods !== null) {
    if (typeof rawMods !== "object" || Array.isArray(rawMods)) {
      problems.push("'mods' must be an object with 'dir', 'include' and/or 'exclude'.");
    } else {
      const m = rawMods as Record<string, unknown>;
      for (const key of Object.keys(m)) {
        if (!KNOWN_MOD_KEYS.has(key)) {
          problems.push(
            `Unknown key 'mods.${key}'. Known keys: ${[...KNOWN_MOD_KEYS].join(", ")}.`,
          );
        }
      }
      const dir = asString(m["dir"], "mods.dir", problems);
      mods = {
        dir: dir === null ? null : against(base, dir),
        include: asStrings(m["include"], "mods.include", problems).map((p) => against(base, p)),
        exclude: asStrings(m["exclude"], "mods.exclude", problems),
      };
    }
  }

  let consent = { runModPlugins: false };
  const rawConsent = obj["consent"];
  if (rawConsent !== undefined && rawConsent !== null) {
    if (typeof rawConsent !== "object" || Array.isArray(rawConsent)) {
      problems.push("'consent' must be an object with 'runModPlugins'.");
    } else {
      const c = rawConsent as Record<string, unknown>;
      for (const key of Object.keys(c)) {
        if (!KNOWN_CONSENT_KEYS.has(key)) {
          problems.push(
            `Unknown key 'consent.${key}'. Known keys: ${[...KNOWN_CONSENT_KEYS].join(", ")}.`,
          );
        }
      }
      const flag = (key: string): boolean => {
        const v = c[key];
        if (v === undefined) return false;
        if (typeof v !== "boolean") {
          // Never coerced. A consent read from a truthy string would be a grant
          // the user did not write, which is the one mistake this must not make.
          problems.push(`'consent.${key}' must be true or false; treating it as false.`);
          return false;
        }
        return v;
      };
      consent = { runModPlugins: flag("runModPlugins") };
    }
  }

  return {
    path: file,
    assets: assets === null ? null : against(base, assets),
    serverJar: serverJar === null ? null : against(base, serverJar),
    patchline,
    schema: schema === null ? null : against(base, schema),
    cacheDir: cacheDir === null ? null : against(base, cacheDir),
    mods,
    consent,
    problems,
  };
}

/** Finds and reads in one step; an absent file is not a problem. */
export function loadConfig(cwd: string = process.cwd()): AtlasConfig {
  const file = findConfigFile(cwd);
  return file === null ? EMPTY : readConfig(file);
}

/** `*` is the only wildcard. Matched on the basename, case-insensitively. */
function matches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

export interface ResolvedMod {
  readonly path: string;
  /** How it got here, so `status` can explain a surprise. */
  readonly from: "dir" | "include";
}

/**
 * The packs a config actually selects, and what went wrong finding them.
 *
 * Deliberately does NOT decide whether an archive carries assets -- that costs a
 * central-directory read per file, and the honest place to say "this jar is pure
 * code" is the indexer, which has to open it anyway. This layer answers only
 * "which files did you ask for, and are they there".
 */
export function resolveMods(mods: ModSources): {
  packs: readonly ResolvedMod[];
  problems: readonly string[];
} {
  const problems: string[] = [];
  const seen = new Set<string>();
  const packs: ResolvedMod[] = [];

  const add = (path: string, from: "dir" | "include"): void => {
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    packs.push({ path, from });
  };

  if (mods.dir !== null) {
    if (!existsSync(mods.dir)) {
      // Named, not swallowed: "no mods indexed" must never be able to mean
      // "the directory you gave me is not there".
      problems.push(`mods.dir does not exist: ${mods.dir}`);
    } else if (!statSync(mods.dir).isDirectory()) {
      problems.push(`mods.dir is not a directory: ${mods.dir}`);
    } else {
      for (const name of readdirSync(mods.dir).sort()) {
        if (!/\.(jar|zip)$/i.test(name)) continue;
        if (mods.exclude.some((p) => matches(p, name))) continue;
        add(join(mods.dir, name), "dir");
      }
    }
  }

  for (const path of mods.include) {
    if (!existsSync(path)) {
      problems.push(`mods.include entry does not exist: ${path}`);
      continue;
    }
    // An explicit include is a deliberate act, so `exclude` does not veto it --
    // otherwise a broad pattern in one field silently cancels a named path in
    // the other, and the reader has no way to see why.
    add(path, "include");
  }

  return { packs, problems };
}
