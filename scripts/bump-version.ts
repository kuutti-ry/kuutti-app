/**
 * bump-version: writes the counted version (#172, ADR-028) one step past
 * main's, everywhere it lives, so a pull request carries its bump whole.
 *
 * - The base is origin/main's root package.json, the version the pull request
 *   merges into, never the working tree's: `git fetch origin main` first, and
 *   when the fetch fails, the origin/main this clone already has, said so.
 *   A second run, or a run after a rebase onto a main another pull request
 *   bumped, gives main's next number again.
 * - origin is the remote whose URL is kuutti-ry/kuutti-app, whatever its name:
 *   in a fork's clone that is upstream, and origin the fork, whose main lags.
 *   The fetch names its refspec, so it moves origin/main whatever the clone
 *   fetches by default, and the ref is read by its full name, so a local
 *   branch called origin/main cannot stand in for it.
 * - patch adds one to PATCH; minor adds one to MINOR and resets PATCH; major
 *   is refused while MAJOR is 0 (`0.y.z` until the first public release,
 *   whose tag sets the number by hand). Nothing else is a level.
 * - Writes the root and the three apps' package.json, changing the top-level
 *   "version" line and no other byte; runs `pnpm openapi`, whose document
 *   carries the API's version; then `node scripts/check-version.ts`.
 * - Refuses while any file it writes has an unresolved merge conflict.
 * - Refuses, after the fetch and before it writes, when HEAD does not contain
 *   origin/main (#333): counted from main's tip, the number can conflict on a
 *   branch that does not contain that tip. A rebase onto origin/main passes
 *   while it is still in progress, and main at origin/main passes as well.
 * - `--check-ahead [rev]` (the pre-push hook) exits 1 when the root
 *   package.json at rev (default HEAD) is not past origin/main's, or when main
 *   has bumped since rev's base, as both then change the version lines; it
 *   never fetches.
 * - `--self-test` also runs the command in a throwaway clone, to see the guard
 *   refuse before it writes, and the hook's check refuse #333's branch.
 *
 * Usage: node scripts/bump-version.ts patch|minor
 *        node scripts/bump-version.ts --check-ahead [rev]
 *        node scripts/bump-version.ts --self-test
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
// The repository whose main a pull request merges into, over HTTPS or SSH (a host alias too).
const MAIN_REPO = /[/:]kuutti-ry\/kuutti-app(\.git)?\/?$/i;
const NO_REMOTE = "no remote of this clone is github.com/kuutti-ry/kuutti-app";

type Next = { version: string } | { refused: string };
/** origin/main as the bump counts from it: its name, short sha, version, and whether this run fetched it. */
type Tip = { ref: string; sha: string; version: string; fetched: boolean };
/** HEAD's branch (undefined when detached) and whether a rebase is in progress. */
type Head = { branch: string | undefined; rebasing: boolean };

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

/**
 * The refusal for a branch whose base is older than main's last bump, or undefined (#333): the
 * branch and main then both change the version lines, and the pull request conflicts on them.
 * `base` is the version at `git merge-base origin/main <rev>`; main adding unbumped commits passes.
 */
function rebumped(
  main: string | undefined,
  base: string | undefined,
  ref: string,
): string | undefined {
  if (base === main) return undefined;
  return `main has bumped since this branch's base, from ${String(base)} to ${String(main)}: rebase onto ${ref}, then pnpm version:bump patch (or minor)`;
}

/**
 * The refusal for a HEAD that does not contain the origin/main a bump counts from, or undefined
 * when it does (#333). `status` is `git merge-base --is-ancestor origin/main HEAD`'s exit status:
 * 0 contains, 1 does not, anything else is git failing, with `error` its first line.
 */
function stale(status: number | null, tip: Tip, head: Head, error: string): string | undefined {
  if (status === 0) return undefined;
  const where = tip.fetched
    ? `main's tip ${tip.sha} (${tip.version})`
    : `${tip.sha} (${tip.version}), ${tip.ref} as this clone last fetched it`;
  if (status !== 1) {
    return `could not tell whether HEAD contains ${where} (${error || `git merge-base exit ${String(status)}`})`;
  }
  const subject = head.branch === undefined ? "the detached HEAD" : `this branch, ${head.branch},`;
  const [who, cure] = head.rebasing
    ? ["the rebase in progress is not onto", `finish or abort it, rebase onto ${tip.ref}`]
    : [`${subject} does not contain`, `rebase onto ${tip.ref} first`];
  return `${who} ${where}: ${cure}, then bump — counted from main, the version lines can conflict on a branch that does not contain it`;
}

