import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives the server's own schema generator.
 *
 * The game ships `--generate-asset-schema <dir>`, documented in its `--help` as
 * "Generate asset JSON schemas to the specified directory and exit". Running it
 * beats anything we could write: it is complete, supported, and survives patches.
 * See `docs/init/05-CODEC-EXTRACTION.md`.
 *
 * **Three hazards, all measured, all handled here:**
 *
 * 1. `SchemaGenerator.cleanAndCreateSchemaDir()` **deletes the output directory**
 *    before writing. Only ever a freshly created temp directory — pointing this at
 *    a user's pack would destroy their work.
 * 2. The run **emits telemetry that cannot be suppressed**. `TelemetryService` has
 *    no CLI switch, and of ~50 options none touches it. Consent belongs to the
 *    caller; this module refuses to guess. See {@link GenerateOptions.consent}.
 * 3. It writes plugin and server configs into the working directory, so it gets a
 *    scratch working directory of its own that is deleted afterwards.
 */

export interface GenerateOptions {
  /** Path to `HytaleServer.jar`. */
  readonly serverJar: string;
  /** Path to `Assets.zip`. Archive packs are mounted, not unpacked. */
  readonly assetsZip: string;
  /**
   * Java executable. Prefer the JRE the game bundles — it is version-matched to
   * the JAR, and it means no user-installed Java is required.
   */
  readonly java: string;
  /**
   * Explicit acknowledgement that this starts the vendor's server binary and that
   * the binary reports telemetry we cannot disable.
   *
   * Deliberately not defaulted. A silent network beacon is not something a tool
   * should decide on a user's behalf.
   */
  readonly consent: true;
  /** Copy the generated schema set here instead of discarding it. */
  readonly keepAt?: string;
  readonly timeoutMs?: number;
  readonly onLine?: (line: string) => void;
}

export interface GenerateResult {
  /** Directory holding `Schema/` and `.vscode/`; removed unless `keepAt` was set. */
  readonly outDir: string;
  readonly exitCode: number | null;
  /** e.g. `schemaGenerated` when the run did what it was asked. */
  readonly shutdownReason: string | null;
  readonly schemaCount: number;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
}

/** What a caller must show a user before passing `consent`. */
export const TELEMETRY_DISCLOSURE = [
  "Generating asset schemas runs Hytale's own server binary in batch mode.",
  "",
  "  - It starts HytaleServer.jar with --bare (no world, no ports) and exits",
  "    on its own, taking about 40 seconds.",
  // Sentry and telemetry are two different things, and saying only "no such
  // flag" made the disclosure contradict the command printed six lines above it:
  // `--disable-sentry` is right there. Three blind trials across two rounds
  // called it out, and this is the text a user's consent is given against, so
  // the distinction is now explicit rather than implied.
  "  - We pass --disable-sentry, which turns off crash reporting. That is NOT",
  "    the same thing as telemetry.",
  "  - It SENDS TELEMETRY to Hypixel Studios regardless: the run logs 'Sending",
  "    server stop telemetry' and writes a telemetry/ directory. Of the server's",
  "    ~50 options none disables it -- there is --disable-sentry,",
  "    --disable-file-watcher and --disable-asset-compare, and nothing for this.",
  "  - It writes into a temporary directory that is deleted afterwards.",
  "",
  "This happens once per game version and the result is cached.",
].join("\n");

const SHUTDOWN_REASON = /shutdownReason\.(?:[A-Za-z]+\.)*([A-Za-z]+)/;

/**
 * Generates schemas and hands the directory to `consume` before removing it.
 *
 * A scoped callback rather than a returned path: the temp directory must be
 * cleaned up whatever happens, and returning it would leave callers to read from
 * a directory this function has already deleted — which is exactly what the first
 * version of this signature did.
 */
export async function withGeneratedSchemas<T>(
  options: GenerateOptions,
  consume: (outDir: string, result: GenerateResult) => T | Promise<T>,
): Promise<{ result: GenerateResult; value: T }> {
  let captured!: { result: GenerateResult; value: T };
  await generateSchemas(options, async (outDir, result) => {
    captured = { result, value: await consume(outDir, result) };
  });
  return captured;
}

async function generateSchemas(
  options: GenerateOptions,
  consume: (outDir: string, result: GenerateResult) => Promise<void>,
): Promise<GenerateResult> {
  const { serverJar, assetsZip, java, keepAt, timeoutMs = 10 * 60_000, onLine } = options;

  for (const [label, path] of [
    ["java", java],
    ["server JAR", serverJar],
    ["Assets.zip", assetsZip],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  }

  // One temp root holding both the scratch working directory and the output
  // directory, so a single removal cleans up telemetry, configs and schemas.
  const root = mkdtempSync(join(tmpdir(), "hytale-atlas-schema-"));
  const workDir = join(root, "work");
  const outDir = join(root, "out");

  const started = Date.now();
  let shutdownReason: string | null = null;
  let timedOut = false;

  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workDir, { recursive: true });

    const args = [
      "-jar", serverJar,
      "--bare",
      "--disable-sentry",
      "--assets", assetsZip,
      "--generate-asset-schema", outDir,
    ];

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(java, args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      let buffer = "";
      const consume = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          // The generator announces why it stopped; schemaGenerated means success,
          // anything else means it gave up before writing.
          const match = SHUTDOWN_REASON.exec(line);
          if (match?.[1] !== undefined) shutdownReason = match[1];
          onLine?.(line);
          newline = buffer.indexOf("\n");
        }
      };

      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const schemaDir = join(outDir, "Schema");
    const schemaCount = existsSync(schemaDir)
      ? readdirSync(schemaDir).filter((f) => f.endsWith(".json")).length
      : 0;

    if (keepAt !== undefined && schemaCount > 0) {
      rmSync(keepAt, { recursive: true, force: true });
      const { cpSync } = await import("node:fs");
      cpSync(outDir, keepAt, { recursive: true });
    }

    const result: GenerateResult = {
      outDir: keepAt ?? outDir,
      exitCode,
      shutdownReason,
      schemaCount,
      elapsedMs: Date.now() - started,
      timedOut,
    };

    // Read while the directory still exists. Anything the caller needs must be
    // taken now; the finally block below removes it unconditionally.
    await consume(outDir, result);
    return result;
  } finally {
    // Removes the schemas, the telemetry directory and the written configs alike.
    rmSync(root, { recursive: true, force: true });
  }
}
