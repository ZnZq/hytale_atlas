import { createInterface } from "node:readline/promises";

/**
 * Explicit consent for actions with outward-facing effects.
 *
 * Schema generation runs the vendor's server binary, which reports telemetry we
 * cannot switch off (`docs/init/05-CODEC-EXTRACTION.md` §Hazards). A tool should
 * not decide on a user's behalf that a network beacon is fine, so this refuses
 * rather than assuming when it cannot ask.
 */

export interface ConsentOptions {
  /** Pre-granted, e.g. by `--yes`. Skips the prompt entirely. */
  readonly granted?: boolean;
  readonly disclosure: string;
  readonly question?: string;
}

export async function askConsent(options: ConsentOptions): Promise<boolean> {
  const { granted = false, disclosure, question = "Continue?" } = options;

  if (granted) return true;

  process.stdout.write(`\n${disclosure}\n\n`);

  // Non-interactive: refuse and say how to proceed deliberately. Defaulting to
  // yes here would make the beacon fire silently in scripts and CI, which is the
  // one outcome this whole path exists to prevent.
  if (!process.stdin.isTTY) {
    process.stdout.write(
      "Not running interactively, so this cannot be confirmed.\n" +
        "Re-run with --yes if you accept the above.\n",
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
