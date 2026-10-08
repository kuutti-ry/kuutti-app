/**
 * check-licenses: every installed dependency is under a licence the policy
 * allows, or is a named exception with its reason (#16 C.2).
 *
 * - Policy: scripts/license-policy.json. The allow-list is also the
 *   allow-licenses list of .github/dependency-review-config.yml (the pull
 *   request check for new dependencies); this script fails when they differ.
 * - Reads the `license` field of every package.json under node_modules.
 *   `pnpm licenses list` cannot: with the hoisted layout (TD-2, Metro) it looks
 *   for a virtual store that does not exist and reports every package Unknown.
 * - SPDX expressions are evaluated: `A OR B` passes when either side does,
 *   `A AND B` when both do, `X WITH exception` as X.
 * - An exception that matches nothing fails too, so the file never rots.
 *
 * Usage: node scripts/check-licenses.ts [--list] [--self-test]
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Policy = {
  allow: string[];
  exceptions: Array<{ name: string; license: string; reason: string }>;
  /** GitHub Actions the workflows use under a licence outside `allow`: CI tools, never shipped. */
  actions?: Array<{ name: string; license: string; reason: string }>;
};

const ROOT = process.cwd();

/** True when the SPDX expression can be satisfied with allowed licences only. */
export function allowed(expression: string, allow: ReadonlySet<string>): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const next = (): string | undefined => tokens[position++];

  const atom = (): boolean => {
    const token = next();
    if (token === undefined) return false;
    if (token === "(") {
      const inner = or();
      if (next() !== ")") return false;
      return inner;
    }
    let ok = allow.has(token.replace(/\+$/, ""));
    // "X WITH some-exception" grants more than X, never less.
    if (peek()?.toUpperCase() === "WITH") {
      next();
      if (next() === undefined) ok = false;
    }
    return ok;
  };
  const and = (): boolean => {
    let ok = atom();
    while (peek()?.toUpperCase() === "AND") {
      next();
      ok = atom() && ok;
    }
    return ok;
  };
  const or = (): boolean => {
    let ok = and();
    while (peek()?.toUpperCase() === "OR") {
      next();
      ok = and() || ok;
    }
    return ok;
  };

  const result = or();
  return position === tokens.length && result;
}

function licenseOf(manifest: Record<string, unknown>): string {
  const field = manifest.license;
  if (typeof field === "string" && field.trim().length > 0) return field.trim();
  if (typeof field === "object" && field !== null && "type" in field) return String(field.type);
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((entry) => (typeof entry === "object" && entry !== null ? entry.type : entry))
      .join(" OR ");
  }
  return "NONE";
}

/** name@version to licence, for every package installed anywhere in the workspace. */
function installed(): Map<string, { name: string; license: string }> {
  const found = new Map<string, { name: string; license: string }>();
  const visit = (dir: string): void => {
    // A symlink under node_modules is a workspace package: ours, AGPL-3.0 with
    // the store exception (LICENSE), or MIT for packages/tunnistus-oidc
    // (ADR-017). Recognised by what it is, not by its name,
    // so a registry package called @kuutti/anything is checked like any other.
    if (lstatSync(dir).isSymbolicLink()) return;
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) return;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        found.set(`${manifest.name}@${manifest.version}`, {
          name: manifest.name,
          license: licenseOf(manifest),
        });
      }
    } catch {
      // Not a package manifest (a fixture inside a package): nothing to check.
    }
    walk(join(dir, "node_modules"));
  };
  const walk = (modules: string): void => {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith(".")) continue;
      const dir = join(modules, entry);
      if (entry.startsWith("@")) for (const scoped of readdirSync(dir)) visit(join(dir, scoped));
      else visit(dir);
    }
  };
  const workspaces = ["apps", "packages", "services"].flatMap((group) =>
    existsSync(join(ROOT, group))
      ? readdirSync(join(ROOT, group)).map((name) => join(ROOT, group, name))
      : [],
  );
  for (const root of [ROOT, ...workspaces]) walk(join(root, "node_modules"));
  return found;
}

function selfTest(): void {
  const allow = new Set(["MIT", "Apache-2.0", "BSD-3-Clause"]);
  const cases: Array<[string, boolean]> = [
    ["MIT", true],
    ["GPL-2.0-only", false],
    ["(MIT OR GPL-2.0)", true],
    ["(BSD-3-Clause OR GPL-2.0)", true],
    ["MIT AND Apache-2.0", true],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT OR Apache-2.0) AND GPL-3.0-only", false],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["Apache 2.0", false],
    ["NONE", false],
    ["MIT OR", false],
    ["", false],
  ];
  for (const [expression, expected] of cases) {
    if (allowed(expression, allow) !== expected) {
      console.error(`✖ self-test: allowed(${JSON.stringify(expression)}) should be ${expected}`);
      process.exit(1);
    }
  }
  console.log(`✔ check-licenses self-test: ${cases.length} expressions`);
}