/** The bump's last line; without this run's fetch it does not claim main's version, which it cannot know. */
function lastLine(version: string, level: string, tip: Tip): string {
  const from = tip.fetched
    ? `main's ${tip.version}`
    : `${tip.version}, ${tip.ref} as this clone last fetched it: run it again once it can fetch, before the push`;
  return `version ${version} (${level} on ${from}) in the root, the three apps and openapi.json`;
}

/** The file with only its top-level version changed, or undefined when it has no such line. */
function withVersion(text: string, version: string): string | undefined {
  if (!VERSION_LINE.test(text)) return undefined;
  const updated = text.replace(VERSION_LINE, `$1${version}$2`);
  const before = JSON.parse(text) as Record<string, unknown>;
  const after = JSON.parse(updated) as Record<string, unknown>;
  return JSON.stringify(after) === JSON.stringify({ ...before, version }) ? updated : undefined;
}

function git(args: string[]): { ok: boolean; status: number | null; out: string; err: string } {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return {
    ok: run.status === 0,
    status: run.status,
    out: run.stdout.trim(),
    err: run.stderr.trim(),
  };
}

/**
 * The remote that is kuutti-ry/kuutti-app, by its URL, or undefined: in a fork's clone origin is the
 * fork, whose main lags, and counting from it gives main's own number on a stale base (#333).
 */
function mainRemote(): string | undefined {
  const urls = git(["config", "--get-regexp", "^remote\\..*\\.url$"]).out.split("\n");
  const line = urls.find((entry) => MAIN_REPO.test(entry.slice(entry.indexOf(" ") + 1)));
  return line?.slice("remote.".length, line.indexOf(" ") - ".url".length);
}

/** Main's remote-tracking ref in full: a local branch named origin/main would otherwise win. */
function tracking(remote: string): string {
  return `refs/remotes/${remote}/main`;
}

