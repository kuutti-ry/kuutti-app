/**
 * check-decisions: docs/decisions.md, the register of product decisions,
 * has a row for every matching_config key and names no key that is gone
 * (#396).
 *
 * - The keys are the ones the migrations write: every `'key', '<json>'::jsonb`
 *   pair of an INSERT INTO "matching_config" in packages/db/drizzle. The seed
 *   carries the same rows (migrate.test.ts holds the two identical), and a
 *   deployed database holds only what the migrations wrote.
 * - The register names a key in a table's Where cell as a bare lowercase word
 *   in backticks, `round_size`. A constant is upper case and a file has a
 *   slash or a dot, so neither reads as a key.
 * - Fails on a key without a row, a Where cell naming a key no migration
 *   writes (a key renamed or dropped), and a register with no table that has
 *   a Where column.
 * - Whether a row's value and source are right is the review's: the
 *   register's draws block has check-docs ask for it (ADR-047).
 *
 * Usage: node scripts/check-decisions.ts [--self-test]
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "packages", "db", "drizzle");
const REGISTER = "docs/decisions.md";
const KEY = /^[a-z][a-z0-9_]*$/;
const PAIR = /'([a-z][a-z0-9_]*)',\s*'[^']*'::jsonb/g;
const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/;

function keysOf(sql: string): string[] {
  return sql
    .split(";")
    .filter((statement) => /INSERT INTO "matching_config"/.test(statement))
    .flatMap((statement) => [...statement.matchAll(PAIR)].map((pair) => pair[1] ?? ""));
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** The bare lowercase words in backticks of every Where cell, or undefined without a Where column. */
function namedOf(register: string): string[] | undefined {
  const lines = register.split(/\r?\n/);
  let named: string[] | undefined;
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i] ?? "";
    if (!header.startsWith("|") || !SEPARATOR.test(lines[i + 1] ?? "")) continue;
    const where = cells(header).findIndex((cell) => cell.toLowerCase() === "where");
    if (where === -1) continue;
    named ??= [];
    for (let j = i + 2; j < lines.length && (lines[j] ?? "").startsWith("|"); j++) {
      const cell = cells(lines[j] ?? "")[where] ?? "";
      for (const quoted of cell.matchAll(/`([^`]+)`/g)) {
        const word = quoted[1] ?? "";
        if (KEY.test(word)) named.push(word);
      }
    }
  }
  return named;
}

function problemsOf(keys: string[], register: string): string[] {
  const named = namedOf(register);
  if (named === undefined) {
    return [`${REGISTER} has no table with a Where column, so it names no matching_config key`];
  }
  const problems: string[] = [];
  const known = new Set(keys);
  const listed = new Set(named);
  for (const key of [...known].sort()) {
    if (!listed.has(key)) {
      problems.push(
        `matching_config ${key} has no row in ${REGISTER}: add one, its key in backticks in the Where cell`,
      );
    }
  }
  for (const word of [...listed].sort()) {
    if (!known.has(word)) {
      problems.push(
        `${REGISTER} names \`${word}\` in a Where cell, which no migration writes: a key renamed or dropped takes its row with it`,
      );
    }
  }
  return problems;
}

function selfTest(): void {
  const sql = `-- comment; with a semicolon
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'round_size', '12'::jsonb, 'migration:0007'),
  (1, 'photo_fetches_per_day', '{"thumb": 600, "full": 60}'::jsonb, 'migration:0010')
ON CONFLICT ("key", "version") DO NOTHING;
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'default_pond', '"suomi"'::jsonb, 'migration:0025'
  FROM "matching_config" WHERE "key" = 'default_pond';
INSERT INTO "ponds" ("slug", "name") VALUES ('suomi', 'Suomi');`;
  const parsed = keysOf(sql);
  const expectedKeys = ["round_size", "photo_fetches_per_day", "default_pond"];
  if (JSON.stringify(parsed) !== JSON.stringify(expectedKeys)) {
    console.error(`✖ self-test, the migrations' keys: expected ${JSON.stringify(expectedKeys)}`);
    console.error(`  got ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  const keys = ["round_size", "default_pond"];
  const header =
    "| Decision | Value | Where | Recorded in | Source | Review |\n|---|---|---|---|---|---|";
  const row = (where: string) => `| A rule | 10 | ${where} | ADR-035 | maintainer | |`;
  const both = `${header}\n${row("`round_size`")}\n${row("`default_pond`, `SEED_PONDS` in `packages/db/src/seed.ts`")}`;
  const cases: Array<[string, string, string[]]> = [
    ["every key with a row", both, []],
    [
      "a key left out",
      `${header}\n${row("`round_size`")}`,
      ["matching_config default_pond has no row"],
    ],
    [
      "a key gone",
      `${both}\n${row("`round_size_old`")}`,
      ["docs/decisions.md names `round_size_old` in a Where cell"],
    ],
    [
      "a key named outside the Where cell",
      `${header}\n${row("`round_size`")}\n| The pond \`default_pond\` | x | \`apps/api/src/pond/index.ts\` | | | |`,
      ["matching_config default_pond has no row"],
    ],
    [
      "one key in each of two tables",
      `${header}\n${row("`round_size`")}\n\n## Pond\n\n${header}\n${row("`default_pond`")}`,
      [],
    ],
    [
      "a table without a Where column",
      "| Session | Read |\n|---|---|\n| `round_size` | yes |",
      ["docs/decisions.md has no table with a Where column"],
    ],
    [
      "a cell with an escaped bar",
      `${header}\n| A \\| rule | 10 | \`round_size\` | | | |\n${row("`default_pond`")}`,
      [],
    ],
  ];
  for (const [name, register, expected] of cases) {
    const problems = problemsOf(keys, register);
    const matches =
      problems.length === expected.length &&
      expected.every((start, i) => problems[i]?.startsWith(start));
    if (!matches) {
      console.error(`✖ self-test, ${name}: expected ${JSON.stringify(expected)}`);
      console.error(`  got ${JSON.stringify(problems)}`);
      process.exit(1);
    }
  }
  console.log(`✔ check-decisions self-test: ${cases.length + 1} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const keys = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .flatMap((file) => keysOf(readFileSync(join(MIGRATIONS, file), "utf8")));
const problems = problemsOf(keys, readFileSync(join(ROOT, REGISTER), "utf8"));
for (const problem of problems) console.error(`✖ ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(
  `✔ check-decisions: ${new Set(keys).size} matching_config keys, each with a row in ${REGISTER}`,
);
