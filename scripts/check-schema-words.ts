/**
 * check-schema-words: the database never gets a column for what the project
 * promised not to store (rules 1 and 3, TD-1, TD-14): the personal identity
 * code, legal sex, a full date of birth, a name from the bank, a client's
 * network address (ADR-026 §7).
 *
 * Scans the committed migrations and the Drizzle schema for forbidden
 * identifiers as whole words, and for the address words also as a segment of
 * a snake_case name (ip_hash, last_ip, client_ip_hash), never as letters
 * inside a word (zip, tip, relationship). Exit 1 with every hit.
 *
 * Usage: node scripts/check-schema-words.ts [--self-test]
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expectProblems } from "./lib/self-test.ts";

const ROOT = process.cwd();
const SCHEMA = [
  "packages/db/src/schema",
  "packages/db/src/schema.ts",
  "packages/db/src/schema.mts",
  "packages/db/src/schema.cts",
];
const FORBIDDEN = [
  "hetu",
  "personal_identity_code",
  "personalidentitycode",
  "ssn",
  "legal_sex",
  "legalsex",
  "sex",
  "birth_day",
  "birthday",
  "birth_date",
  "birthdate",
  "date_of_birth",
  "dateofbirth",
  "dob",
  "full_name",
  "first_name",
  "last_name",
  "legal_name",
  "given_name",
  "givenname",
  "family_name",
  "familyname",
  "firstname",
  "lastname",
  "henkilotunnus",
  "personbeteckning",
  "hetu_plain",
  "raw_hetu",
  "sex_at_birth",
  "sexatbirth",
  "legal_gender",
  "legalgender",
  "day_of_birth",
  "dayofbirth",
];
// The limiter keys on the address in memory only (ADR-026 §7). A segment is
// enough: ip covers ip_address, last_ip and client_ip_hash alike.
const ADDRESS_WORDS = [
  "ip",
  "ipaddress",
  "clientip",
  "ips",
  "client_addr",
  "clientaddr",
  "ipv4",
  "ipv6",
  "inet",
  "cidr",
  "client_address",
  "remote_address",
  "remote_addr",
  "viewer_address",
  "forwarded_for",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    if (statSync(dir).isFile()) return /\.(sql|[cm]?ts|json)$/i.test(dir) ? [...out, dir] : out;
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(sql|[cm]?ts|json)$/i.test(entry)) out.push(path);
  }
  return out;
}

// A whole identifier: no letter, digit or underscore on either side.
const whole = new RegExp(`(?<![A-Za-z0-9_])(${FORBIDDEN.join("|")})(?![A-Za-z0-9_])`, "gi");
// A snake_case segment: an underscore may stand on either side.
const segment = new RegExp(`(?<![A-Za-z0-9])(${ADDRESS_WORDS.join("|")})(?![A-Za-z0-9])`, "gi");

/** The forbidden identifiers of one file's text, named by its path, a hit per word and line. */
function hitsIn(name: string, text: string): string[] {
  const hits: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
    for (const m of [...line.matchAll(whole), ...line.matchAll(segment)]) {
      hits.push(`${name}:${i + 1}: "${m[1]}" in: ${line.trim()}`);
    }
  });
  return hits;
}

function scan(root: string): string[] {
  const migrations = walk(join(root, "packages/db/drizzle"));
  const schema = SCHEMA.flatMap((path) => walk(join(root, path)));
  const hits =
    migrations.length === 0 || schema.length === 0
      ? ["no migrations or Drizzle schema to read: run from the repository root"]
      : [];
  for (const file of [...migrations, ...schema]) {
    hits.push(...hitsIn(relative(root, file), readFileSync(file, "utf8")));
  }
  return hits;
}

