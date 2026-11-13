import { createHash } from "node:crypto";
import type { LogLine } from "./harness.ts";

/** The verifier of a sign-in attempt, as the app makes one (ADR-027): 256 bits as lowercase hex. */
const VERIFIER_PROBE = "4711beef".repeat(8);

/**
 * The enforcement behind "logs never carry hetu, message text or email"
 * (CLAUDE.md security defaults, rule 5, #11), nor the client's address
 * (ADR-026 §7), nor what binds a sign-in code to its phone (ADR-027). Every
 * route the app registers is exercised with fixtures in the body, the query
 * string, the path and the headers, from an address in every place an
 * address can come from, and no fixture may reach a log line.
 * Routes come from the router, so a new route is covered the day it is added.
 */
export const FIXTURES = {
  hetu: "010190-123A",
  email: "pii.probe@example.fi",
  message: "private message text 4711",
  // The shape of a session token, so the middleware's lookup path runs on it.
  token: `piitoken4711${"x".repeat(31)}`,
  ipv4: "203.0.113.47",
  ipv6: "2001:db8:4711::47",
  // The /64 the limiter counts that address by, however a key would write it.
  ipv6Prefix: "2001:db8:4711",
  verifier: VERIFIER_PROBE,
  // Its SHA-256, which the start carries in the query.
  challenge: createHash("sha256").update(VERIFIER_PROBE).digest("hex"),
  // The proof of Kuutti's distribution (ADR-066): a secret, so never in a line either.
  originSecret: "pii-origin-proof-4711-4711-4711-4711",
} as const;

/** Which fixture values appear anywhere in the captured lines. */
export function leakedFixtures(lines: LogLine[]): string[] {
  const out = JSON.stringify(lines);
  return Object.entries(FIXTURES)
    .filter(([, value]) => out.includes(value))
    .map(([name]) => name);
}
