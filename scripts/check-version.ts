/**
 * The counted version (#172, CLAUDE.md Git: versioning) lives once, in the
 * root package.json. Every app's package.json carries the same number, and so
 * does apps/api/openapi.json's `info.version`, which `pnpm openapi` writes
 * from the API's package.json: a bump is one change in five files and never
 * a drift (`pnpm version:bump`, ADR-028). app.json's `version` is the store's
 * and may lag behind until the next native batch, which this script says but
 * does not fail on. Exit 1 on a mismatch or a number that is not semver.
 *
 * `--staged` reads the files as the index holds them, for the pre-commit hook.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const staged = process.argv.includes("--staged");
const read = (path: string): { version?: unknown } =>
  JSON.parse(
    staged
      ? execFileSync("git", ["show", `:${path}`], { cwd: root, encoding: "utf8" })
      : readFileSync(join(root, path), "utf8"),
  ) as { version?: unknown };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const counted = read("package.json").version;
const problems: string[] = [];
if (typeof counted !== "string" || !SEMVER.test(counted)) {
  problems.push(`package.json version ${String(counted)} is not MAJOR.MINOR.PATCH`);
}
for (const app of ["apps/api", "apps/admin", "apps/mobile"]) {
  const version = read(`${app}/package.json`).version;
  if (version !== counted) {
    problems.push(`${app}/package.json says ${String(version)}, the root says ${String(counted)}`);
  }
}
const documented = (read("apps/api/openapi.json") as { info?: { version?: unknown } }).info
  ?.version;
if (documented !== counted) {
  problems.push(
    `apps/api/openapi.json says ${String(documented)}, the root says ${String(counted)}: run pnpm openapi`,
  );
}
const store = (read("apps/mobile/app.json") as { expo?: { version?: unknown } }).expo?.version;
if (store !== counted) {
  console.log(
    `note: apps/mobile/app.json version ${String(store)} is the store's and lags the counted ${String(counted)} until the next native batch`,
  );
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`version ${counted} in the root, the three apps and openapi.json`);
