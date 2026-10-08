import { randomBytes } from "node:crypto";
import { generateHetu, parseHetu } from "@kuutti/db";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveIdentity, hmacKeyFromHex, InvalidHetuError } from "./hetu.ts";

// Property tests for the derivation (CLAUDE.md Testing): what leaves the
// callback is a 64-hex HMAC and a year and a month, never anything the code
// can be read back from.

const AT = new Date("2026-10-01T12:00:00Z");
const key = randomBytes(32);
const otherKey = randomBytes(32);

/** Valid codes of adults and minors, from the seed generator. */
const hetuArb = fc
  .tuple(fc.integer({ min: 1, max: 2 ** 31 - 2 }), fc.integer({ min: 0, max: 80 }))
  .map(([seed, age]) => {
    let x = seed;
    const rng = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    return generateHetu(rng, { at: AT, minAge: age, maxAge: age });
  });

describe("deriveIdentity", () => {
  it("is deterministic, key-dependent, and keeps only the HMAC and the birth month", () => {
    fc.assert(
      fc.property(hetuArb, (hetu) => {
        const a = deriveIdentity(hetu, key, AT);
        const b = deriveIdentity(hetu, key, AT);
        const c = deriveIdentity(hetu, otherKey, AT);
        const parsed = parseHetu(hetu);
        expect(a).toEqual(b);
        expect(a.hetuHmac).toMatch(/^[0-9a-f]{64}$/);
        expect(a.hetuHmac).not.toBe(c.hetuHmac);
        expect(a.birthYear).toBe(parsed?.birthYear);
        expect(a.birthMonth).toBe(parsed?.birthMonth);
        // Nothing of the code survives in the result's text, not even its date part.
        const text = JSON.stringify(a);
        expect(text).not.toContain(hetu);
        expect(text).not.toContain(hetu.slice(0, 6));
        expect(Object.keys(a).sort()).toEqual(["adult", "birthMonth", "birthYear", "hetuHmac"]);
      }),
      { numRuns: 300 },
    );
  });

  it("does not care about the case of the century sign", () => {
    fc.assert(
      fc.property(hetuArb, (hetu) => {
        expect(deriveIdentity(hetu.toLowerCase(), key, AT).hetuHmac).toBe(
          deriveIdentity(hetu.toUpperCase(), key, AT).hetuHmac,
        );
      }),
    );
  });

  it("decides adulthood as the parser does, at the given date", () => {
    fc.assert(
      fc.property(hetuArb, (hetu) => {
        const parsed = parseHetu(hetu);
        if (!parsed) throw new Error("generator produced an invalid code");
        const age = AT.getUTCFullYear() - parsed.birthYear;
        if (age >= 19) expect(deriveIdentity(hetu, key, AT).adult).toBe(true);
        if (age <= 17) expect(deriveIdentity(hetu, key, AT).adult).toBe(false);
      }),
    );
  });

  it("refuses an invalid code and a malformed key", () => {
    expect(() => deriveIdentity("010190-123B", key, AT)).toThrow(InvalidHetuError);
    expect(() => deriveIdentity("not a code", key, AT)).toThrow(InvalidHetuError);
    // The message names the failing check (what the callback logs), never the code.
    expect(() => deriveIdentity("010190-123B", key, AT)).toThrow(/\(checksum\)$/);
    expect(() => deriveIdentity("not a code", key, AT)).toThrow(/\(format\)$/);
    expect(() => deriveIdentity("not a code", key, AT)).not.toThrow(/not a code/);
    expect(() => hmacKeyFromHex("abc")).toThrow(/32 bytes/);
    expect(hmacKeyFromHex("ff".repeat(32))).toHaveLength(32);
  });
});