function selfTest(): void {
  // What it is, a line of a migration or of the schema, and the words it is refused for.
  const cases: Array<[string, string, string[]]> = [
    ["the personal identity code", '"hetu" text', ["hetu"]],
    ["the code's HMAC, which is what is kept", '"hetu_hmac" text NOT NULL', []],
    ["legal sex", '"sex" text', ["sex"]],
    ["a full date of birth", '"birth_date" date', ["birth_date"]],
    ["the year and the month, which are kept", '"birth_year" integer, "birth_month" integer', []],
    ["a name from the bank", '"legal_name" text', ["legal_name"]],
    ["an address as a segment of a name", '"client_ip_hash" text', ["ip"]],
    ["letters inside a word", '"zip" text, "tip" text, "relationship" text', []],
    ["a comment's line", "  // the hetu is never stored", []],
    // attack: the identity code's column in capitals
    ["the identity code in capitals", '"HETU" text', ["HETU"]],
    // control: its HMAC in capitals
    ["the HMAC in capitals", '"HETU_HMAC" text', []],
    // attack: a date of birth as a camel-case property of the schema
    ["a date of birth in camel case", 'dateOfBirth: date("born"),', ["dateOfBirth"]],
    // control: the month, in the same form
    ["a month of birth in camel case", 'monthOfBirth: integer("born"),', []],
    // attack: the identity code spelled out as a camel-case property
    [
      "the code spelled out in camel case",
      'personalIdentityCode: text("pic"),',
      ["personalIdentityCode"],
    ],
    // control: a property that only starts the same
    ["a note in camel case", 'personalNote: text("pic"),', []],
    // attack: a date of birth as drizzle's snapshot names a column
    ["a date of birth in a snapshot", '"name": "birthdate",', ["birthdate"]],
    // control: the month, in the same form
    ["a month of birth in a snapshot", '"name": "birth_month",', []],
    // attack: an address as a camel-case property
    ["an address in camel case", 'ipAddress: text("a"),', ["ipAddress"]],
    // control: a postal code, in the same form
    ["a postal code in camel case", 'zipAddress: text("a"),', []],
    // attack: a column whose type is an address
    ["a column of the type inet", '"seen_from" inet,', ["inet"]],
    // control: the same column as text
    ["the same column as text", '"seen_from" text,', []],
    // attack: a proxy's header kept as a column
    ["the forwarded-for header", '"x_forwarded_for" text', ["forwarded_for"]],
    // control: another header of the proxy's
    ["the forwarded-proto header", '"x_forwarded_proto" text', []],
    // attack: a forbidden column after a block comment on its line
    ["the identity code after a comment", '/* note */ "hetu" text;', ["hetu"]],
    // control: the HMAC, in the same form
    ["the HMAC after a comment", '/* note */ "hetu_hmac" text;', []],
    // attack: a column refused for the letters of dob inside its name
    ["a word that only starts with dob", '"dobby" text', []],
    // control: the abbreviation itself
    ["the abbreviation of a date of birth", '"dob" date', ["dob"]],
    // attack: a column refused for the letters of inet inside its name
    ["a word that only ends with inet", '"cabinet" text', []],
    // control: the type's name as a segment
    ["inet as a segment of a name", '"inet_seen" text', ["inet"]],
  ];
  for (const [name, line, words] of cases) {
    expectProblems(
      name,
      hitsIn("x", line),
      words.map((word) => `x:1: "${word}" in: `),
    );
  }
  const aliases = [
    "given_name",
    "family_name",
    "firstName",
    "henkilotunnus",
    "personbeteckning",
    "hetu_plain",
    "raw_hetu",
    "sex_at_birth",
    "legal_gender",
    "day_of_birth",
    "clientIp",
    "ips",
    "client_addr",
  ];
  for (const name of aliases) {
    expectProblems(`forbidden alias ${name}`, hitsIn("x", `"${name}" text`), [`x:1: "${name}"`]);
  }
  const fixture = mkdtempSync(join(tmpdir(), "kuutti-schema-words-"));
  try {
    expectProblems("an empty checkout", scan(fixture), ["no migrations or Drizzle schema to read"]);
    mkdirSync(join(fixture, "packages/db/drizzle"), { recursive: true });
    mkdirSync(join(fixture, "packages/db/src"), { recursive: true });
    writeFileSync(join(fixture, "packages/db/drizzle/0001.SQL"), 'CREATE TABLE x ("hetu" text);');
    writeFileSync(
      join(fixture, "packages/db/src/schema.mts"),
      'export const email = text("safe");',
    );
    expectProblems("an uppercase migration beside a flat mts schema", scan(fixture), [
      'packages/db/drizzle/0001.SQL:1: "hetu"',
    ]);
    writeFileSync(join(fixture, "packages/db/drizzle/0001.SQL"), 'CREATE TABLE x ("id" text);');
    writeFileSync(
      join(fixture, "packages/db/src/schema.ts"),
      'export const firstName = text("name");',
    );
    expectProblems("a flat schema file", scan(fixture), [
      'packages/db/src/schema.ts:1: "firstName"',
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  console.log(`✔ check-schema-words self-test: ${cases.length + aliases.length + 3} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const hits = scan(ROOT);

if (hits.length > 0) {
  console.error("✖ forbidden identifiers in the database schema (rules 1 and 3, ADR-026 §7):");
  for (const h of hits) console.error(`  ${h}`);
  process.exitCode = 1;
} else {
  console.log("✔ no forbidden identifiers in migrations or schema");
}
