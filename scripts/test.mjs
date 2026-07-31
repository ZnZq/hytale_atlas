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
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const env = { ...process.env, HYTALE_ATLAS_NO_CONFIG: "1" };

/*
 * The index is built BEFORE the suite, never inside it.
 *
 * The MCP server builds an index when it finds none, and the tests that spawn it
 * carry a 60s timeout -- while a cold build takes about 150s. So on any machine
 * without a current index (a fresh clone, a CI runner, or the first run after
 * SCHEMA_VERSION is bumped, which orphans the cache by design) five tests failed
 * on timeout AND the build they had started was killed with them. The next run
 * then found no index and failed the same way: the suite could not bootstrap
 * itself, and the failure looked like five unrelated protocol bugs.
 *
 * Run from dist, not from src. The suite already requires a build -- the CLI
 * integration tests spawn `dist/cli/main.js` -- and the source cannot run under
 * `--experimental-strip-types` anyway: `archive.ts` uses a constructor parameter
 * property, which strip-only mode rejects outright. The tests never caught that
 * because they import the archive from dist too.
 *
 * Skipped when there is no build, so `npm test` on a clean checkout still gets
 * to the tests, which skip themselves for the same reason. A no-op costing one
 * stat when the index is already current.
 */
const CLI = "dist/cli/main.js";
if (existsSync(CLI)) {
  const built = spawnSync(process.execPath, [CLI, "index"], { stdio: "inherit", env });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const child = spawn(
  process.execPath,
  ["--test", "--experimental-strip-types", "src/**/*.test.ts"],
  { stdio: "inherit", env },
);
child.on("exit", (code) => process.exit(code ?? 1));
