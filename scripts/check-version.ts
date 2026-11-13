/**
 * The counted version (#172, CLAUDE.md Git: versioning) lives once, in the
 * root package.json. Every app's package.json carries the same number, and so
 * does apps/api/openapi.json's `info.version`, which `pnpm openapi` writes
 * from the API's package.json: a bump is one change in five files and never
 * a drift (`pnpm version:bump`, ADR-028). app.json's `version` is the store's
 * and may lag behind until the next native batch, which this script says but
 * does not fail on. Exit 1 on a mismatch or a number that is not semver.
 *
 * `--staged` reads the files as the index holds them, for the pre-commit hook;
 * `--self-test` runs the comparison's own cases first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectProblems } from "./lib/self-test.ts";

const root = join(import.meta.dirname, "..");
const staged = process.argv.includes("--staged");
const read = (path: string): { version?: unknown } =>
  JSON.parse(
    staged
      ? execFileSync("git", ["show", `:${path}`], { cwd: root, encoding: "utf8" })
      : readFileSync(join(root, path), "utf8"),
  ) as { version?: unknown };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The counted version as `read` gives it, and what is wrong with it and with those held to it. */
function problemsOf(read: (path: string) => { version?: unknown }): {
  counted: unknown;
  problems: string[];
} {
  const counted = read("package.json").version;
  const problems: string[] = [];
  if (typeof counted !== "string" || !SEMVER.test(counted)) {
    problems.push(`package.json version ${String(counted)} is not MAJOR.MINOR.PATCH`);
  }
  for (const app of ["apps/api", "apps/admin", "apps/mobile"]) {
    const version = read(`${app}/package.json`).version;
    if (version !== counted) {
      problems.push(
        `${app}/package.json says ${String(version)}, the root says ${String(counted)}`,
      );
    }
  }
  const documented = (read("apps/api/openapi.json") as { info?: { version?: unknown } }).info
    ?.version;
  if (documented !== counted) {
    problems.push(
      `apps/api/openapi.json says ${String(documented)}, the root says ${String(counted)}: run pnpm openapi`,
    );
  }
  return { counted, problems };
}

function selfTest(): void {
  type Versions = {
    root?: unknown;
    api?: unknown;
    admin?: unknown;
    mobile?: unknown;
    openapi?: unknown;
  };
  const files = (given: Versions) => (path: string) => {
    const versions: Versions = {
      root: "0.2.0",
      api: "0.2.0",
      admin: "0.2.0",
      mobile: "0.2.0",
      openapi: "0.2.0",
      ...given,
    };
    if (path === "apps/api/openapi.json") return { info: { version: versions.openapi } };
    const app = /^apps\/(api|admin|mobile)\/package\.json$/.exec(path)?.[1] as
      | keyof Versions
      | undefined;
    return { version: versions[app ?? "root"] };
  };
  const everywhere = (version: unknown): Versions => ({
    root: version,
    api: version,
    admin: version,
    mobile: version,
    openapi: version,
  });
  const notSemver = (version: unknown) => [`package.json version ${String(version)} is not`];
  // What it is, the versions the five files carry, and what is wrong.
  const cases: Array<[string, Versions, string[]]> = [
    ["one version in the five files", {}, []],
    [
      "an app behind the root",
      { admin: "0.1.9" },
      ["apps/admin/package.json says 0.1.9, the root says 0.2.0"],
    ],
    ["the document behind the root", { openapi: "0.1.9" }, ["apps/api/openapi.json says 0.1.9"]],
    // attack: a version with a pre-release tail, the same in every file, passes
    ["a pre-release everywhere", everywhere("0.2.0-rc.1"), notSemver("0.2.0-rc.1")],
    // control: the plain number everywhere
    ["a release everywhere", everywhere("0.3.0"), []],
    // attack: a version of two numbers, the same in every file, passes
    ["two numbers everywhere", everywhere("0.2"), notSemver("0.2")],
    // control: three numbers everywhere
    ["three numbers everywhere", everywhere("0.2.1"), []],
    // attack: a number with a zero in front, the same in every file, passes
    ["a zero in front everywhere", everywhere("0.02.0"), notSemver("0.02.0")],
    // control: the number without it
    ["no zero in front", everywhere("0.20.0"), []],
    // attack: a version written as a number, not as text, passes
    ["a number everywhere", everywhere(1), notSemver(1)],
    // control: the same as text of three numbers
    ["text everywhere", everywhere("1.0.0"), []],
    // attack: no file carries a version at all, and they agree on that
    ["no version anywhere", everywhere(undefined), notSemver(undefined)],
    // control: a version in every file
    ["a version everywhere", everywhere("1.2.3"), []],
    // attack: an app's version that differs only by a space passes
    [
      "a space after an app's version",
      { mobile: "0.2.0 " },
      ["apps/mobile/package.json says 0.2.0 , the root says 0.2.0"],
    ],
    // control: the app's version to the letter
    ["an app's version to the letter", { mobile: "0.2.0" }, []],
    // attack: the document names the version with its commit, as the running API does
    [
      "the document with a commit",
      { openapi: "0.2.0-37a837c" },
      ["apps/api/openapi.json says 0.2.0-37a837c"],
    ],
    // control: the document with the plain version
    ["the document with the version", { openapi: "0.2.0" }, []],
    // attack: an app that lost its version passes beside a root that has one
    [
      "an app without a version",
      { api: undefined },
      ["apps/api/package.json says undefined, the root says 0.2.0"],
    ],
    // control: the app with it
    ["an app with its version", { api: "0.2.0" }, []],
  ];
  for (const [name, given, expected] of cases) {
    expectProblems(name, problemsOf(files(given)).problems, expected);
  }
  console.log(`✔ check-version self-test: ${cases.length} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const { counted, problems } = problemsOf(read);
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
