import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { readersOf } from "../test/sources.ts";
import { readsBlock, readsReport, readsStar } from "../test/table-readers.ts";

// Attacks on the guard of no-signal.test.ts (#380): a statement that reads a
// block, a report or a star in a form its reading may not see, so that a new
// reader would land without the review the guard's list exists for. Each case
// is the form reading a guarded table, and the same form reading `session`,
// which nobody guards.

type Reader = (source: string) => boolean;

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

/**
 * What is tried, who reads it, the form with a guarded table, the same form
 * with one nobody guards, and whether it goes through today.
 */
const UNSEEN: [string, Reader, string, string, string?][] = [
  // The guard knows a table right after FROM, JOIN, INTO or UPDATE, with an
  // unquoted schema at most, and one handed by its own name to seven of the
  // builder's calls: each row reads the table in another shape.
  [
    "a block read in a comma join",
    readsBlock,
    "db.query(`SELECT 1 FROM account a, block b WHERE b.blocked_identity_id = a.identity_id`)",
    "db.query(`SELECT 1 FROM account a, session s WHERE s.account_id = a.id`)",
    HOLE,
  ],
  [
    "a block read with its schema and its name both in quotes",
    readsBlock,
    'db.query(`SELECT count(*) FROM "public"."block"`)',
    'db.query(`SELECT count(*) FROM "public"."session"`)',
    HOLE,
  ],
  [
    "a block read in a DELETE's USING",
    readsBlock,
    "db.query(`DELETE FROM round_entries e USING block b WHERE b.id = e.id`)",
    "db.query(`DELETE FROM round_entries e USING session s WHERE s.id = e.id`)",
    HOLE,
  ],
  [
    "a block read FROM ONLY",
    readsBlock,
    "db.query(`SELECT count(*) FROM ONLY block`)",
    "db.query(`SELECT count(*) FROM ONLY session`)",
    HOLE,
  ],
  [
    "a block read from a table named by a constant",
    readsBlock,
    'const table = "block"; db.query("SELECT count(*) FROM " + table);',
    'const table = "session"; db.query("SELECT count(*) FROM " + table);',
    HOLE,
  ],
  [
    "a block read through drizzle's relational query",
    readsBlock,
    "const rows = await db.query.block.findMany();",
    "const rows = await db.query.session.findMany();",
    HOLE,
  ],
  [
    "blocks counted through drizzle's count",
    readsBlock,
    "const n = await db.$count(block, eq(block.blockedIdentityId, id));",
    "const n = await db.$count(session, eq(session.accountId, id));",
    HOLE,
  ],
  [
    "a block read in a cross join through the builder",
    readsBlock,
    "db.select().from(account).crossJoin(block)",
    "db.select().from(account).crossJoin(session)",
    HOLE,
  ],
  [
    "a block read from the table imported under another name",
    readsBlock,
    'import { block as b } from "@kuutti/db"; db.select().from(b);',
    'import { session as b } from "@kuutti/db"; db.select().from(b);',
    HOLE,
  ],
  [
    "a block read under an alias of drizzle's",
    readsBlock,
    'db.select().from(alias(block, "b"))',
    'db.select().from(alias(session, "s"))',
    HOLE,
  ],
  [
    "stars counted through drizzle's count",
    readsStar,
    "const n = await db.$count(star, eq(star.starredAccountId, id));",
    "const n = await db.$count(session, eq(session.accountId, id));",
    HOLE,
  ],
  [
    "a report read in a comma join",
    readsReport,
    "db.query(`SELECT count(*) FROM account a, report r WHERE r.reported_account_id = a.id`)",
    "db.query(`SELECT count(*) FROM account a, session s WHERE s.account_id = a.id`)",
    HOLE,
  ],
  // The guard takes comments out first: code between two strings that hold a
  // comment's marks goes with them, and so does what follows two slashes in a string.
  [
    "a block read between two strings that hold a comment's marks",
    readsBlock,
    'const kinds = "image/*";\nconst rows = await db.select().from(block);\nconst all = "*/*";',
    'const kinds = "image/*";\nconst rows = await db.select().from(session);\nconst all = "*/*";',
    HOLE,
  ],
  [
    "a block read after a string that holds two slashes",
    readsBlock,
    'const gap = " // "; const rows = await db.select().from(block);',
    'const gap = " // "; const rows = await db.select().from(session);',
    HOLE,
  ],
  // Forms the guard has to read like the plain ones.
  [
    "a block read with keywords in lower case",
    readsBlock,
    "db.query(`select count(*) from block`)",
    "db.query(`select count(*) from session`)",
  ],
  [
    "a block read in a cross join in SQL",
    readsBlock,
    "db.query(`SELECT 1 FROM account a CROSS JOIN block b`)",
    "db.query(`SELECT 1 FROM account a CROSS JOIN session s`)",
  ],
  [
    "a block read in a subquery after a comma",
    readsBlock,
    "db.query(`SELECT 1 FROM account a, LATERAL (SELECT 1 FROM block) b`)",
    "db.query(`SELECT 1 FROM account a, LATERAL (SELECT 1 FROM session) s`)",
  ],
  [
    "a block read in a builder's join across lines",
    readsBlock,
    "query.leftJoin(\n  block,\n  eq(block.blockerIdentityId, account.identityId),\n)",
    "query.leftJoin(\n  session,\n  eq(session.accountId, account.id),\n)",
  ],
  [
    "a block read in a subquery handed to the builder",
    readsBlock,
    "query.where(notExists(db.select().from(block)))",
    "query.where(notExists(db.select().from(session)))",
  ],
  [
    "a block read on a line that ends in a comment",
    readsBlock,
    "const rows = await db.select().from(block); // every block",
    "const rows = await db.select().from(session); // every session",
  ],
  [
    "a block read after an address in a string",
    readsBlock,
    'await fetch("https://kuutti.app"); const rows = await db.select().from(block);',
    'await fetch("https://kuutti.app"); const rows = await db.select().from(session);',
  ],
];

