/**
 * check-adr-index: docs/adr/README.md lists every architecture decision record
 * with its status, word for word as the record's own Status line (#203).
 *
 * - Reads docs/adr/NNN-*.md: the status from the header's `- Status:` line.
 * - Reads the index's rows whose first cell links a record,
 *   `| [ADR-NNN](NNN-title.md) | title | status | ...`, the status in the
 *   third cell (a `|` inside a cell is written `\|`).
 * - Fails on a record the index leaves out, a row whose file does not exist,
 *   a row whose number is not its file's, a file listed twice, a record with
 *   no Status line or a name not NNN-title.md, two records of one number (two
 *   branches that each took the next one), and a status that differs.
 * - The TD columns are read by people and not checked: the decisions log is
 *   private, so nothing here could check them against it.
 *
 * Usage: node scripts/check-adr-index.ts [--self-test]
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Adr = { file: string; status: string | undefined };

const ADR_DIR = join(import.meta.dirname, "..", "docs", "adr");
const INDEX = "README.md";
const ADR_FILE = /^\d{3}-[a-z0-9-]+\.md$/;
const ROW = /^\|\s*\[ADR-(\d{3})\]\(([^)]+)\)/;

function statusOf(text: string): string | undefined {
  return /^- Status: (.+)$/m.exec(text)?.[1]?.trim();
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function problemsOf(adrs: Adr[], index: string): string[] {
  const problems: string[] = [];
  const byFile = new Map(adrs.map((adr) => [adr.file, adr]));
  const listed = new Set<string>();
  for (const line of index.split(/\r?\n/)) {
    const row = ROW.exec(line);
    if (!row) continue;
    const number = row[1] ?? "";
    const file = row[2] ?? "";
    if (!file.startsWith(`${number}-`)) {
      problems.push(`the index's row ADR-${number} links ${file}, a file of another number`);
    }
    if (listed.has(file)) {
      problems.push(`the index lists ${file} twice`);
      continue;
    }
    listed.add(file);
    const adr = byFile.get(file);
    if (!adr) {
      problems.push(`the index names ${file}, which is not in docs/adr`);
      continue;
    }
    const status = cells(line)[2] ?? "";
    if (adr.status !== undefined && status !== adr.status) {
      problems.push(
        `ADR-${number}: the index says "${status}"\n    ${file} says "${adr.status}"\n    copy the record's Status line into its row`,
      );
    }
  }
  const byNumber = new Map<string, string>();
  for (const adr of adrs) {
    if (!ADR_FILE.test(adr.file)) {
      problems.push(`${adr.file} is not named NNN-title.md`);
    }
    const number = /^(\d{3})-/.exec(adr.file)?.[1];
    const first = number === undefined ? undefined : byNumber.get(number);
    if (number !== undefined && first === undefined) byNumber.set(number, adr.file);
    if (first !== undefined) {
      problems.push(
        `${adr.file} has the number of ${first}: give one of them the next free number`,
      );
    }
    if (adr.status === undefined) {
      problems.push(`${adr.file} has no "- Status:" line in its header`);
    }
    if (!listed.has(adr.file)) {
      problems.push(`${adr.file} is not in the index: add its row to docs/adr/README.md`);
    }
  }
  return problems;
}

function selfTest(): void {
  const adrs: Adr[] = [
    { file: "001-one.md", status: "accepted" },
    { file: "002-two.md", status: "proposed (a | b)" },
  ];
  const row1 = "| [ADR-001](001-one.md) | One | accepted | 2026-01-01 | TD-1 | |";
  const row2 = "| [ADR-002](002-two.md) | Two | proposed (a \\| b) | 2026-01-02 | | |";
  const cases: Array<[string, Adr[], string, string[]]> = [
    ["a current index", adrs, `${row1}\n${row2}`, []],
    ["a record left out", adrs, row1, ["002-two.md is not in the index"]],
    [
      "a row without its file",
      adrs,
      `${row1}\n${row2}\n| [ADR-003](003-three.md) | Three | accepted | | | |`,
      ["the index names 003-three.md, which is not in docs/adr"],
    ],
    [
      "a status changed",
      adrs,
      `${row1.replace("accepted", "proposed")}\n${row2}`,
      ['ADR-001: the index says "proposed"'],
    ],
    ["a row listed twice", adrs, `${row1}\n${row1}\n${row2}`, ["the index lists 001-one.md twice"]],
    [
      "a row of another number",
      adrs,
      `${row1}\n${row2.replace("[ADR-002]", "[ADR-012]")}`,
      ["the index's row ADR-012 links 002-two.md"],
    ],
    [
      "a record without a Status line",
      [{ file: "001-one.md", status: undefined }],
      row1,
      ['001-one.md has no "- Status:" line'],
    ],
    [
      "two records of one number",
      [...adrs, { file: "002-three.md", status: "accepted" }],
      `${row1}\n${row2}\n| [ADR-002](002-three.md) | Three | accepted | | | |`,
      ["002-three.md has the number of 002-two.md"],
    ],
    [
      "a record misnamed",
      [...adrs, { file: "3-three.md", status: "accepted" }],
      `${row1}\n${row2}`,
      ["3-three.md is not named NNN-title.md", "3-three.md is not in the index"],
    ],
  ];
  for (const [name, given, index, expected] of cases) {
    const problems = problemsOf(given, index);
    const matches =
      problems.length === expected.length &&
      expected.every((start, i) => problems[i]?.startsWith(start));
    if (!matches) {
      console.error(`✖ self-test, ${name}: expected ${JSON.stringify(expected)}`);
      console.error(`  got ${JSON.stringify(problems)}`);
      process.exit(1);
    }
  }
  console.log(`✔ check-adr-index self-test: ${cases.length} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const adrs: Adr[] = readdirSync(ADR_DIR)
  .filter((file) => file.endsWith(".md") && file !== INDEX)
  .sort()
  .map((file) => ({ file, status: statusOf(readFileSync(join(ADR_DIR, file), "utf8")) }));
const problems = problemsOf(adrs, readFileSync(join(ADR_DIR, INDEX), "utf8"));
for (const problem of problems) console.error(`✖ ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(
  `✔ check-adr-index: ${adrs.length} records in docs/adr/README.md, each with its status`,
);
