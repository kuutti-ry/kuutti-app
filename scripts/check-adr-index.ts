/**
 * check-adr-index: docs/adr/README.md is the index of the architecture
 * decision records and the bridge to the private decisions log (#203). It
 * holds the index to the records and to the docs, so that neither drifts:
 *
 * The records' table, one row per record, six cells:
 * - a row for every docs/adr/NNN-*.md and a file for every row, each once, the
 *   row's number its file's; two records of one number (two branches that
 *   each took the next one) fail.
 * - the status, word for word as the record's `- Status:` line, and the date
 *   as its `- Date:` line.
 * - the TD cell names the TD numbers the record cites anywhere in its text, as
 *   a set, and reads `none` when it cites none.
 *
 * The TD table, one row per TD number, four cells:
 * - a row for TD-1 up to the highest row, with no gap; a TD a record or a doc
 *   cites has a row.
 * - the Records cell names every record that cites the TD and no other, or
 *   reads `no ADR`.
 * - the last cell names every doc that cites the TD: CLAUDE.md,
 *   CONTRIBUTING.md, `.claude/rules/*.md`, `docs/**` outside `docs/adr/`, and
 *   the README at the root of an app, a package, a service and `infra/`. A
 *   file is named by its path or its basename, a README with its folder. A
 *   name may point outside that set (a slice's README, for a TD no record
 *   decides), but every name is a tracked file that cites the TD.
 * - the second cell, what a TD is about, is people's words and is not checked.
 *
 * A citation is `TD-n`; `TD-a to TD-b` cites every number between, except the
 * range that spans the whole log (CLAUDE.md's "TD-1 to TD-19"), which names
 * the log and no decision.
 *
 * Usage: node scripts/check-adr-index.ts [--self-test]
 * No dependencies. Needs Node 22.18+ (type stripping) and git (the tracked docs).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectProblems } from "./lib/self-test.ts";

type Adr = { file: string; status: string | undefined; date: string | undefined; tds: Set<number> };
type Doc = { path: string; tds: Set<number> };
/** pool: every tracked Markdown file outside docs/adr; docs: those the last cell must name. */
type Repo = { adrs: Adr[]; index: string; pool: Doc[] };

const ROOT = join(import.meta.dirname, "..");
const ADR_DIR = join(ROOT, "docs", "adr");
const INDEX = "README.md";
const ADR_FILE = /^\d{3}-[a-z0-9-]+\.md$/;
const ROW = /^\|\s*\[ADR-(\d{3})\]\(([^)]+)\)/;
const TD_ROW = /^\|\s*TD-(\d+)\s*\|/;
const CITATION = /TD-(\d+)(?:\s+to\s+TD-(\d+))?/g;
const ADR_NAME = /ADR-(\d{3})/g;
const FILE_NAME = /[\w.@-]+(?:\/[\w.@-]+)*\.md\b/g;
const DOCS =
  /^(?:CLAUDE\.md|CONTRIBUTING\.md|\.claude\/rules\/[^/]+\.md|docs\/(?!adr\/).+\.md|(?:apps|packages|services)\/[^/]+\/README\.md|infra\/README\.md)$/;

function headerLine(text: string, key: string): string | undefined {
  return new RegExp(`^- ${key}: (.+)$`, "m").exec(text)?.[1]?.trim();
}

/** The TD numbers a text cites; `log` is the highest TD, whose whole range names the log. */
export function citations(text: string, log: number): Set<number> {
  const out = new Set<number>();
  for (const match of text.matchAll(CITATION)) {
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from === 1 && to === log && to > from) continue;
    for (let n = from; n <= to; n++) out.add(n);
  }
  return out;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function td(n: number): string {
  return `TD-${n}`;
}

function sorted(set: Set<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((n) => b.has(n));
}

function named(path: string, name: string): boolean {
  return path === name || path.endsWith(`/${name}`);
}

