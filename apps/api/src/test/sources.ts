import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The guards that read the code itself: who reads a block or a report
 * (`safety/no-signal.test.ts`), who reads the soft count (`matching/soft.test.ts`).
 * Every source file of the apps and the database package, tests and the test
 * helpers left out.
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const SCANNED = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/admin/src",
  "apps/mobile/src",
  "packages/db/src",
];
const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.test\.(ts|tsx)$/;

function* sources(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === "generated" || name === "test") continue;
    yield* sources(join(path, name));
  }
}

/** The source without its comments: a block comment, and a line comment after a line's start or a space. */
export const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** The files, from the repository's root and sorted, whose source the test finds. */
export function readersOf(test: (source: string) => boolean): string[] {
  const found = new Set<string>();
  for (const dir of SCANNED) {
    for (const file of sources(resolve(ROOT, dir))) {
      if (test(readFileSync(file, "utf8"))) found.add(relative(ROOT, file));
    }
  }
  return [...found].sort();
}