/** One list of the dependency review configuration, by its key. */
function reviewList(key: string): string[] {
  const path = join(ROOT, ".github", "dependency-review-config.yml");
  if (!existsSync(path)) return [];
  const block =
    new RegExp(`^${key}:\\n((?:\\s+-\\s+.+\\n?)+)`, "m").exec(readFileSync(path, "utf8"))?.[1] ??
    "";
  return [...block.matchAll(/-\s+["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm)].map((m) =>
    (m[1] ?? "").trim(),
  );
}

/** The SPDX id of a GitHub repository's licence, as GitHub detects it; undefined when unreachable. */
function repositoryLicense(name: string): string | undefined {
  try {
    const out = execFileSync("gh", ["api", `repos/${name}`, "--jq", ".license.spdx_id"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

if (process.argv.includes("--self-test")) selfTest();

const policy = JSON.parse(
  readFileSync(join(ROOT, "scripts", "license-policy.json"), "utf8"),
) as Policy;
const allow = new Set(policy.allow);
const problems: string[] = [];

// The pull-request check reads its own file; both of its lists mirror the policy.
const same = (a: string[], b: string[]): boolean => [...a].sort().join() === [...b].sort().join();
if (!same(reviewList("allow-licenses"), policy.allow)) {
  problems.push(
    "allow-licenses in .github/dependency-review-config.yml differs from `allow` in scripts/license-policy.json",
  );
}
const exceptionUrls = [
  ...policy.exceptions.map((e) => `pkg:npm/${e.name.replace("@", "%40")}`),
  // An action is a dependency of the workflows, not of the packages: the pull
  // request check sees it as pkg:githubactions, and nothing here installs it.
  // (The review config's list holds bare items only: a comment line inside
  // it would end the block for reviewList.)
  ...(policy.actions ?? []).map((a) => `pkg:githubactions/${a.name}`),
];
if (!same(reviewList("allow-dependencies-licenses"), exceptionUrls)) {
  problems.push(
    "allow-dependencies-licenses in .github/dependency-review-config.yml differs from the exceptions in scripts/license-policy.json",
  );
}

const packages = installed();
const usedExceptions = new Set<number>();
let checked = 0;
for (const [id, { name, license }] of packages) {
  checked++;
  if (allowed(license, allow)) continue;
  const index = policy.exceptions.findIndex((e) => e.name === name && e.license === license);
  if (index >= 0) {
    usedExceptions.add(index);
    continue;
  }
  problems.push(
    `${id}: ${license} is outside the allow-list. Remove the dependency, or add an exception with the reason to scripts/license-policy.json`,
  );
}

// A platform binary is installed on one platform only, so its exception may
// match nothing here, but only while its family is in use: either the package
// it belongs to (@sentry/cli for @sentry/cli-linux-x64) is an exception in use,
// or another platform's binary of the same family is (sharp's libvips builds,
// @img/sharp-libvips-<platform>, which have no package of their own: the family
// is then named by a bare entry, in use whenever one of its platforms is).
const PLATFORM_SUFFIX = /-(darwin|linux|linuxmusl|win32|android|freebsd|wasm32)(-.+)?$/;
const namesInUse = new Set([...usedExceptions].map((index) => policy.exceptions[index]?.name));
const familiesInUse = new Set(
  [...usedExceptions].map((index) =>
    (policy.exceptions[index]?.name ?? "").replace(PLATFORM_SUFFIX, ""),
  ),
);
const declared = new Set(policy.exceptions.map((e) => e.name));
policy.exceptions.forEach((exception, index) => {
  if (usedExceptions.has(index)) return;
  const base = exception.name.replace(PLATFORM_SUFFIX, "");
  if (
    base !== exception.name &&
    (namesInUse.has(base) || (declared.has(base) && familiesInUse.has(base)))
  )
    return;
  if (base === exception.name && familiesInUse.has(base)) return;
  problems.push(
    `exception for ${exception.name} (${exception.license}) matches no installed package: delete it`,
  );
});

// A GitHub Action the workflows run under a licence outside `allow` (`actions`
// in the policy) ships nowhere, so the exemption costs nothing; it still stays
// specific to what the maintainer read. The action must be in use by a
// workflow, and its repository's licence, as GitHub reports it, must be the one
// named, so a change of licence brings the entry back for review instead of
// passing under the URL's blanket exemption in the dependency review check.
const workflowsDir = join(ROOT, ".github", "workflows");
const workflows = existsSync(workflowsDir)
  ? readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => readFileSync(join(workflowsDir, file), "utf8"))
      .join("\n")
  : "";
const notes: string[] = [];
for (const action of policy.actions ?? []) {
  const used = new RegExp(
    `^\\s*-?\\s*uses:\\s*${action.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@`,
    "m",
  );
  if (!used.test(workflows)) {
    problems.push(
      `action ${action.name} (${action.license}) is used by no workflow: delete its entry`,
    );
    continue;
  }
  const reported = repositoryLicense(action.name);
  if (reported === undefined) {
    const line = `licence of the action ${action.name} not read from GitHub (offline, or gh not signed in): the policy names ${action.license}`;
    // CI has a token, so there the lookup has to work.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) problems.push(line);
    else notes.push(line);
  } else if (reported !== action.license) {
    problems.push(
      `action ${action.name}: GitHub reports ${reported}, the policy names ${action.license}: review the entry`,
    );
  }
}

if (process.argv.includes("--list")) {
  const counts = new Map<string, number>();
  for (const { license } of packages.values()) counts.set(license, (counts.get(license) ?? 0) + 1);
  for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(6)}  ${license}`);
  }
}

for (const note of notes) console.warn(`• ${note}`);
for (const problem of problems) console.error(`✖ ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(
  `✔ check-licenses: ${checked} packages, ${policy.allow.length} allowed licences, ${usedExceptions.size} exceptions in use, ${(policy.actions ?? []).length} actions`,
);