function recordProblems(adrs: Adr[], index: string, log: number): string[] {
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
    const row_ = cells(line);
    if (row_.length !== 6) {
      problems.push(
        `ADR-${number}: its row has ${row_.length} cells, not six: ADR, title, status, date, TD, note`,
      );
      continue;
    }
    const [, , status = "", date = "", tdCell = ""] = row_;
    if (adr.status !== undefined && status !== adr.status) {
      problems.push(
        `ADR-${number}: the index says "${status}"\n    ${file} says "${adr.status}"\n    copy the record's Status line into its row`,
      );
    }
    if (adr.date !== undefined && date !== adr.date) {
      problems.push(`ADR-${number}: the index dates it ${date}, ${file} says ${adr.date}`);
    }
    const cited = citations(tdCell, log);
    if (adr.tds.size === 0 && tdCell !== "none") {
      problems.push(`ADR-${number}: cites no TD, so its TD cell reads "none", not "${tdCell}"`);
    } else if (adr.tds.size > 0 && !sameSet(cited, adr.tds)) {
      problems.push(
        `ADR-${number}: its TD cell names ${sorted(cited).map(td).join(", ") || "nothing"}, the record cites ${sorted(adr.tds).map(td).join(", ")}`,
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
    if (adr.date === undefined) {
      problems.push(`${adr.file} has no "- Date:" line in its header`);
    }
    if (!listed.has(adr.file)) {
      problems.push(`${adr.file} is not in the index: add its row to docs/adr/README.md`);
    }
  }
  return problems;
}

function tdProblems(adrs: Adr[], index: string, pool: Doc[], log: number): string[] {
  const problems: string[] = [];
  const docs = pool.filter((doc) => DOCS.test(doc.path));
  const rows = new Map<number, string[]>();
  for (const line of index.split(/\r?\n/)) {
    const row = TD_ROW.exec(line);
    if (!row) continue;
    const n = Number(row[1]);
    if (rows.has(n)) {
      problems.push(`the TD table lists ${td(n)} twice`);
      continue;
    }
    rows.set(n, cells(line));
  }
  const cited = new Set<number>();
  for (const adr of adrs) for (const n of adr.tds) cited.add(n);
  for (const doc of docs) for (const n of doc.tds) cited.add(n);
  const highest = Math.max(log, ...cited);
  for (let n = 1; n <= highest; n++) {
    const row = rows.get(n);
    if (row === undefined) {
      const by = [
        ...adrs.filter((adr) => adr.tds.has(n)).map((adr) => adr.file),
        ...docs.filter((doc) => doc.tds.has(n)).map((doc) => doc.path),
      ];
      problems.push(
        `the TD table has no row for ${td(n)}${by.length > 0 ? `, which ${by.join(", ")} cite` : ""}`,
      );
      continue;
    }
    if (row.length !== 4) {
      problems.push(
        `${td(n)}: its row has ${row.length} cells, not four: TD, about, records, docs`,
      );
      continue;
    }
    const [, , recordsCell = "", docsCell = ""] = row;
    const listed = new Set([...recordsCell.matchAll(ADR_NAME)].map((match) => match[1] ?? ""));
    const citing = new Set(
      adrs.filter((adr) => adr.tds.has(n)).map((adr) => /^\d{3}/.exec(adr.file)?.[0] ?? ""),
    );
    if (citing.size === 0 && recordsCell !== "no ADR") {
      problems.push(`${td(n)}: no record cites it, so its Records cell reads "no ADR"`);
    }
    for (const number of citing) {
      if (!listed.has(number))
        problems.push(`${td(n)}: ADR-${number} cites it and its Records cell leaves it out`);
    }
    for (const number of listed) {
      if (!citing.has(number))
        problems.push(`${td(n)}: its Records cell names ADR-${number}, which does not cite it`);
    }
    const names = [...docsCell.matchAll(FILE_NAME)].map((match) => match[0]);
    for (const doc of docs) {
      if (doc.tds.has(n) && !names.some((name) => named(doc.path, name))) {
        problems.push(`${td(n)}: ${doc.path} cites it and the row's last cell does not name it`);
      }
    }
    for (const name of names) {
      if (name === "README.md") {
        problems.push(`${td(n)}: the row names README.md with no folder: which one?`);
        continue;
      }
      const files = pool.filter((doc) => named(doc.path, name));
      if (files.length === 0) {
        problems.push(
          `${td(n)}: the row names ${name}, which is not a tracked file outside docs/adr`,
        );
      } else if (!files.some((doc) => doc.tds.has(n))) {
        problems.push(`${td(n)}: the row names ${name}, which does not cite it`);
      }
    }
  }
  return problems;
}

/** The highest TD row of the index: the log's size, as the index knows it. */
export function logSize(index: string): number {
  let highest = 0;
  for (const line of index.split(/\r?\n/)) {
    const row = TD_ROW.exec(line);
    if (row) highest = Math.max(highest, Number(row[1]));
  }
  return highest;
}

export function problemsOf({ adrs, index, pool }: Repo): string[] {
  const log = logSize(index);
  return [...recordProblems(adrs, index, log), ...tdProblems(adrs, index, pool, log)];
}

function readRepo(): Repo {
  const index = readFileSync(join(ADR_DIR, INDEX), "utf8");
  const log = logSize(index);
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.length > 0);
  const adrs: Adr[] = tracked
    .filter((path) => path.startsWith("docs/adr/") && !path.endsWith(`/${INDEX}`))
    .map((path) => path.slice("docs/adr/".length))
    .sort()
    .map((file) => {
      const text = readFileSync(join(ADR_DIR, file), "utf8");
      return {
        file,
        status: headerLine(text, "Status"),
        date: headerLine(text, "Date"),
        tds: citations(text, log),
      };
    });
  const pool: Doc[] = tracked
    .filter((path) => !path.startsWith("docs/adr/"))
    .map((path) => ({ path, tds: citations(readFileSync(join(ROOT, path), "utf8"), log) }));
  return { adrs, index, pool };
}

