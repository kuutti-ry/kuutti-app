/**
 * check-scenarios: every Gherkin scenario has a same-named test.
 *
 * Decision and conventions: docs/adr/002-gherkin-spec-vitest-runner.md
 *
 * - Reads features/**\/*.feature and collects Scenario, Scenario Outline and
 *   Example names, with their tags (scenario tags plus Feature and Rule tags).
 * - Reads every *.test.ts and *.test.tsx under apps/ and packages/ and collects
 *   the contents of all string literals.
 * - A scenario is implemented when its exact name is one of those literals:
 *   it("<name>", ...) for a Scenario, describe("<name>", ...) for an Outline.
 * - Scenarios tagged @pending are exempt.
 * - Fails on any non-pending scenario without a test, and on duplicate names.
 *
 * Usage: node scripts/check-scenarios.ts [--list]
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Scenario = {
  name: string;
  file: string;
  line: number;
  tags: string[];
  outline: boolean;
};

const ROOT = process.cwd();
const FEATURE_DIRS = ["features"];
const TEST_DIRS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".expo",
  ".turbo",
  "coverage",
  ".next",
]);
const PENDING_TAG = "@pending";

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(entry)) out.push(path);
  }
  return out;
}

const SCENARIO_LINE = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/;

function parseFeature(file: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let featureTags: string[] = [];
  let ruleTags: string[] = [];
  let pendingTags: string[] = [];
  let inDocString = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('"""') || line.startsWith("```")) {
      inDocString = !inDocString;
      return;
    }
    if (inDocString || line === "" || line.startsWith("#")) return;

    if (line.startsWith("@")) {
      pendingTags.push(...line.split(/\s+/).filter((t) => t.startsWith("@")));
      return;
    }
    if (line.startsWith("Feature:")) {
      featureTags = pendingTags;
      pendingTags = [];
      return;
    }
    if (line.startsWith("Rule:")) {
      ruleTags = pendingTags;
      pendingTags = [];
      return;
    }
    const match = SCENARIO_LINE.exec(line);
    if (match) {
      const keyword = match[1] ?? "";
      const name = (match[2] ?? "").trim();
      scenarios.push({
        name,
        file: relative(ROOT, file),
        line: index + 1,
        tags: [...featureTags, ...ruleTags, ...pendingTags],
        outline: keyword.startsWith("Scenario Outline") || keyword.startsWith("Scenario Template"),
      });
      pendingTags = [];
    }
  });
  return scenarios;
}

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;

/**
 * Comments go before the literals are read: an apostrophe in a prose comment
 * ("onboarding's") would otherwise open a string that swallows every test
 * name up to the next quote. Whole-line comments and block comments only; a
 * comment after code on the same line stays, since "//" also lives inside a
 * URL in a string.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function collectTestNames(files: string[]): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const file of files) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(STRING_LITERAL)) {
      const literal = match[2] ?? "";
      if (literal === "") continue;
      const holders = names.get(literal) ?? [];
      holders.push(relative(ROOT, file));
      names.set(literal, holders);
    }
  }
  return names;
}

function main(): number {
  const list = process.argv.includes("--list");

  const featureFiles = FEATURE_DIRS.flatMap((d) =>
    walk(join(ROOT, d), (n) => n.endsWith(".feature")),
  );
  const testFiles = TEST_DIRS.flatMap((d) =>
    walk(join(ROOT, d), (n) => n.endsWith(".test.ts") || n.endsWith(".test.tsx")),
  );

  const scenarios = featureFiles.flatMap(parseFeature);
  const testNames = collectTestNames(testFiles);

  const errors: string[] = [];
  const seen = new Map<string, Scenario>();
  for (const s of scenarios) {
    const first = seen.get(s.name);
    if (first) {
      errors.push(
        `duplicate scenario name "${s.name}" at ${s.file}:${s.line} (first at ${first.file}:${first.line}); names link specs to tests and must be unique`,
      );
    } else {
      seen.set(s.name, s);
    }
    if (s.name === "") errors.push(`scenario without a name at ${s.file}:${s.line}`);
  }

  let pending = 0;
  let implemented = 0;
  for (const s of scenarios) {
    const isPending = s.tags.includes(PENDING_TAG);
    const holders = testNames.get(s.name);
    if (holders) implemented += 1;
    else if (isPending) pending += 1;
    else {
      const form = s.outline ? `describe("${s.name}", ...)` : `it("${s.name}", ...)`;
      errors.push(
        `scenario without a test: "${s.name}" (${s.file}:${s.line})\n    add ${form} in a *.test.ts under apps/ or packages/, or tag it @pending`,
      );
    }
    if (list) {
      const status = holders
        ? `implemented in ${holders.join(", ")}`
        : isPending
          ? "pending"
          : "MISSING";
      console.log(`${s.file}:${s.line}  ${s.name}  [${status}]`);
    }
  }

  console.log(
    `check-scenarios: ${featureFiles.length} feature file(s), ${scenarios.length} scenario(s): ${implemented} implemented, ${pending} pending; ${testFiles.length} test file(s) scanned`,
  );
  if (errors.length > 0) {
    for (const e of errors) console.error(`✖ ${e}`);
    return 1;
  }
  console.log("✔ every non-pending scenario has a same-named test");
  return 0;
}

process.exitCode = main();
