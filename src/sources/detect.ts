import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locating the game installation and classifying the working directory.
 *
 * Windows is fully specified: the launcher records everything we need in
 * `patchline.json`, so nothing has to be guessed. macOS and Linux install roots
 * are unverified — see `docs/init/OPEN-QUESTIONS.md` Q6.
 */

export interface Installation {
  /** Root that contains patchline.json, install/ and UserData/. */
  readonly root: string;
  /** Active patchline per patchline.json, e.g. "release". */
  readonly patchline: string;
  /** All patchlines present on disk. Several commonly coexist. */
  readonly availablePatchlines: readonly string[];
  readonly assetsZip: string | null;
  readonly serverJar: string | null;
  /** The JRE the game bundles. Preferred over any system Java — it is version-matched to the JAR. */
  readonly bundledJava: string | null;
  readonly userData: string | null;
  /**
   * Launcher UI language from `settings.json`, e.g. "en".
   *
   * Used to pick which locale to *display* results in. Search always runs across
   * every indexed locale regardless — a Ukrainian user may still search an English
   * name they saw in a tutorial.
   */
  readonly uiLanguage: string | null;
}

export type ProjectKind =
  | "pack"
  | "pack-empty"
  | "plugin"
  | "plugin-with-assets"
  | "none";

export interface Project {
  readonly kind: ProjectKind;
  readonly root: string;
  readonly manifestPath: string | null;
}

/**
 * Candidate install roots, most authoritative first.
 *
 * `HYTALE_ROOT` is ours, for users whose install is somewhere unusual and for CI.
 */
function candidateRoots(): string[] {
  const roots: string[] = [];
  const env = process.env["HYTALE_ROOT"];
  if (env) roots.push(env);

  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) roots.push(join(appData, "Hytale"));
  } else if (process.platform === "darwin") {
    // Unverified — Q6. Guessed by platform convention, not observed.
    roots.push(join(homedir(), "Library", "Application Support", "Hytale"));
  } else {
    roots.push(join(homedir(), ".local", "share", "Hytale"));
    roots.push(join(homedir(), ".hytale"));
  }
  return roots;
}

function readPatchlineFile(root: string): { patchline?: string; userData?: string } {
  try {
    const raw = readFileSync(join(root, "patchline.json"), "utf8");
    const parsed = JSON.parse(raw) as { patchline?: string; user_data?: string };
    const out: { patchline?: string; userData?: string } = {};
    if (parsed.patchline) out.patchline = parsed.patchline;
    if (parsed.user_data) out.userData = parsed.user_data;
    return out;
  } catch {
    return {};
  }
}

function readUiLanguage(root: string): string | null {
  try {
    const raw = readFileSync(join(root, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { language?: string };
    return parsed.language ?? null;
  } catch {
    return null;
  }
}

function listPatchlines(root: string): string[] {
  const installDir = join(root, "install");
  if (!existsSync(installDir)) return [];
  try {
    return readdirSync(installDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function fileIfExists(...parts: string[]): string | null {
  const p = join(...parts);
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function dirIfExists(...parts: string[]): string | null {
  const p = join(...parts);
  try {
    return statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the game installation.
 *
 * `patchlineOverride` selects a non-active patchline; several are commonly
 * installed side by side, and the cache is keyed by content hash precisely so
 * they can coexist.
 */
export function detectInstallation(patchlineOverride?: string): Installation | null {
  for (const root of candidateRoots()) {
    if (!existsSync(root)) continue;

    const available = listPatchlines(root);
    const recorded = readPatchlineFile(root);
    const patchline =
      patchlineOverride ?? recorded.patchline ?? available[0] ?? "release";

    const gameDir = join(root, "install", patchline, "package", "game", "latest");

    const javaExe = process.platform === "win32" ? "java.exe" : "java";

    return {
      root,
      patchline,
      availablePatchlines: available,
      assetsZip: fileIfExists(gameDir, "Assets.zip"),
      serverJar: fileIfExists(gameDir, "Server", "HytaleServer.jar"),
      bundledJava: fileIfExists(
        root, "install", patchline, "package", "jre", "latest", "bin", javaExe,
      ),
      userData: recorded.userData ?? dirIfExists(root, "UserData"),
      uiLanguage: readUiLanguage(root),
    };
  }
  return null;
}

/**
 * Classifies the working directory.
 *
 * An empty pack folder is not a degenerate case — it is the strongest case for the
 * tool, since the vanilla corpus and extracted schema then supply all the value.
 * Nothing may be required of the project directory.
 */
export function detectProject(cwd: string = process.cwd()): Project {
  const manifest = fileIfExists(cwd, "manifest.json");
  const resourcesManifest = fileIfExists(cwd, "src", "main", "resources", "manifest.json");
  const hasGradle =
    existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"));

  if (hasGradle && resourcesManifest) {
    return { kind: "plugin-with-assets", root: cwd, manifestPath: resourcesManifest };
  }
  if (hasGradle) {
    return { kind: "plugin", root: cwd, manifestPath: null };
  }
  if (manifest) {
    const hasContent =
      existsSync(join(cwd, "Server")) || existsSync(join(cwd, "Common"));
    return { kind: hasContent ? "pack" : "pack-empty", root: cwd, manifestPath: manifest };
  }
  return { kind: "none", root: cwd, manifestPath: null };
}