function selfTest(): void {
  const set = (...ns: number[]) => new Set(ns);
  const adrs: Adr[] = [
    { file: "001-one.md", status: "accepted", date: "2026-01-01", tds: set(1) },
    { file: "002-two.md", status: "proposed (a | b)", date: "2026-01-02", tds: set(1, 2, 3) },
    { file: "003-three.md", status: "accepted", date: "2026-01-03", tds: set() },
  ];
  const pool: Doc[] = [
    { path: "CLAUDE.md", tds: set(1) },
    { path: ".claude/rules/db.md", tds: set(2) },
    { path: "apps/api/src/x/README.md", tds: set(3) },
    { path: "docs/runbooks/quiet.md", tds: set() },
  ];
  const [one, two, three] = adrs as [Adr, Adr, Adr];
  const row1 = "| [ADR-001](001-one.md) | One | accepted | 2026-01-01 | TD-1 | |";
  const row2 = "| [ADR-002](002-two.md) | Two | proposed (a \\| b) | 2026-01-02 | TD-1 to TD-3 | |";
  const row3 = "| [ADR-003](003-three.md) | Three | accepted | 2026-01-03 | none | rule 10 |";
  const td1 = "| TD-1 | one | ADR-001, ADR-002 | CLAUDE.md (the rules) |";
  const td2 = "| TD-2 | two | ADR-002 | `db.md` |";
  const td3 = "| TD-3 | three | ADR-002 | `apps/api/src/x/README.md` |";
  const td4 = "| TD-4 | four | no ADR | |";
  const index = (...rows: string[]) => rows.join("\n");
  const current = index(row1, row2, row3, td1, td2, td3, td4);
  const repo = (overrides: Partial<Repo>): Repo => ({ adrs, index: current, pool, ...overrides });
  const cases: Array<[string, Repo, string[]]> = [
    ["a current index", repo({}), []],
    [
      "a record left out",
      repo({ index: index(row1, row3, td1, td2, td3, td4) }),
      ["002-two.md is not in the index"],
    ],
    [
      "a row without its file",
      repo({
        index: index(
          row1,
          row2,
          row3,
          "| [ADR-004](004-four.md) | Four | accepted | 2026-01-04 | none | |",
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      ["the index names 004-four.md, which is not in docs/adr"],
    ],
    [
      "a status changed",
      repo({ index: index(row1.replace("accepted", "proposed"), row2, row3, td1, td2, td3, td4) }),
      ['ADR-001: the index says "proposed"'],
    ],
    [
      "a date changed",
      repo({
        index: index(row1.replace("2026-01-01", "2026-01-02"), row2, row3, td1, td2, td3, td4),
      }),
      ["ADR-001: the index dates it 2026-01-02, 001-one.md says 2026-01-01"],
    ],
    [
      "a row short of a cell",
      repo({ index: index(row1.replace("| 2026-01-01 ", ""), row2, row3, td1, td2, td3, td4) }),
      ["ADR-001: its row has 5 cells, not six"],
    ],
    [
      "a TD cell missing one",
      repo({
        index: index(row1, row2.replace("TD-1 to TD-3", "TD-1, TD-2"), row3, td1, td2, td3, td4),
      }),
      ["ADR-002: its TD cell names TD-1, TD-2, the record cites TD-1, TD-2, TD-3"],
    ],
    [
      "a TD cell naming one too many",
      repo({
        index: index(row1.replace("| TD-1 |", "| TD-1, TD-2 |"), row2, row3, td1, td2, td3, td4),
      }),
      ["ADR-001: its TD cell names TD-1, TD-2, the record cites TD-1"],
    ],
    [
      "a TD cell naming another",
      repo({ index: index(row1.replace("| TD-1 |", "| TD-2 |"), row2, row3, td1, td2, td3, td4) }),
      ["ADR-001: its TD cell names TD-2, the record cites TD-1"],
    ],
    [
      "a TD cell not none",
      repo({
        index: index(row1, row2, row3.replace("| none |", "| rule 10 |"), td1, td2, td3, td4),
      }),
      ['ADR-003: cites no TD, so its TD cell reads "none", not "rule 10"'],
    ],
    [
      "a row listed twice",
      repo({ index: index(row1, row1, row2, row3, td1, td2, td3, td4) }),
      ["the index lists 001-one.md twice"],
    ],
    [
      "a row of another number",
      repo({
        index: index(row1, row2.replace("[ADR-002]", "[ADR-012]"), row3, td1, td2, td3, td4),
      }),
      ["the index's row ADR-012 links 002-two.md"],
    ],
    [
      "a record without a Status or Date line",
      repo({
        adrs: [{ file: "001-one.md", status: undefined, date: undefined, tds: set(1) }],
        index: index(
          row1,
          "| TD-1 | one | ADR-001 | CLAUDE.md |",
          "| TD-2 | two | no ADR | `db.md` |",
          "| TD-3 | three | no ADR | `apps/api/src/x/README.md` |",
          td4,
        ),
      }),
      ['001-one.md has no "- Status:" line', '001-one.md has no "- Date:" line'],
    ],
    [
      "two records of one number",
      repo({
        adrs: [
          ...adrs,
          { file: "002-deux.md", status: "accepted", date: "2026-01-02", tds: set() },
        ],
        index: index(
          row1,
          row2,
          row3,
          "| [ADR-002](002-deux.md) | Deux | accepted | 2026-01-02 | none | |",
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      ["002-deux.md has the number of 002-two.md"],
    ],
    [
      "a record misnamed",
      repo({
        adrs: [...adrs, { file: "4-four.md", status: "accepted", date: "2026-01-04", tds: set() }],
      }),
      ["4-four.md is not named NNN-title.md", "4-four.md is not in the index"],
    ],
    [
      "a TD row missing",
      repo({ index: index(row1, row2, row3, td1, td3, td4) }),
      ["the TD table has no row for TD-2, which 002-two.md, .claude/rules/db.md cite"],
    ],
    [
      "a TD row listed twice",
      repo({ index: index(row1, row2, row3, td1, td2, td2, td3, td4) }),
      ["the TD table lists TD-2 twice"],
    ],
    [
      "a TD row short of a cell",
      repo({ index: index(row1, row2, row3, td1, "| TD-2 | two | ADR-002 |", td3, td4) }),
      ["TD-2: its row has 3 cells, not four"],
    ],
    [
      "a TD cited by a doc with no row",
      repo({ pool: [...pool, { path: "docs/new.md", tds: set(5) }] }),
      ["the TD table has no row for TD-5, which docs/new.md cite"],
    ],
    [
      "a Records cell naming a stranger",
      repo({ index: index(row1, row2, row3, td1, td2, td3.replace("ADR-002", "ADR-001"), td4) }),
      [
        "TD-3: ADR-002 cites it and its Records cell leaves it out",
        "TD-3: its Records cell names ADR-001, which does not cite it",
      ],
    ],
    [
      "a Records cell not no ADR",
      repo({ index: index(row1, row2, row3, td1, td2, td3, td4.replace("no ADR", "")) }),
      ['TD-4: no record cites it, so its Records cell reads "no ADR"'],
    ],
    [
      "a doc not named",
      repo({ pool: [...pool, { path: "docs/runbooks/loud.md", tds: set(1) }] }),
      ["TD-1: docs/runbooks/loud.md cites it and the row's last cell does not name it"],
    ],
    [
      "a slice README not named needs no name",
      repo({ pool: [...pool, { path: "apps/api/src/y/README.md", tds: set(1) }] }),
      [],
    ],
    [
      "a name of no file",
      repo({
        index: index(
          row1,
          row2,
          row3,
          td1.replace("CLAUDE.md", "CLAUDE.md, `gone.md`"),
          td2,
          td3,
          td4,
        ),
      }),
      ["TD-1: the row names gone.md, which is not a tracked file outside docs/adr"],
    ],
    [
      "a name that does not cite",
      repo({
        index: index(
          row1,
          row2,
          row3,
          td1.replace("CLAUDE.md", "CLAUDE.md, `quiet.md`"),
          td2,
          td3,
          td4,
        ),
      }),
      ["TD-1: the row names quiet.md, which does not cite it"],
    ],
    [
      "a bare README",
      repo({
        index: index(
          row1,
          row2,
          row3,
          td1,
          td2,
          td3.replace("`apps/api/src/x/README.md`", "`apps/api/src/x/README.md`, README.md"),
          td4,
        ),
      }),
      ["TD-3: the row names README.md with no folder"],
    ],
    // attack: a status that differs from the record's by one capital
    [
      "a status in another case",
      repo({ index: index(row1.replace("accepted", "Accepted"), row2, row3, td1, td2, td3, td4) }),
      ['ADR-001: the index says "Accepted"'],
    ],
    // control: the record has the capital too
    [
      "a status with its record's capital",
      repo({
        adrs: [{ ...one, status: "Accepted" }, two, three],
        index: index(row1.replace("accepted", "Accepted"), row2, row3, td1, td2, td3, td4),
      }),
      [],
    ],
    // attack: a status with one more space inside it than the record's
    [
      "a status with a space more",
      repo({
        index: index(row1, row2.replace("proposed (a", "proposed  (a"), row3, td1, td2, td3, td4),
      }),
      ['ADR-002: the index says "proposed  (a | b)"'],
    ],
    // control: the record has the space too
    [
      "a status with its record's spaces",
      repo({
        adrs: [one, { ...two, status: "proposed  (a | b)" }, three],
        index: index(row1, row2.replace("proposed (a", "proposed  (a"), row3, td1, td2, td3, td4),
      }),
      [],
    ],
    // attack: a record amended since, its row left as it was
    [
      "a record amended, its row not",
      repo({
        adrs: [{ ...one, status: "accepted, amended 2026-02-01 (§2; see History)" }, two, three],
      }),
      ['ADR-001: the index says "accepted"'],
    ],
    // control: the row copies the amended line
    [
      "a record amended, its row too",
      repo({
        adrs: [{ ...one, status: "accepted, amended 2026-02-01 (§2; see History)" }, two, three],
        index: index(
          row1.replace("accepted", "accepted, amended 2026-02-01 (§2; see History)"),
          row2,
          row3,
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      [],
    ],
    // attack: a record struck out of the index, its row still there
    [
      "a row struck through",
      repo({
        index: index(
          row1,
          row2.replace("[ADR-002](002-two.md)", "~~[ADR-002](002-two.md)~~"),
          row3,
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      ["002-two.md is not in the index"],
    ],
    // control: the row as it is written
    ["a row not struck through", repo({ index: index(row1, row2, row3, td1, td2, td3, td4) }), []],
    // attack: a TD cell that gives the record's range backwards
    [
      "a range backwards",
      repo({
        index: index(row1, row2.replace("TD-1 to TD-3", "TD-3 to TD-1"), row3, td1, td2, td3, td4),
      }),
      ["ADR-002: its TD cell names nothing, the record cites TD-1, TD-2, TD-3"],
    ],
    // control: the same numbers one by one
    [
      "a range number by number",
      repo({
        index: index(
          row1,
          row2.replace("TD-1 to TD-3", "TD-3, TD-2, TD-1"),
          row3,
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      [],
    ],
    // attack: a TD cell that gives the record's range with a dash
    [
      "a range with a dash",
      repo({
        index: index(row1, row2.replace("TD-1 to TD-3", "TD-1–TD-3"), row3, td1, td2, td3, td4),
      }),
      ["ADR-002: its TD cell names TD-1, TD-3, the record cites TD-1, TD-2, TD-3"],
    ],
    // control: the range with the word to, and a space more on each side of it
    [
      "a range with to",
      repo({
        index: index(
          row1,
          row2.replace("TD-1 to TD-3", "TD-1  to  TD-3"),
          row3,
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      [],
    ],
    // attack: a doc in a folder whose name only starts like the records' cites a TD unnamed
    [
      "a doc beside the records, not named",
      repo({ pool: [...pool, { path: "docs/adr-notes/x.md", tds: set(1) }] }),
      ["TD-1: docs/adr-notes/x.md cites it and the row's last cell does not name it"],
    ],
    // control: the cell names it
    [
      "a doc beside the records, named",
      repo({
        pool: [...pool, { path: "docs/adr-notes/x.md", tds: set(1) }],
        index: index(
          row1,
          row2,
          row3,
          td1.replace("CLAUDE.md", "CLAUDE.md, `docs/adr-notes/x.md`"),
          td2,
          td3,
          td4,
        ),
      }),
      [],
    ],
    // attack: the README of infra cites a TD unnamed
    [
      "infra's README, not named",
      repo({ pool: [...pool, { path: "infra/README.md", tds: set(1) }] }),
      ["TD-1: infra/README.md cites it and the row's last cell does not name it"],
    ],
    // control: the cell names it with its folder
    [
      "infra's README, named",
      repo({
        pool: [...pool, { path: "infra/README.md", tds: set(1) }],
        index: index(
          row1,
          row2,
          row3,
          td1.replace("CLAUDE.md", "CLAUDE.md, `infra/README.md`"),
          td2,
          td3,
          td4,
        ),
      }),
      [],
    ],
    // attack: a Records cell that says no ADR and then more
    [
      "no ADR and more",
      repo({ index: index(row1, row2, row3, td1, td2, td3, td4.replace("no ADR", "no ADR yet")) }),
      ['TD-4: no record cites it, so its Records cell reads "no ADR"'],
    ],
    // control: the two words alone, with a note in the last cell
    [
      "no ADR and a note elsewhere",
      repo({
        index: index(row1, row2, row3, td1, td2, td3, "| TD-4 | four, none yet | no ADR | |"),
      }),
      [],
    ],
    // attack: a TD cell with words beside its numbers is refused
    [
      "a TD cell with words",
      repo({
        index: index(
          row1.replace("| TD-1 |", "| TD-1 (identity) |"),
          row2,
          row3,
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      [],
    ],
    // control: words and a number the record does not cite
    [
      "a TD cell with words and a stranger",
      repo({
        index: index(
          row1.replace("| TD-1 |", "| TD-1 (not TD-2) |"),
          row2,
          row3,
          td1,
          td2,
          td3,
          td4,
        ),
      }),
      ["ADR-001: its TD cell names TD-1, TD-2, the record cites TD-1"],
    ],
  ];
  for (const [name, given, expected] of cases) expectProblems(name, problemsOf(given), expected);
  const ranges: Array<[string, number[]]> = [
    ["TD-1 and TD-7", [1, 7]],
    ["TD-10 to TD-15", [10, 11, 12, 13, 14, 15]],
    ["the log (TD-1 to TD-19) and TD-6", [6]],
    ["TD-1 to TD-19", []],
    ["no decision here", []],
  ];
  for (const [text, expected] of ranges) {
    const got = sorted(citations(text, 19));
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      console.error(
        `✖ self-test, citations of "${text}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
      process.exit(1);
    }
  }
  if (logSize(current) !== 4) {
    console.error(`✖ self-test, logSize: expected 4, got ${logSize(current)}`);
    process.exit(1);
  }
  console.log(`✔ check-adr-index self-test: ${cases.length + ranges.length + 1} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const repo = readRepo();
const problems = problemsOf(repo);
for (const problem of problems) console.error(`✖ ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(
  `✔ check-adr-index: ${repo.adrs.length} records in docs/adr/README.md, each with its status, its date and its TDs; ${logSize(repo.index)} TDs mapped to the records and the docs that cite them`,
);
