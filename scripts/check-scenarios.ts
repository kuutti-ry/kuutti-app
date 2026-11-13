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
 * Usage: node scripts/check-scenarios.ts [--list] [--self-test]
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expectProblems } from "./lib/self-test.ts";

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
  return parseFeatureText(relative(ROOT, file), readFileSync(file, "utf8"));
}

/** The scenarios of one feature file's text, named by its path. */
function parseFeatureText(file: string, text: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const lines = text.split(/\r?\n/);
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
        file,
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
  for (const file of files) addTestNames(names, relative(ROOT, file), readFileSync(file, "utf8"));
  return names;
}

/** Adds the string literals of one test file's text, named by its path. */
function addTestNames(names: Map<string, string[]>, file: string, text: string): void {
  const source = withoutComments(text);
  for (const match of source.matchAll(STRING_LITERAL)) {
    const literal = match[2] ?? "";
    if (literal === "") continue;
    const holders = names.get(literal) ?? [];
    holders.push(file);
    names.set(literal, holders);
  }
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
  const { errors, pending, implemented } = judge(scenarios, testNames, list);

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

/** What is wrong with the scenarios, given the literals of the tests, and how many are pending or implemented. */
function judge(
  scenarios: Scenario[],
  testNames: Map<string, string[]>,
  list: boolean,
): { errors: string[]; pending: number; implemented: number } {
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
  return { errors, pending, implemented };
}

function selfTest(): void {
  const NAME = "A like is refused";
  const feature = (...lines: string[]) => ["Feature: Likes", ...lines].join("\n");
  const test = (name: string) => `it(${JSON.stringify(name)}, () => {});\n`;
  const missing = (name = NAME) => [`scenario without a test: "${name}"`];
  const withText = ["    Given a text", '      """', "      Scenario: Quoted", '      """'];
  // What it is, the feature files, a test file, and what is wrong.
  const cases: Array<[string, string[], string, string[]]> = [
    ["a scenario with its test", [feature(`  Scenario: ${NAME}`)], test(NAME), []],
    ["a scenario without one", [feature(`  Scenario: ${NAME}`)], "", missing()],
    [
      "an outline with its describe",
      [feature(`  Scenario Outline: ${NAME}`)],
      `describe(${JSON.stringify(NAME)}, () => {});`,
      [],
    ],
    ["a pending scenario", [feature("  @pending", `  Scenario: ${NAME}`)], "", []],
    ["a pending feature", [`@pending\n${feature(`  Scenario: ${NAME}`)}`], "", []],
    [
      "two scenarios of one name",
      [feature(`  Scenario: ${NAME}`, `  Scenario: ${NAME}`)],
      test(NAME),
      [`duplicate scenario name "${NAME}"`],
    ],
    [
      "a scenario without a name",
      [feature("  Scenario:")],
      "",
      ["scenario without a name", 'scenario without a test: ""'],
    ],
    // attack: a scenario written with the keyword Example needs no test
    ["an Example without a test", [feature(`  Example: ${NAME}`)], "", missing()],
    // control: the same with its test
    ["an Example with its test", [feature(`  Example: ${NAME}`)], test(NAME), []],
    // attack: an outline written as a Scenario Template needs no test
    ["a Template without a test", [feature(`  Scenario Template: ${NAME}`)], "", missing()],
    // control: the same with its test
    ["a Template with its test", [feature(`  Scenario Template: ${NAME}`)], test(NAME), []],
    // attack: a scenario under a Rule needs no test
    ["under a Rule, no test", [feature("  Rule: One", `    Scenario: ${NAME}`)], "", missing()],
    // control: the same with its test
    ["under a Rule, its test", [feature("  Rule: One", `    Scenario: ${NAME}`)], test(NAME), []],
    // attack: the tag with a capital exempts a scenario
    ["tagged @Pending", [feature("  @Pending", `  Scenario: ${NAME}`)], "", missing()],
    // control: the tag as it is spelt
    ["tagged @pending", [feature("  @pending", `  Scenario: ${NAME}`)], "", []],
    // attack: a tag that only starts with the word exempts a scenario
    ["tagged @pending-later", [feature("  @pending-later", `  Scenario: ${NAME}`)], "", missing()],
    // control: the tag beside another on its line
    ["tagged @later @pending", [feature("  @later @pending", `  Scenario: ${NAME}`)], "", []],
    // attack: the tag written in a comment exempts a scenario
    ["the tag in a comment", [feature("  # @pending", `  Scenario: ${NAME}`)], "", missing()],
    // control: the tag on its own line under the comment
    [
      "the tag under a comment",
      [feature("  # not yet", "  @pending", `  Scenario: ${NAME}`)],
      "",
      [],
    ],
    // attack: a pending Rule exempts the scenarios of the Rule after it
    [
      "after a pending Rule",
      [
        feature(
          "  @pending",
          "  Rule: One",
          "    Scenario: A",
          "  Rule: Two",
          `    Scenario: ${NAME}`,
        ),
      ],
      "",
      missing(),
    ],
    // control: the scenario inside the pending Rule
    ["in a pending Rule", [feature("  @pending", "  Rule: One", `    Scenario: ${NAME}`)], "", []],
    // attack: a pending scenario exempts the one after it
    [
      "after a pending scenario",
      [feature("  @pending", "  Scenario: A", `  Scenario: ${NAME}`)],
      "",
      missing(),
    ],
    // control: the tag on the scenario itself
    ["the pending scenario itself", [feature("  @pending", `  Scenario: ${NAME}`)], "", []],
    // attack: a test named in other capitals counts
    [
      "a test in other capitals",
      [feature(`  Scenario: ${NAME}`)],
      test("a like is refused"),
      missing(),
    ],
    // control: the name to the letter
    ["a test to the letter", [feature(`  Scenario: ${NAME}`)], test(NAME), []],
    // attack: a test whose name only starts with the scenario's counts
    ["a longer test name", [feature(`  Scenario: ${NAME}`)], test(`${NAME} twice`), missing()],
    // control: both tests
    [
      "a longer name and the name",
      [feature(`  Scenario: ${NAME}`)],
      test(`${NAME} twice`) + test(NAME),
      [],
    ],
    // attack: a test that is commented out, a line each, counts
    ["a test in line comments", [feature(`  Scenario: ${NAME}`)], `// ${test(NAME)}`, missing()],
    // control: the same line as code
    ["the same line as code", [feature(`  Scenario: ${NAME}`)], `  ${test(NAME)}`, []],
    // attack: a test inside a block comment counts
    [
      "a test in a block comment",
      [feature(`  Scenario: ${NAME}`)],
      `/* ${test(NAME)} */`,
      missing(),
    ],
    // control: the test after the comment has ended
    [
      "a test after a block comment",
      [feature(`  Scenario: ${NAME}`)],
      `/* old */ ${test(NAME)}`,
      [],
    ],
    // attack: one name in two feature files passes
    [
      "one name in two files",
      [feature(`  Scenario: ${NAME}`), feature(`  Scenario: ${NAME}`)],
      test(NAME),
      [`duplicate scenario name "${NAME}" at f1.feature:2 (first at f0.feature:2)`],
    ],
    // control: two names in two files
    [
      "two names in two files",
      [feature(`  Scenario: ${NAME}`), feature("  Scenario: A")],
      test(NAME) + test("A"),
      [],
    ],
    // attack: a scenario in a file with Windows line ends needs no test
    ["Windows line ends, no test", [`Feature: Likes\r\n  Scenario: ${NAME}\r\n`], "", missing()],
    // control: the same with its test
    ["Windows line ends, its test", [`Feature: Likes\r\n  Scenario: ${NAME}\r\n`], test(NAME), []],
    // attack: the scenario after a step's text is not read
    [
      "after a step's text, no test",
      [feature("  Scenario: A", ...withText, `  Scenario: ${NAME}`)],
      test("A"),
      missing(),
    ],
    // control: the same with its test
    [
      "after a step's text, its test",
      [feature("  Scenario: A", ...withText, `  Scenario: ${NAME}`)],
      test("A") + test(NAME),
      [],
    ],
    // attack: a scenario's line quoted in a step's text is asked for a test
    ["a line quoted in a text", [feature("  Scenario: A", ...withText)], test("A"), []],
    // control: the same line outside the text
    [
      "the same line as a scenario",
      [feature("  Scenario: A", "  Scenario: Quoted")],
      test("A"),
      missing("Quoted"),
    ],
  ];
  for (const [name, features, source, expected] of cases) {
    const names = new Map<string, string[]>();
    addTestNames(names, "a.test.ts", source);
    const scenarios = features.flatMap((text, i) => parseFeatureText(`f${i}.feature`, text));
    expectProblems(name, judge(scenarios, names, false).errors, expected);
  }
  console.log(`✔ check-scenarios self-test: ${cases.length} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

process.exitCode = main();
