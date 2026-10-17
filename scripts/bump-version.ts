/**
 * bump-version: writes the counted version (#172, ADR-028) one step past
 * main's, everywhere it lives, so a pull request carries its bump whole.
 *
 * - The base is origin/main's root package.json, the version the pull request
 *   merges into, never the working tree's: `git fetch origin main` first, and
 *   when the fetch fails, the origin/main this clone already has, said so.
 *   A second run, or a run after a rebase onto a main another pull request
 *   bumped, gives main's next number again.
 * - patch adds one to PATCH; minor adds one to MINOR and resets PATCH; major
 *   is refused while MAJOR is 0 (`0.y.z` until the first public release,
 *   whose tag sets the number by hand). Nothing else is a level.
 * - Writes the root and the three apps' package.json, changing the top-level
 *   "version" line and no other byte; runs `pnpm openapi`, whose document
 *   carries the API's version; then `node scripts/check-version.ts`.
 * - Refuses while any file it writes has an unresolved merge conflict.
 * - `--check-ahead [rev]` (the pre-push hook) exits 1 unless the root
 *   package.json at rev (default HEAD) is past origin/main's; it never fetches.
 *
 * Usage: node scripts/bump-version.ts patch|minor
 *        node scripts/bump-version.ts --check-ahead [rev]
 *        node scripts/bump-version.ts --self-test
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES = [
  "package.json",
  "apps/api/package.json",
  "apps/admin/package.json",
  "apps/mobile/package.json",
];
const GENERATED = ["apps/api/openapi.json", "packages/schema/src/api.generated.ts"];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// The top-level key of a package.json Biome formats: two spaces in, on a line of its own.
const VERSION_LINE = /^( {2}"version": ")[^"\n]*(")/m;
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;
const USAGE = "usage: pnpm version:bump patch|minor (a feature bumps MINOR, only fixes PATCH)";

type Next = { version: string } | { refused: string };

function parse(version: string): [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function next(base: string, level: string | undefined): Next {
  const parts = parse(base);
  if (!parts) return { refused: `main's version ${base} is not MAJOR.MINOR.PATCH` };
  const [major, minor, patch] = parts;
  if (level === "patch") return { version: `${major}.${minor}.${patch + 1}` };
  if (level === "minor") return { version: `${major}.${minor + 1}.0` };
  if (level === "major" && major === 0) {
    return {
      refused:
        "major is refused while MAJOR is 0: the version stays 0.y.z until the first public release (CLAUDE.md Git, #172), and that release's tag sets its number by hand",
    };
  }
  if (level === "major") return { version: `${major + 1}.0.0` };
  return { refused: USAGE };
}

/** Negative, zero or positive as a is below, equal to or above b; undefined when either is not semver. */
function compare(a: string, b: string): number | undefined {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The message that refuses a branch, or undefined when it is past main. */
function behind(main: string | undefined, branch: string | undefined): string | undefined {
  const order = compare(String(branch), String(main));
  if (order !== undefined && order > 0) return undefined;
  return `pnpm version:bump patch (or minor) — main is at ${String(main)}, this branch says ${String(branch)}`;
}

/** The file with only its top-level version changed, or undefined when it has no such line. */
function withVersion(text: string, version: string): string | undefined {
  if (!VERSION_LINE.test(text)) return undefined;
  const updated = text.replace(VERSION_LINE, `$1${version}$2`);
  const before = JSON.parse(text) as Record<string, unknown>;
  const after = JSON.parse(updated) as Record<string, unknown>;
  return JSON.stringify(after) === JSON.stringify({ ...before, version }) ? updated : undefined;
}

function git(args: string[]): { ok: boolean; out: string; err: string } {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { ok: run.status === 0, out: run.stdout.trim(), err: run.stderr.trim() };
}

function versionAt(rev: string): string | undefined {
  const shown = git(["show", `${rev}:package.json`]);
  if (!shown.ok) return undefined;
  const version = (JSON.parse(shown.out) as { version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

function refuse(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], what: string): void {
  const done = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (done.status !== 0) {
    process.stderr.write(`${done.stdout ?? ""}${done.stderr ?? ""}`);
    refuse(`${what} failed (exit ${String(done.status)}); the package.json files are written`);
  }
}

function checkAhead(rev: string): void {
  if (!git(["rev-parse", "--verify", "-q", "origin/main"]).ok) {
    console.error("no origin/main in this clone, so the version goes unchecked");
    return;
  }
  const problem = behind(versionAt("origin/main"), versionAt(rev));
  if (problem) refuse(problem);
}

function bump(level: string | undefined): void {
  if (level !== "patch" && level !== "minor" && level !== "major") refuse(USAGE);
  const files = [...PACKAGES, ...GENERATED];
  const unmerged = git(["diff", "--name-only", "--diff-filter=U", "--", ...files]).out;
  const marked = files.filter((file) =>
    CONFLICT_MARKER.test(readFileSync(join(ROOT, file), "utf8")),
  );
  const conflicted = [...new Set([...unmerged.split("\n").filter(Boolean), ...marked])];
  if (conflicted.length > 0) {
    const generated = conflicted.some((file) => GENERATED.includes(file))
      ? " (openapi.json and api.generated.ts are generated: either side will do, the bump writes them again)"
      : "";
    refuse(`resolve the merge conflict in ${conflicted.join(", ")} first${generated}`);
  }

  const fetched = git(["fetch", "-q", "origin", "main"]);
  if (!fetched.ok) {
    const why = fetched.err.split("\n")[0] ?? "";
    console.error(
      `could not fetch origin main (${why}); bumping from the origin/main this clone has`,
    );
  }
  const base = versionAt("origin/main");
  if (base === undefined) refuse("no origin/main with a root package.json version to bump from");
  const target = next(base, level);
  if ("refused" in target) refuse(target.refused);

  for (const file of PACKAGES) {
    const path = join(ROOT, file);
    const text = readFileSync(path, "utf8");
    const updated = withVersion(text, target.version);
    if (updated === undefined) refuse(`${file} has no top-level "version" line to change`);
    if (updated !== text) writeFileSync(path, updated);
  }
  run("pnpm", ["openapi"], "pnpm openapi");
  run(process.execPath, [join(ROOT, "scripts", "check-version.ts")], "check-version");
  console.log(
    `version ${target.version} (${level} on main's ${base}) in the root, the three apps and openapi.json`,
  );
}

function selfTest(): void {
  const failures: string[] = [];
  const expect = (name: string, got: unknown, wanted: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(wanted)) {
      failures.push(`${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
    }
  };
  const refusedWith = (outcome: Next, start: string): boolean =>
    "refused" in outcome && outcome.refused.startsWith(start);

  expect("patch", next("0.33.6", "patch"), { version: "0.33.7" });
  expect("minor resets PATCH", next("0.33.6", "minor"), { version: "0.34.0" });
  expect("patch past nine", next("0.33.9", "patch"), { version: "0.33.10" });
  expect("major after 1.0.0", next("1.2.3", "major"), { version: "2.0.0" });
  expect("major while 0", refusedWith(next("0.33.6", "major"), "major is refused"), true);
  expect("another level", refusedWith(next("0.33.6", "prerelease"), "usage:"), true);
  expect("no level", refusedWith(next("0.33.6", undefined), "usage:"), true);
  expect("main not semver", refusedWith(next("0.33", "patch"), "main's version 0.33"), true);
  expect("main with a suffix", refusedWith(next("0.33.6-37a837c", "patch"), "main's"), true);
  expect("a leading zero", refusedWith(next("0.033.6", "patch"), "main's"), true);

  expect("above by PATCH", compare("0.33.7", "0.33.6"), 1);
  expect("numbers, not text", (compare("0.33.10", "0.33.9") ?? 0) > 0, true);
  expect("MINOR over PATCH", (compare("0.34.0", "0.33.10") ?? 0) > 0, true);
  expect("MAJOR over all", (compare("1.0.0", "0.99.99") ?? 0) > 0, true);
  expect("equal", compare("0.33.6", "0.33.6"), 0);
  expect("below", (compare("0.33.5", "0.33.6") ?? 0) < 0, true);
  expect("not semver", compare("0.33", "0.33.6"), undefined);

  expect("a branch past main", behind("0.33.6", "0.33.7"), undefined);
  expect("a minor past main", behind("0.33.6", "0.34.0"), undefined);
  const said = "pnpm version:bump patch (or minor) — main is at 0.33.6, this branch says 0.33.6";
  expect("main's own number", behind("0.33.6", "0.33.6"), said);
  expect("below main", behind("0.33.6", "0.33.5")?.endsWith("this branch says 0.33.5"), true);
  expect("no version on the branch", behind("0.33.6", undefined)?.endsWith("says undefined"), true);
  expect("no version on main", behind(undefined, "0.33.7")?.includes("main is at undefined"), true);

  const pkg = `{\n  "name": "x",\n  "version": "0.33.6",\n  "engines": {\n    "version": "9.9.9"\n  },\n  "scripts": {}\n}\n`;
  const bumped = withVersion(pkg, "0.33.7");
  expect(
    "only the version line changes",
    bumped,
    pkg.replace('"version": "0.33.6"', '"version": "0.33.7"'),
  );
  expect("the same number is the same bytes", withVersion(pkg, "0.33.6"), pkg);
  expect("no top-level version", withVersion(`{\n  "name": "x"\n}\n`, "0.33.7"), undefined);
  expect(
    "a nested version alone is left alone",
    withVersion(`{\n  "a": {\n    "version": "1.0.0"\n  }\n}\n`, "0.33.7"),
    undefined,
  );
  expect(
    "the last key, without a comma",
    withVersion(`{\n  "name": "x",\n  "version": "0.1.0"\n}`, "0.2.0"),
    `{\n  "name": "x",\n  "version": "0.2.0"\n}`,
  );

  expect("a conflict's start", CONFLICT_MARKER.test('{\n<<<<<<< HEAD\n  "version"'), true);
  expect("a conflict's middle", CONFLICT_MARKER.test("a\n=======\nb"), true);
  expect("a conflict's end", CONFLICT_MARKER.test("a\n>>>>>>> 9ed12c5 (x)\n"), true);
  expect("no conflict", CONFLICT_MARKER.test('{\n  "a": "<<<<<<< b"\n}'), false);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✖ self-test, ${failure}`);
    process.exit(1);
  }
  console.log("✔ bump-version self-test: next, compare, behind, withVersion, conflict markers");
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
} else if (argv[0] === "--check-ahead") {
  checkAhead(argv[1] ?? "HEAD");
} else {
  bump(argv[0]);
}
