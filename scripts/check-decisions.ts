/**
 * check-decisions: docs/decisions.md, the register of product decisions,
 * has a row for every matching_config key and names no key that is gone
 * (#396).
 *
 * - The keys are the ones the migrations write: every `'key', '<json>'::jsonb`
 *   pair of an INSERT INTO "matching_config" in packages/db/drizzle, less those
 *   a later DELETE FROM "matching_config" takes away and under the name a later
 *   UPDATE "matching_config" gives them, read in the migrations' order (#500,
 *   ADR-060 §6, ADR-013 §17). The seed carries the same rows (migrate.test.ts
 *   holds the two identical), and a deployed database holds only what the
 *   migrations wrote.
 * - The register names a key in a table's Where cell as a bare lowercase word
 *   in backticks, `like_expiry_days`. A constant is upper case and a file has a
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
const QUOTED = /'([a-z][a-z0-9_]*)'/g;
const RENAME = /SET "key" = '([a-z][a-z0-9_]*)' WHERE "key" = '([a-z][a-z0-9_]*)'/;
const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/;

/** The keys that stand after a migration, given those that stood before it, statement by statement. */
function keysAfter(before: readonly string[], sql: string): string[] {
  const keys = new Set(before);
  for (const statement of sql.split(";")) {
    if (/INSERT INTO "matching_config"/.test(statement)) {
      for (const pair of statement.matchAll(PAIR)) keys.add(pair[1] ?? "");
    } else if (/DELETE FROM "matching_config"/.test(statement)) {
      for (const quoted of statement.matchAll(QUOTED)) keys.delete(quoted[1] ?? "");
    } else if (/UPDATE "matching_config"/.test(statement)) {
      const [, renamed, was] = statement.match(RENAME) ?? [];
      if (renamed && was && keys.delete(was)) keys.add(renamed);
    }
  }
  return [...keys];
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
  (1, 'like_expiry_days', '12'::jsonb, 'migration:0007'),
  (1, 'photo_fetches_per_day', '{"thumb": 600, "full": 60}'::jsonb, 'migration:0010')
ON CONFLICT ("key", "version") DO NOTHING;
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'default_pond', '"suomi"'::jsonb, 'migration:0025'
  FROM "matching_config" WHERE "key" = 'default_pond';
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT "version" + 1, 'photo_fetches_per_day', jsonb_set("value", '{card}', '0'::jsonb), 'migration:0104'
  FROM "matching_config" WHERE "key" = 'photo_fetches_per_day' ORDER BY "version" DESC LIMIT 1;
INSERT INTO "ponds" ("slug", "name") VALUES ('suomi', 'Suomi');`;
  const parsed = keysAfter([], sql);
  const expectedKeys = ["like_expiry_days", "photo_fetches_per_day", "default_pond"];
  const deleted = keysAfter(
    keysAfter(
      parsed,
      `DELETE FROM "matching_config"\n WHERE "key" IN ('like_expiry_days', 'gone');`,
    ),
    `DELETE FROM "ponds" WHERE "slug" = 'default_pond';`,
  );
  const expectedDeleted = ["photo_fetches_per_day", "default_pond"];
  const renamed = keysAfter(
    keysAfter(
      deleted,
      `UPDATE "matching_config" SET "key" = 'first_pond' WHERE "key" = 'default_pond';`,
    ),
    `UPDATE "matching_config" SET "key" = 'unborn' WHERE "key" = 'never_written';`,
  );
  const expectedRenamed = ["photo_fetches_per_day", "first_pond"];
  const again = keysAfter(
    deleted,
    `INSERT INTO "matching_config" ("version", "key", "value") VALUES (1, 'like_expiry_days', '10'::jsonb);`,
  );
  const expectedAgain = ["photo_fetches_per_day", "default_pond", "like_expiry_days"];
  for (const [what, got, expected] of [
    ["the migrations' keys", parsed, expectedKeys],
    ["a key a later migration deletes", deleted, expectedDeleted],
    ["a key a later migration renames", renamed, expectedRenamed],
    ["a key written again after it was deleted", again, expectedAgain],
  ] as const) {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      console.error(`✖ self-test, ${what}: expected ${JSON.stringify(expected)}`);
      console.error(`  got ${JSON.stringify(got)}`);
      process.exit(1);
    }
  }
  const keys = ["like_expiry_days", "default_pond"];
  const header =
    "| Decision | Value | Where | Recorded in | Source | Review |\n|---|---|---|---|---|---|";
  const row = (where: string) => `| A rule | 10 | ${where} | ADR-035 | maintainer | |`;
  const both = `${header}\n${row("`like_expiry_days`")}\n${row("`default_pond`, `SEED_PONDS` in `packages/db/src/seed.ts`")}`;
  const cases: Array<[string, string, string[]]> = [
    ["every key with a row", both, []],
    [
      "a key left out",
      `${header}\n${row("`like_expiry_days`")}`,
      ["matching_config default_pond has no row"],
    ],
    [
      "a key gone",
      `${both}\n${row("`like_expiry_days_old`")}`,
      ["docs/decisions.md names `like_expiry_days_old` in a Where cell"],
    ],
    [
      "a key named outside the Where cell",
      `${header}\n${row("`like_expiry_days`")}\n| The pond \`default_pond\` | x | \`apps/api/src/pond/index.ts\` | | | |`,
      ["matching_config default_pond has no row"],
    ],
    [
      "one key in each of two tables",
      `${header}\n${row("`like_expiry_days`")}\n\n## Pond\n\n${header}\n${row("`default_pond`")}`,
      [],
    ],
    [
      "a table without a Where column",
      "| Session | Read |\n|---|---|\n| `like_expiry_days` | yes |",
      ["docs/decisions.md has no table with a Where column"],
    ],
    [
      "a cell with an escaped bar",
      `${header}\n| A \\| rule | 10 | \`like_expiry_days\` | | | |\n${row("`default_pond`")}`,
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
  console.log(`✔ check-decisions self-test: ${cases.length + 4} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const keys = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .reduce<string[]>(
    (held, file) => keysAfter(held, readFileSync(join(MIGRATIONS, file), "utf8")),
    [],
  );
const problems = problemsOf(keys, readFileSync(join(ROOT, REGISTER), "utf8"));
for (const problem of problems) console.error(`✖ ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(
  `✔ check-decisions: ${keys.length} matching_config keys, each with a row in ${REGISTER}`,
);
