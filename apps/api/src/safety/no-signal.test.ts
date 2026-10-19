import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A block is a filter, never a signal (#84, ADR-030 §7, CLAUDE.md Product
// constraints): no ordering, score, exposure floor, card or count reads one,
// and being blocked is not counted against anybody, since being blocked is
// too often only being unwanted. A report feeds moderation and nothing else,
// and so does a conversation's frozen copy (`report_message`, #351, ADR-030
// §12), which holds both people's words. So the statements that name any of
// the three tables, or the database's block test, are in the files listed
// here and nowhere else in the apps or the database package; a new reader is
// a decision, made here in review. Tests and
// comments are not read; SQL across lines, the schema-qualified name and
// drizzle's builder are.

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
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/**
 * Whether the source reads or writes the table: in SQL, the keyword and the
 * name across any whitespace, a line break included, with or without the
 * schema and quotes; through drizzle's builder, the table handed to a
 * from, join, insert, update or delete.
 */
function names(source: string, table: string): boolean {
  const code = withoutComments(source);
  const sql = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(public\\.)?"?${table}"?(?![\\w])`, "i");
  const builder = new RegExp(
    `\\.(from|innerJoin|leftJoin|rightJoin|fullJoin|insert|update|delete)\\(\\s*(\\w+\\.)?${table}\\s*[,)]`,
  );
  return sql.test(code) || builder.test(code);
}

function readersOf(test: (source: string) => boolean): string[] {
  const found = new Set<string>();
  for (const dir of SCANNED) {
    for (const file of sources(resolve(ROOT, dir))) {
      if (test(readFileSync(file, "utf8"))) found.add(relative(ROOT, file));
    }
  }
  return [...found].sort();
}

const readsBlock = (source: string) =>
  names(source, "block") || /blocked_between/.test(withoutComments(source));
const readsReport = (source: string) => names(source, "report");
const readsMessage = (source: string) => names(source, "message");
const readsReportCopy = (source: string) =>
  names(source, "report_message") || names(source, "reportMessage");

describe("the guard's own reading", () => {
  it.each([
    ["a statement across lines", "db.query(`SELECT count(*) FROM\n  block bl WHERE x`)"],
    ["the schema named", "EXISTS (SELECT 1 FROM public.block WHERE x)"],
    ["a quoted name", 'DELETE FROM "block" WHERE x'],
    ["drizzle's builder", "await db.select().from(block)"],
    ["drizzle's builder through the schema", "db.delete(schema.block).where(x)"],
    ["a join through the builder", "q.innerJoin(block, eq(a, b))"],
    ["the database's block test", "WHERE NOT blocked_between($1, $2)"],
  ])("finds %s", (_, source) => {
    expect(readsBlock(source)).toBe(true);
  });

  it.each([
    ["a comment", "// SELECT 1 FROM block\n/* JOIN block */ const x = 1;"],
    ["another table of the same stem", "SELECT 1 FROM block_pair WHERE x"],
    ["a word in a sentence", '"Blocking again, or blocking somebody who blocked first"'],
    ["an address in a string", 'const u = "https://x/from/block";'],
  ])("leaves %s alone", (_, source) => {
    expect(readsBlock(source)).toBe(false);
  });

  it("reads a report's table the same way", () => {
    expect(readsReport("SELECT 1 FROM\n public.report r")).toBe(true);
    expect(readsReport("db.insert(report).values(x)")).toBe(true);
    expect(readsReport("SELECT 1 FROM report_outcome")).toBe(false);
  });

  it("tells a conversation's copy from its report", () => {
    expect(readsReportCopy("INSERT INTO report_message (report_id) SELECT 1")).toBe(true);
    expect(readsReportCopy('SELECT body FROM\n "report_message" rm')).toBe(true);
    expect(readsReportCopy("db.select().from(reportMessage)")).toBe(true);
    expect(readsReportCopy("db.select().from(schema.reportMessage)")).toBe(true);
    expect(readsReportCopy("SELECT 1 FROM report r")).toBe(false);
    // The copy is not its report, nor the report the copy.
    expect(readsReport("INSERT INTO report_message (report_id) SELECT 1")).toBe(false);
  });
});

describe("blocks and reports", () => {
  it("Nothing but the filters reads a block", () => {
    expect(readersOf(readsBlock)).toEqual([
      // The conversation: a block ends it for both, and its blocker never sees it again (ADR-030 §2, ADR-031 §2).
      "apps/api/src/chat/repo.ts",
      // The gate's count: who is in whose pool (ADR-015 §1).
      "apps/api/src/jobs/pond-gate.ts",
      // Today's round: seen and the decision ask at the write (ADR-030 §2, ADR-034).
      "apps/api/src/matching/rounds.ts",
      // The photos a card showed (ADR-008 §3).
      "apps/api/src/media/repo.ts",
      // The card (ADR-009 §6).
      "apps/api/src/profile/repo.ts",
      // The block itself, and the person's own blocks for their export.
      "apps/api/src/safety/blocks.ts",
      // The demo's reset and the synthetic population's removal (ADR-030 §10).
      "packages/db/src/seed/write-population.ts",
    ]);
  });

  it("feed moderation alone: only the safety slice and the demo's removal read a report", () => {
    expect(readersOf(readsReport)).toEqual([
      // The panel's queue and the front page's count of it (#311).
      "apps/api/src/safety/report-queue.ts",
      "apps/api/src/safety/reports.ts",
      "packages/db/src/seed/write-population.ts",
    ]);
  });

  it("a message is read in the chat slice and the demo's own writers alone, so its words stay where they are compared (#105)", () => {
    expect(readersOf(readsMessage)).toEqual([
      // The chat's statements: the thread, the copy, and the openers the rules compare in memory.
      "apps/api/src/chat/repo.ts",
      // The demo's stories write their conversations' lines.
      "packages/db/src/seed/conversations.ts",
    ]);
  });

  it("a conversation's copy is written by the chat's copy and read by the moderators, the hold and the prune alone", () => {
    expect(readersOf(readsReportCopy)).toEqual([
      // The copy itself, one INSERT … SELECT from the thread under the conversation's lock.
      "apps/api/src/chat/repo.ts",
      // The moderators' opened report and its copy's photos, behind conversation.view and photo.view (#312).
      "apps/api/src/safety/report-queue.ts",
      // The photos a copy holds through an erasure, and the night's prune of them.
      "apps/api/src/safety/reports.ts",
    ]);
  });
});