for (const [name, reads, guarded, unguarded, open] of UNSEEN) {
  attack(`no-signal: ${name} is not seen`, {
    attempt: () => reads(guarded),
    control: () => reads(unguarded),
    succeeds: (seen) => expect(seen).toBe(false),
    open,
  });
}

// A sentence is no statement: a file that only says the words is no reader.
// The guard takes "into report" for SQL wherever the two words stand.
attack(
  "no-signal: a log line that says where a photo was copied is taken for a reader of reports",
  {
    attempt: () => readsReport('logger.info({ photoId }, "photo copied into report");'),
    control: () => readsReport("db.query(`INSERT INTO report (reason) VALUES ($1)`)"),
    succeeds: (seen) => expect(seen).toBe(true),
    open: HOLE,
  },
);

// "Nowhere else in the apps or the database package": what the guard opens.
const readUnder = (folder: string) => readersOf(() => true).filter((f) => f.startsWith(folder));

/** What is tried, the folder, and whether it goes through today. */
const PLACES: [string, string, string?][] = [
  // The guard opens the .ts and .tsx files of five folders of sources, and no SQL file.
  [
    "the migrations, where the database's own functions and views are written",
    "packages/db/drizzle/",
    QUESTION,
  ],
  // Places the guard has to read like the API's slices.
  ["the API's command lines", "apps/api/scripts/"],
  ["the seed and the demo's writers", "packages/db/src/seed/"],
];

for (const [name, folder, open] of PLACES) {
  attack(`no-signal: ${name} are not read`, {
    attempt: () => readUnder(folder),
    // A package that is neither an app nor the database: rightly not read.
    control: () => readUnder("packages/i18n/"),
    succeeds: (seen) => expect(seen).toEqual([]),
    open,
  });
}
