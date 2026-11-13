import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll } from "vitest";

// The demo command lines as their tests run them (commands.test.ts and the
// attacks beside it, #380): each in a process of its own, as the maintainer
// runs it, with an environment built from nothing and a home of its own.

const run = promisify(execFile);
export const API_DIR = resolve(import.meta.dirname, "..");
export const scratch = mkdtempSync(join(tmpdir(), "kuutti-commands-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

export type Outcome = { code: number; stdout: string; stderr: string };

export async function command(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Outcome> {
  return run(process.execPath, ["--import", "tsx", `scripts/${script}`, ...args], {
    cwd: API_DIR,
    // A home of its own: no cache of the user's is read.
    env: { PATH: process.env.PATH ?? "", HOME: scratch, ...env },
    timeout: 30_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: unknown) => {
      // A command's nonzero exit is an observation for the test. A process
      // killed by our deadline, a failed spawn or truncated output is not.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        typeof error.code !== "number" ||
        error.code <= 0 ||
        ("killed" in error && error.killed) ||
        ("signal" in error && error.signal != null) ||
        !("stdout" in error) ||
        typeof error.stdout !== "string" ||
        !("stderr" in error) ||
        typeof error.stderr !== "string"
      ) {
        throw error;
      }
      // Node exits with 1 both for application refusals and for a broken
      // import or programmer error. None of the latter proves a rule held.
      if (
        /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_DIR_IMPORT|ERR_REQUIRE_ESM)\b/.test(
          error.stderr,
        ) ||
        /(?:^|\n)(?:SyntaxError|ReferenceError|TypeError|RangeError|EvalError|URIError)(?: \[[A-Z_]+\])?:/.test(
          error.stderr,
        )
      ) {
        throw error;
      }
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    },
  );
}
