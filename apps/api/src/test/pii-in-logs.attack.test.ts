import { expect } from "vitest";
import { attack } from "./attack.ts";
import type { LogLine } from "./harness.ts";
import { FIXTURES, leakedFixtures } from "./pii-fixtures.ts";

// Attacks on what the PII-in-logs test looks for (#380): "a test fails on PII
// patterns in log output" (CLAUDE.md Testing; .claude/rules/api.md, Events and
// logs). Each case is a log line that carries something personal in a form
// the search may not read, and a line of the same form that carries nothing.

const line = (payload: unknown): LogLine[] => [{ level: 30, msg: "debug", payload }];
const nothingFound = (seen: string[]) => expect(seen).toEqual([]);

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

/**
 * What is tried, what the line carries, what a harmless line of that form
 * carries, and whether it goes through today.
 */
const CARRIED: [string, unknown, unknown, string?][] = [
  // Something personal that is not one of the test's own fixtures: the search
  // is for the fixtures' own values, letter for letter, and for no pattern.
  ["an identity code other than the test's own", "131052-308T", "not a code", HOLE],
  ["an e-mail address other than the test's own", "someone@example.fi", "nobody", HOLE],
  [
    "whom a person seeks",
    JSON.stringify({ seeks: ["women", "men"] }),
    JSON.stringify({ ok: true }),
    QUESTION,
  ],
  // The test's own fixtures, as something else would write them: the same
  // value in another encoding, case or length is another run of letters.
  [
    "the test's e-mail address as a URL carries it",
    encodeURIComponent(FIXTURES.email),
    encodeURIComponent("nobody at all"),
    HOLE,
  ],
  [
    "the test's message as a query string carries it",
    new URLSearchParams({ text: FIXTURES.message }).toString(),
    new URLSearchParams({ text: "nothing" }).toString(),
    HOLE,
  ],
  [
    "the test's request body in base64",
    Buffer.from(JSON.stringify({ hetu: FIXTURES.hetu, email: FIXTURES.email })).toString("base64"),
    Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
    HOLE,
  ],
  ["the test's identity code in lower case", FIXTURES.hetu.toLowerCase(), "010190", HOLE],
  [
    "the test's IPv6 address written out in full",
    "2001:0db8:4711:0000:0000:0000:0000:0047",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    HOLE,
  ],
  ["the test's IPv6 address in capitals", FIXTURES.ipv6.toUpperCase(), "2001:DB8::1", HOLE],
  [
    "the /64 of the test's IPv6 address with its zeros",
    "2001:0db8:4711:0000::/64",
    "2001:0db8::/64",
    HOLE,
  ],
  [
    "the test's IPv4 address inside an IPv6 one, in hex",
    "::ffff:cb00:712f",
    "::ffff:c000:0201",
    QUESTION,
  ],
  // Forms the search has to read like the plain ones.
  [
    "the test's identity code in a body made a string twice",
    JSON.stringify(JSON.stringify({ hetu: FIXTURES.hetu })),
    JSON.stringify(JSON.stringify({ ok: true })),
  ],
  ["the test's IPv4 address with its port", `${FIXTURES.ipv4}:4711`, "192.0.2.1:4711"],
  ["the test's IPv4 address as a socket gives it", `::ffff:${FIXTURES.ipv4}`, "::ffff:192.0.2.1"],
  [
    "the /64 of the test's IPv6 address as the limiter keys it",
    "2001:db8:4711:0::/64",
    "2001:db8::/64",
  ],
  [
    "the test's e-mail address among other words",
    `to <${FIXTURES.email}> failed`,
    "to nobody failed",
  ],
  ["the test's session token after Bearer", `Bearer ${FIXTURES.token}`, "Bearer nothing"],
];

for (const [name, personal, harmless, open] of CARRIED) {
  attack(`PII in logs: ${name} reaches a log line unseen`, {
    attempt: () => leakedFixtures(line(personal)),
    control: () => leakedFixtures(line(harmless)),
    succeeds: nothingFound,
    open,
  });
}
