/**
 * Runs the suite with source discovery pinned to the game's own archive.
 *
 * `hytale-atlas.json` is found by walking UP from the working directory, so the
 * moment this repository gained one at its root the integration tests began
 * asserting against whatever packs the developer had installed -- eight failed
 * at once on locale counts, union totals and observed values, none because the
 * code had changed. Expectations that move with someone's mods directory are not
 * expectations. The same trap waits for any CI job run inside a configured
 * project, which is why the escape hatch lives in the tool rather than here.
 */
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--test", "--experimental-strip-types", "src/**/*.test.ts"],
  { stdio: "inherit", env: { ...process.env, HYTALE_ATLAS_NO_CONFIG: "1" } },
);
child.on("exit", (code) => process.exit(code ?? 1));
