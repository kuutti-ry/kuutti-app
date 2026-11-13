import { readFileSync } from "node:fs";
import { createPool, migrate, type Pool, withTemporaryDatabase } from "@kuutti/db";
import { afterAll, beforeAll, expect } from "vitest";
import { attack } from "../test/attack.ts";
import { MIGRATIONS } from "../test/global-setup.ts";

// Attacks on the register of personal-data.test.ts (#380): "a new table cannot
// land undecided, nor a new column on a row that outlives the person". Each
// case plants something that holds a person's data, in a transaction that is
// rolled back, and asks the catalogue what the register asks it. The register
// keeps its two questions to itself, so they are cut from its file here.

const register = readFileSync(new URL("./personal-data.test.ts", import.meta.url), "utf8");
const [TABLES, COLUMNS] = [...register.matchAll(/`(SELECT c\.relname AS name[^`]*)`/g)].map(
  (match) => match[1] ?? "",
);

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

// A migrated database of this file's own, from its first case to its last. An
// ALTER TABLE takes its table whole, and a view keeps a reader's hold on the
// table it reads until its transaction ends: in the database the suite shares,
// either would wait for the other files' transactions and then hold them up.
let own: Pool;
let leave: () => void = () => undefined;
let left: Promise<void> = Promise.resolve();

beforeAll(async () => {
  await new Promise<void>((ready, failed) => {
    left = withTemporaryDatabase(async (url) => {
      own = createPool({ connectionString: url, max: 1, applicationName: "kuutti-api-attack" });
      try {
        await migrate(own, MIGRATIONS);
        ready();
        await new Promise<void>((resolve) => {
          leave = resolve;
        });
      } finally {
        await own.end();
      }
    });
    left.catch(failed);
  });
}, 60_000);

afterAll(async () => {
  leave();
  await left.catch(() => undefined);
});

/** Plants `ddl`, asks the catalogue `question`, and leaves the database as it was. */
async function asked<Row>(ddl: string, question: string | undefined): Promise<Row[]> {
  // The register's file still holds its two questions where they are looked for.
  expect(question).toContain("pg_class");
  const client = await own.connect();
  try {
    await client.query("BEGIN");
    await client.query(ddl);
    return (await client.query(question as string)).rows as Row[];
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

const tablesAfter = async (ddl: string) =>
  (await asked<{ name: string }>(ddl, TABLES)).map((row) => row.name);

/** What is tried, what is planted under the name attack_note, and whether it goes through today. */
const PLANTED: [string, string, string?][] = [
  // The register asks for the tables of the schema `public`, and for tables alone.
  [
    "a table in a schema of its own",
    "CREATE SCHEMA attack_380; CREATE TABLE attack_380.attack_note (account_id uuid, words text)",
    HOLE,
  ],
  [
    "a materialized view that copies people's e-mail addresses",
    "CREATE MATERIALIZED VIEW attack_note AS SELECT id AS account_id, email FROM account",
    QUESTION,
  ],
  // Forms the register has to see like a plain new table.
  ["a table in the schema the app uses", "CREATE TABLE attack_note (account_id uuid, words text)"],
  [
    "a table made to be partitioned",
    "CREATE TABLE attack_note (at timestamptz, words text) PARTITION BY RANGE (at)",
  ],
  ["a table that is not logged", "CREATE UNLOGGED TABLE attack_note (account_id uuid, words text)"],
];

for (const [name, ddl, open] of PLANTED) {
  attack(`the register: ${name} lands without an entry`, {
    attempt: () => tablesAfter(ddl),
    // A plain view keeps no rows of its own: rightly no table of the register's.
    control: () => tablesAfter("CREATE VIEW attack_note AS SELECT id AS account_id FROM account"),
    succeeds: (seen) => expect(seen).not.toContain("attack_note"),
    open,
  });
}

const columnsOfIdentity = async (ddl: string) =>
  (await asked<{ name: string; columns: string[] }>(ddl, COLUMNS)).find(
    (row) => row.name === "identity",
  )?.columns ?? [];

attack("the register: a new column on the row that outlives everybody lands unnamed", {
  attempt: () => columnsOfIdentity("ALTER TABLE identity ADD COLUMN attack_words text"),
  // A column added and dropped again is no column: rightly not named.
  control: () =>
    columnsOfIdentity(
      "ALTER TABLE identity ADD COLUMN attack_words text; ALTER TABLE identity DROP COLUMN attack_words",
    ),
  succeeds: (seen) => {
    expect(seen).toContain("hetu_hmac");
    expect(seen).not.toContain("attack_words");
  },
});