function head(): Head {
  // Mid-rebase HEAD is detached, and the rebase's state lives in the (worktree's) git dir.
  const inGitDir = (path: string): boolean => {
    const found = git(["rev-parse", "--git-path", path]);
    return found.ok && existsSync(resolve(ROOT, found.out));
  };
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"]);
  return {
    branch: branch.ok ? branch.out : undefined,
    rebasing: inGitDir("rebase-merge") || inGitDir("rebase-apply"),
  };
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
  const remote = mainRemote();
  if (remote === undefined) {
    console.error(`${NO_REMOTE}, so the version goes unchecked`);
    return;
  }
  const ref = tracking(remote);
  if (!git(["rev-parse", "--verify", "-q", ref]).ok) {
    console.error(`no ${remote}/main in this clone, so the version goes unchecked`);
    return;
  }
  const main = versionAt(ref);
  const problem = behind(main, versionAt(rev));
  if (problem) refuse(problem);
  // No merge base (a shallow clone) leaves the base unchecked, as no origin/main leaves the version.
  const base = git(["merge-base", ref, rev]);
  const moved = base.ok ? rebumped(main, versionAt(base.out), `${remote}/main`) : undefined;
  if (moved) refuse(moved);
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

  const remote = mainRemote();
  if (remote === undefined) {
    refuse(
      `${NO_REMOTE}, whose main the bump counts from: git remote add upstream https://github.com/kuutti-ry/kuutti-app.git, then run it again`,
    );
  }
  const ref = tracking(remote);
  // The refspec spelled out moves the ref even where the clone's own leaves main out (--single-branch).
  const fetched = git(["fetch", "-q", remote, `+refs/heads/main:${ref}`]);
  if (!fetched.ok) {
    const why = fetched.err.split("\n")[0] ?? "";
    console.error(
      `could not fetch ${remote} main (${why}); bumping from the ${remote}/main this clone has`,
    );
  }
  const base = versionAt(ref);
  if (base === undefined) refuse(`no ${remote}/main with a root package.json version to bump from`);
  const contains = git(["merge-base", "--is-ancestor", ref, "HEAD"]);
  const tip = {
    ref: `${remote}/main`,
    sha: git(["rev-parse", "--short", ref]).out,
    version: base,
    fetched: fetched.ok,
  };
  const problem = stale(contains.status, tip, head(), contains.err.split("\n")[0] ?? "");
  if (problem) refuse(problem);
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
  console.log(lastLine(target.version, level, tip));
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

  const tip = { ref: "origin/main", sha: "b329e5f", version: "0.33.6", fetched: true };
  const branch = { branch: "chore/version-bump", rebasing: false };
  const detached = { branch: undefined, rebasing: false };
  const rebasing = { branch: undefined, rebasing: true };
  const main = { branch: "main", rebasing: false };
  expect("a branch on main's tip", stale(0, tip, branch, ""), undefined);
  expect("main at its own tip", stale(0, tip, main, ""), undefined);
  expect("a detached HEAD on main's tip", stale(0, tip, detached, ""), undefined);
  expect("a rebase onto main's tip", stale(0, tip, rebasing, ""), undefined);
  expect(
    "a branch on an older main",
    stale(1, tip, branch, ""),
    "this branch, chore/version-bump, does not contain main's tip b329e5f (0.33.6): rebase onto origin/main first, then bump — counted from main, the version lines can conflict on a branch that does not contain it",
  );
  expect(
    "main behind origin/main",
    stale(1, tip, main, "")?.startsWith("this branch, main,"),
    true,
  );
  expect(
    "a detached HEAD",
    stale(1, tip, detached, "")?.startsWith("the detached HEAD does"),
    true,
  );
  expect(
    "a rebase onto an older main",
    stale(1, tip, rebasing, "")?.startsWith(
      "the rebase in progress is not onto main's tip b329e5f (0.33.6): finish or abort it, rebase onto origin/main, then bump",
    ),
    true,
  );
  const unfetched = stale(1, { ...tip, fetched: false }, branch, "");
  expect("no fetch, no claim of main's tip", unfetched?.includes("main's tip"), false);
  expect(
    "no fetch, the clone's origin/main",
    unfetched?.includes("contain b329e5f (0.33.6), origin/main as this clone last fetched it:"),
    true,
  );
  expect(
    "git failing",
    stale(128, tip, branch, "fatal: Not a valid object name HEAD"),
    "could not tell whether HEAD contains main's tip b329e5f (0.33.6) (fatal: Not a valid object name HEAD)",
  );
  expect("git killed", stale(null, tip, branch, "")?.endsWith("(git merge-base exit null)"), true);

  expect(
    "main has not bumped since the base",
    rebumped("0.33.6", "0.33.6", "origin/main"),
    undefined,
  );
  expect(
    "main has bumped since the base",
    rebumped("0.33.6", "0.33.5", "upstream/main"),
    "main has bumped since this branch's base, from 0.33.5 to 0.33.6: rebase onto upstream/main, then pnpm version:bump patch (or minor)",
  );
  expect(
    "the last line, fetched",
    lastLine("0.33.7", "patch", tip),
    "version 0.33.7 (patch on main's 0.33.6) in the root, the three apps and openapi.json",
  );
  const stranded = lastLine("0.34.0", "minor", { ...tip, fetched: false });
  expect("the last line, no fetch, no claim of main's", stranded.includes("main's"), false);
  expect(
    "the last line, no fetch",
    stranded.startsWith(
      "version 0.34.0 (minor on 0.33.6, origin/main as this clone last fetched it: run it again",
    ),
    true,
  );

  expect("main over HTTPS", MAIN_REPO.test("https://github.com/kuutti-ry/kuutti-app.git"), true);
  expect("main over SSH", MAIN_REPO.test("git@github.com:kuutti-ry/kuutti-app.git"), true);
  expect("main without .git", MAIN_REPO.test("https://github.com/kuutti-ry/kuutti-app"), true);
  expect("a fork", MAIN_REPO.test("https://github.com/someone/kuutti-app.git"), false);
  expect("the site", MAIN_REPO.test("git@github.com:kuutti-ry/kuutti-app-site.git"), false);

  expect("a conflict's start", CONFLICT_MARKER.test('{\n<<<<<<< HEAD\n  "version"'), true);
  expect("a conflict's middle", CONFLICT_MARKER.test("a\n=======\nb"), true);
  expect("a conflict's end", CONFLICT_MARKER.test("a\n>>>>>>> 9ed12c5 (x)\n"), true);
  expect("no conflict", CONFLICT_MARKER.test('{\n  "a": "<<<<<<< b"\n}'), false);

  selfTestClone(expect);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✖ self-test, ${failure}`);
    process.exit(1);
  }
  console.log(
    "✔ bump-version self-test: next, compare, behind, rebumped, stale, lastLine, the main remote, withVersion, conflict markers, the guard and the hook in a clone",
  );
}

/**
 * The guard and the hook's check as the command wires them (#333), in a throwaway clone that holds
 * every way to miss main's tip at once: kuutti-ry/kuutti-app's URL as upstream, rewritten to a bare
 * repository on this disk, with no fetch refspec of its own; origin a fork whose main lags; a local
 * branch named upstream/main on the old base. Git runs without the user's or the system's settings.
 */
function selfTestClone(expect: (name: string, got: unknown, wanted: unknown) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bump-version-"));
  const work = join(dir, "work");
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"));
  const env = {
    ...Object.fromEntries(inherited),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "self-test",
    GIT_AUTHOR_EMAIL: "self-test@example.invalid",
    GIT_COMMITTER_NAME: "self-test",
    GIT_COMMITTER_EMAIL: "self-test@example.invalid",
  };
  const sh = (...args: string[]): string => {
    const done = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
    return done.stdout.trim();
  };
  const script = (...args: string[]) =>
    spawnSync(process.execPath, [join(work, "scripts", "bump-version.ts"), ...args], {
      cwd: work,
      env,
      encoding: "utf8",
    });
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), text);
  };
  const pkg = (version: string): string =>
    `{\n  "name": "x",\n  "version": "${version}",\n  "type": "module"\n}\n`;
  const canonical = "https://github.com/kuutti-ry/kuutti-app.git";
  try {
    mkdirSync(work);
    sh("init", "-q", "-b", "main");
    sh("init", "-q", "--bare", "-b", "main", join(dir, "main.git"));
    sh("init", "-q", "--bare", "-b", "main", join(dir, "fork.git"));
    for (const file of PACKAGES) write(file, pkg("0.33.5"));
    for (const file of GENERATED) write(file, "\n");
    write("scripts/bump-version.ts", readFileSync(import.meta.filename, "utf8"));
    sh("add", "-A");
    sh("commit", "-qm", "A");
    sh("push", "-q", join(dir, "fork.git"), "HEAD:main");
    write("package.json", pkg("0.33.6"));
    sh("commit", "-qam", "B");
    sh("push", "-q", join(dir, "main.git"), "HEAD:main");
    const tip = sh("rev-parse", "HEAD");
    sh("checkout", "-qb", "feat", "HEAD~1");
    sh("remote", "add", "origin", join(dir, "fork.git"));
    sh("config", "remote.upstream.url", canonical);
    sh("config", `url.${join(dir, "main.git")}.insteadOf`, canonical);
    sh("branch", "upstream/main", "HEAD");

    const refused = script("patch");
    expect(
      "the clone: a branch on an older main, refused before it writes",
      [refused.status, refused.stderr.split("\n")[0], sh("status", "--porcelain")],
      [
        1,
        `✖ this branch, feat, does not contain main's tip ${tip.slice(0, 7)} (0.33.6): rebase onto upstream/main first, then bump — counted from main, the version lines can conflict on a branch that does not contain it`,
        "",
      ],
    );

    // #333's branch: main's next number, by hand, on the old base.
    write("package.json", pkg("0.33.7"));
    sh("commit", "-qam", "bump");
    const pushed = script("--check-ahead", "HEAD");
    expect(
      "the clone: the hook refuses #333's branch",
      [pushed.status, pushed.stderr.trim()],
      [
        1,
        "✖ main has bumped since this branch's base, from 0.33.5 to 0.33.6: rebase onto upstream/main, then pnpm version:bump patch (or minor)",
      ],
    );
    sh("checkout", "-qb", "rebased", tip);
    write("package.json", pkg("0.33.7"));
    sh("commit", "-qam", "bump");
    const passed = script("--check-ahead", "HEAD");
    expect("the clone: the hook passes it on main's tip", [passed.status, passed.stderr], [0, ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
} else if (argv[0] === "--check-ahead") {
  checkAhead(argv[1] ?? "HEAD");
} else {
  bump(argv[0]);
}
