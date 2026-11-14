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

/** Fixtures in common wire encodings, plus identity-code and email patterns. */
export function leakedFixtures(lines: LogLine[]): string[] {
  const texts = new Set([JSON.stringify(lines)]);
  // A request may have been logged as a URL, form or encoded body. Decode a
  // bounded number of layers, never treating a malformed encoding as clean.
  for (let layer = 0; layer < 2; layer++) {
    for (const text of [...texts]) {
      try {
        texts.add(decodeURIComponent(text.replace(/\+/g, " ")));
      } catch {
        /* The original text is still checked. */
      }
      for (const token of text.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? []) {
        const decoded = Buffer.from(token, "base64").toString("utf8");
        if (!/[\p{Cc}\ufffd]/u.test(decoded.replace(/[\r\n\t]/g, ""))) texts.add(decoded);
      }
    }
  }
  const out = [...texts].join("\n").toLowerCase();
  const structured = out.replace(/\\+"/g, '"');
  const found = new Set(
    Object.entries(FIXTURES)
      .filter(([, value]) => out.includes(value.toLowerCase()))
      .map(([name]) => name),
  );
  if (/\b\d{6}[+\-abcdefyxwvu]\d{3}[0-9a-y]\b/i.test(out)) found.add("hetu");
  if (/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(out)) found.add("email");
  if (/"seeks"\s*:\s*\[/.test(structured)) found.add("seeks");
  for (const address of out.match(/[0-9a-f]*:[0-9a-f:]+/g) ?? []) {
    try {
      const canonical = new URL(`http://[${address}]/`).hostname;
      if (canonical === `[${FIXTURES.ipv6}]`) found.add("ipv6");
      if (canonical.startsWith(`[${FIXTURES.ipv6Prefix}:`)) found.add("ipv6Prefix");
      if (canonical === "[::ffff:cb00:712f]") found.add("ipv4");
    } catch {
      /* A timestamp or another colon-separated value is not an address. */
    }
  }
  return [...found];
}
