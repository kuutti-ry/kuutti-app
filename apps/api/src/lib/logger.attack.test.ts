import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { captureLogger } from "../test/harness.ts";

// Attacks on the logger's redaction (#380): a value that must never reach a
// log line (CLAUDE.md Security: Logs; the header of REDACTED_KEYS and of
// serializeError), logged under a name or in a shape the list may not read.
// The control logs the same value where it is nobody's secret, so the
// assertion is shown to see a value that reaches a line.

const SECRET = "attack-value-4711";

/** The line the production logger writes for these fields. */
async function logged(fields: Record<string, unknown>): Promise<string> {
  const { logger, lines } = await captureLogger();
  logger.info(fields, "probe");
  return JSON.stringify(lines());
}

const reaches = (line: string) => expect(line).toContain(SECRET);
const harmless = () => logged({ route: SECRET });

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

/** What is tried, the fields logged, and whether the value goes through today. */
const FIELDS: [string, Record<string, unknown>, string?][] = [
  // Another spelling of a field the list names: a field is known by its exact
  // name, letter for letter, at the top and one level down.
  ["an e-mail address under Email, with a capital", { Email: SECRET }, HOLE],
  ["an e-mail address under emailAddress", { emailAddress: SECRET }, HOLE],
  [
    "an identity code under personalIdentityCode, in camel case",
    { personalIdentityCode: SECRET },
    HOLE,
  ],
  ["a postal code under postal_code, in snake case", { postal_code: SECRET }, HOLE],
  ["a request's Authorization header under its usual capital", { Authorization: SECRET }, HOLE],
  ["several messages under messages", { messages: [SECRET] }, HOLE],
  // Credentials the list does not name.
  ["a session's token under token", { token: SECRET }, HOLE],
  ["a refresh token under refreshToken", { refreshToken: SECRET }, HOLE],
  ["a session cookie under set-cookie", { "set-cookie": SECRET }, HOLE],
  // A row of several is two levels down, its place in the list being one: past
  // what the list's header promises.
  ["an e-mail address in a list of rows", { rows: [{ email: SECRET }] }, QUESTION],
  // Forms the list has to read like the plain ones.
  ["an e-mail address one level down", { account: { email: SECRET } }],
  ["an identity code one level down", { claims: { hetu: SECRET } }],
  ["a stored contact one level down", { contact: { value: SECRET } }],
  ["a message's body at the top", { body: SECRET }],
  ["a cookie header one level down", { headers: { cookie: SECRET } }],
];

for (const [name, fields, open] of FIELDS) {
  attack(`logger: ${name} reaches a log line`, {
    attempt: () => logged(fields),
    control: harmless,
    succeeds: reaches,
    open,
  });
}

// "What of an error may reach a line: the fields that name the kind of
// failure and nothing that quotes a value."
const quoting = () =>
  Object.assign(new Error("duplicate key value"), {
    code: "23505",
    detail: `Key (email)=(${SECRET}) already exists.`,
  });
const named = () => Object.assign(new Error("duplicate key value"), { code: SECRET });

/**
 * What is tried, the fields with an error that quotes a value, the same with
 * one that names its kind, and whether the value goes through today.
 */
const ERRORS: [string, Record<string, unknown>, Record<string, unknown>, string?][] = [
  // An error is cut down to its kind only under err and error, and only while
  // it is still an Error: anywhere else its own fields are written as they are.
  ["logged under e", { e: quoting() }, { e: named() }, HOLE],
  ["logged in a list under errors", { errors: [quoting()] }, { errors: [named()] }, HOLE],
  [
    "spread into a plain object under err",
    { err: { ...quoting() } },
    { err: { ...named() } },
    HOLE,
  ],
  // Forms the serializer has to read like the plain ones.
  ["logged under err", { err: quoting() }, { err: named() }],
  ["logged under error", { error: quoting() }, { error: named() }],
  [
    "as the cause of another error under err",
    { err: new Error("failed", { cause: quoting() }) },
    { err: new Error("failed", { cause: named() }) },
  ],
];

for (const [name, quotes, names, open] of ERRORS) {
  attack(`logger: a database error's detail, ${name}, reaches a log line`, {
    attempt: () => logged(quotes),
    control: () => logged(names),
    succeeds: reaches,
    open,
  });
}
