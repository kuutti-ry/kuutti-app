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
import { expectProblems } from "./lib/self-test.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "packages", "db", "drizzle");
const REGISTER = "docs/decisions.md";
const KEY = /^[a-z][a-z0-9_]*$/;
const QUOTED = /'([a-z][a-z0-9_]*)'/g;
const RENAME =
  /SET\s+"?key"?\s*=\s*'([a-z][a-z0-9_]*)'\s+WHERE\s+"?key"?\s*=\s*'([a-z][a-z0-9_]*)'/i;
const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/;

/** SQL literals are tokens, so comments, commas and semicolons inside them cannot move a column. */
function sqlTokens(sql: string): string[] {
  return (
    sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|[a-z_][\w$]*|\d+|\S/gi) ?? []
  ).filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
}

function columns(tokens: string[]): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (depth === 0 && token.toLowerCase() === "from") break;
    if (depth === 0 && token === ",") parts.push([]);
    else parts.at(-1)?.push(token);
  }
  return parts;
}

function insertedKeys(tokens: string[], tableEnd: number): string[] {
  if (tokens[tableEnd] !== "(") throw new Error("matching_config INSERT needs explicit columns");
  const close = tokens.indexOf(")", tableEnd);
  const fields = columns(tokens.slice(tableEnd + 1, close)).map((part) =>
    part.join("").replaceAll('"', "").toLowerCase(),
  );
  const key = fields.indexOf("key");
  if (key === -1) throw new Error("matching_config INSERT has no key column");
  const rest = tokens.slice(close + 1);
  const values: string[][][] = [];
  if (rest[0]?.toLowerCase() === "select") values.push(columns(rest.slice(1)));
  else if (rest[0]?.toLowerCase() === "values") {
    let start = 1;
    while (rest[start] === "(") {
      let depth = 1;
      let end = start + 1;
      for (; end < rest.length && depth > 0; end++) {
        if (rest[end] === "(") depth++;
        if (rest[end] === ")") depth--;
      }
      if (depth !== 0) throw new Error("unclosed matching_config VALUES row");
      values.push(columns(rest.slice(start + 1, end - 1)));
      start = rest[end] === "," ? end + 1 : end;
    }
  }
  if (values.length === 0) throw new Error("unrecognised matching_config INSERT");
  return values.flatMap((row) => {
    const value = row[key]?.[0];
    const literal = value && /^'([a-z][a-z0-9_]*)'$/.exec(value)?.[1];
    if (literal) return [literal];
    // An INSERT ... SELECT that versions existing rows introduces no key.
    if (value?.replaceAll('"', "").toLowerCase() === "key") return [];
    throw new Error("matching_config key must be a literal or the existing key column");
  });
}

/** The keys that stand after a migration, given those that stood before it, statement by statement. */
function keysAfter(before: readonly string[], sql: string): string[] {
  const keys = new Set(before);
  const statements: string[][] = [[]];
  for (const token of sqlTokens(sql)) {
    if (token === ";") statements.push([]);
    else statements.at(-1)?.push(token);
  }
  for (const tokens of statements) {
    const statement = tokens.join(" ");
    const table =
      /^(?:INSERT INTO|DELETE FROM|UPDATE)\s+(?:"?public"?\s*\.\s*)?"?matching_config"?(?=\s|\(|$)/i;
    if (!table.test(statement)) continue;
    if (/^INSERT INTO/i.test(statement)) {
      const tableAt = tokens.findIndex(
        (token) => token.replaceAll('"', "").toLowerCase() === "matching_config",
      );
      for (const key of insertedKeys(tokens, tableAt + 1)) keys.add(key);
    } else if (/^DELETE FROM/i.test(statement)) {
      for (const quoted of statement.matchAll(QUOTED)) keys.delete(quoted[1] ?? "");
    } else if (/^UPDATE/i.test(statement)) {
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
  const forms = [
    `insert into matching_config (version, key, value) values (1, 'new_key', CAST('5' AS jsonb));`,
    `INSERT\nINTO "matching_config" ("key", "value", "version") VALUES ('new_key', '5' :: JSONB, 1);`,
    `INSERT /* note */ INTO public.matching_config (version, key, value) SELECT coalesce(max(version), 0) + 1, 'new_key', jsonb_build_object('text', 'a;b') FROM matching_config;`,
  ];
  for (const form of forms) {
    if (JSON.stringify(keysAfter([], form)) !== '["new_key"]')
      throw new Error(`matching_config INSERT was not read: ${form}`);
  }
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
    // attack: an update of a key's value is read as a rename and takes the key away
    [
      "a key whose value an update changes",
      keysAfter(
        expectedDeleted,
        `UPDATE "matching_config" SET "value" = '"meri"'::jsonb WHERE "key" = 'default_pond';`,
      ),
      expectedDeleted,
    ],
    // control: the same statement renaming the key
    [
      "a key the same statement renames",
      keysAfter(
        expectedDeleted,
        `UPDATE "matching_config" SET "key" = 'meri' WHERE "key" = 'default_pond';`,
      ),
      ["photo_fetches_per_day", "meri"],
    ],
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
    // attack: a key named in a Where cell without its backticks counts as a row
    [
      "a key without backticks",
      `${header}\n${row("`like_expiry_days`")}\n${row("default_pond")}`,
      ["matching_config default_pond has no row"],
    ],
    // control: the same cell with them
    [
      "a key with backticks",
      `${header}\n${row("`like_expiry_days`")}\n${row("`default_pond`")}`,
      [],
    ],
    // attack: a key named with the table's name in front counts as a row
    [
      "a key behind the table's name",
      `${header}\n${row("`like_expiry_days`")}\n${row("`matching_config.default_pond`")}`,
      ["matching_config default_pond has no row"],
    ],
    // control: the table's name outside the backticks
    [
      "the table's name beside the key",
      `${header}\n${row("`like_expiry_days`")}\n${row("matching_config `default_pond`")}`,
      [],
    ],
    // attack: a row commented out counts as a row
    [
      "a row in a comment",
      `${header}\n${row("`like_expiry_days`")}\n<!-- ${row("`default_pond`")} -->`,
      ["matching_config default_pond has no row"],
    ],
    // control: the comment after the row
    [
      "a row before a comment",
      `${header}\n${row("`like_expiry_days`")}\n${row("`default_pond`")}\n<!-- checked -->`,
      [],
    ],
    // attack: a column whose heading only starts with Where counts as the Where column
    [
      "a column headed Where it lives",
      both.replace("| Where |", "| Where it lives |"),
      ["docs/decisions.md has no table with a Where column"],
    ],
    // control: the heading in lower case
    ["a column headed where", both.replace("| Where |", "| where |"), []],
    // attack: a key that is gone hides behind a live one in the same cell
    [
      "a gone key second in a cell",
      `${header}\n${row("`like_expiry_days`, `like_expiry_hours`")}\n${row("`default_pond`")}`,
      ["docs/decisions.md names `like_expiry_hours` in a Where cell"],
    ],
    // control: two live keys in one cell
    ["two live keys in a cell", `${header}\n${row("`like_expiry_days`, `default_pond`")}`, []],
  ];
  for (const [name, register, expected] of cases) {
    expectProblems(name, problemsOf(keys, register), expected);
  }
  console.log(`✔ check-decisions self-test: ${cases.length + 6} cases`);
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
