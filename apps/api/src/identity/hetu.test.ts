import { generateHetu, parseHetu } from "@kuutti-ry/tunnistus-oidc/hetu";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveIdentity, hmacKeyFromHex, InvalidHetuError } from "./hetu.ts";

// Property tests for the derivation (CLAUDE.md Testing): what leaves the
// callback is a 64-hex HMAC and a year and a month, never anything the code
// can be read back from. Seeded, so a failure names a run that repeats.

const AT = new Date("2026-10-01T12:00:00Z");
const key = Buffer.alloc(32, 0x11);
const otherKey = Buffer.alloc(32, 0x22);
const SEEDED = { seed: 20261011 };

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

/** The check characters of the register, in order (index = remainder mod 31). */
const CHECK_CHARACTERS = "0123456789ABCDEFHJKLMNPRSTUVWXY";

/** The century signs that mean the same century since the 2023 reform. */
const SAME_CENTURY = ["-YXWVU", "ABCDEF"];

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
      { ...SEEDED, numRuns: 300 },
    );
  });

  it("does not care about the case of the century sign", () => {
    fc.assert(
      fc.property(hetuArb, (hetu) => {
        expect(deriveIdentity(hetu.toLowerCase(), key, AT).hetuHmac).toBe(
          deriveIdentity(hetu.toUpperCase(), key, AT).hetuHmac,
        );
      }),
      SEEDED,
    );
  });

  it("keeps two codes that differ only in a century sign of the same century apart", () => {
    // The 2023 reform issues the same date and number again under a new sign:
    // another person, so another hash, born in the same year and month.
    fc.assert(
      fc.property(hetuArb, fc.nat(), (hetu, pick) => {
        const sign = hetu[6] ?? "";
        const family = SAME_CENTURY.find((signs) => signs.includes(sign));
        fc.pre(family !== undefined);
        const others = [...(family ?? "")].filter((s) => s !== sign);
        const other = `${hetu.slice(0, 6)}${others[pick % others.length]}${hetu.slice(7)}`;
        const a = deriveIdentity(hetu, key, AT);
        const b = deriveIdentity(other, key, AT);
        expect(b.hetuHmac).not.toBe(a.hetuHmac);
        expect({ year: b.birthYear, month: b.birthMonth }).toEqual({
          year: a.birthYear,
          month: a.birthMonth,
        });
      }),
      SEEDED,
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
      SEEDED,
    );
  });

  it("refuses every code with a wrong check character, naming the check and never the code", () => {
    fc.assert(
      fc.property(hetuArb, fc.constantFrom(...CHECK_CHARACTERS), (hetu, check) => {
        fc.pre(check !== hetu[10]);
        const wrong = `${hetu.slice(0, 10)}${check}`;
        let thrown: unknown;
        try {
          deriveIdentity(wrong, key, AT);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(InvalidHetuError);
        expect((thrown as InvalidHetuError).problem).toBe("checksum");
        expect((thrown as Error).message).not.toContain(wrong);
        expect((thrown as Error).message).not.toContain(hetu.slice(0, 6));
      }),
      SEEDED,
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

describe("hmacKeyFromHex", () => {
  it("reads any 32 bytes written as hex, in either case, and nothing else", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const hex = Buffer.from(bytes).toString("hex");
        expect(hmacKeyFromHex(hex).equals(Buffer.from(bytes))).toBe(true);
        expect(hmacKeyFromHex(hex.toUpperCase()).equals(Buffer.from(bytes))).toBe(true);
      }),
      SEEDED,
    );
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 64 }).filter((b) => b.length !== 32),
        (bytes) => {
          expect(() => hmacKeyFromHex(Buffer.from(bytes).toString("hex"))).toThrow(/32 bytes/);
        },
      ),
      SEEDED,
    );
    // Sixty-four characters that are not all hex are no key either.
    expect(() => hmacKeyFromHex(`${"ab".repeat(31)}zz`)).toThrow(/32 bytes/);
  });
});
