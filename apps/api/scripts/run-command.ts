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
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}
