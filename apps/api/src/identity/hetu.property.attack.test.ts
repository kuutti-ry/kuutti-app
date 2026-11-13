import fc from "fast-check";
import { describe, expect } from "vitest";
import { attack } from "../test/attack.ts";
import { findViolation } from "../test/property-attack.ts";
import { deriveIdentity, InvalidHetuError } from "./hetu.ts";

// PROPERTY pile (#380, TD-1/TD-6). Codes are built independently of the
// vendor's parser; no real identity or clock is involved. The current age
// rule conservatively admits at the end of the birth month (ADR-017).
const SEED = 3801101;
const KEY = Buffer.alloc(32, 0x38);
const AT = new Date("2026-11-01T12:00:00Z");
const CHECK = "0123456789ABCDEFHJKLMNPRSTUVWXY";
const two = (n: number) => String(n).padStart(2, "0");
function code(year: number, month: number, day: number, serial: number, sign = "A") {
  const date = `${two(day)}${two(month)}${two(year % 100)}`;
  const number = String(serial).padStart(3, "0");
  return `${date}${sign}${number}${CHECK[Number(`${date}${number}`) % 31]}`;
}
const birthday = fc.record({
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }),
  serial: fc.integer({ min: 2, max: 898 }),
});
const validCode = birthday.map(({ month, day, serial }) => code(2000, month, day, serial));
const detected = (seen: { found: boolean }) => expect(seen.found).toBe(true);

describe("identity property attacks (#380)", () => {
  const atBoundary = (
    { month, day, serial }: { month: number; day: number; serial: number },
    before: boolean,
  ) => {
    const boundary = Date.UTC(2026, month, 0);
    return deriveIdentity(
      code(2008, month, day, serial),
      KEY,
      new Date(boundary - (before ? 1 : 0)),
    ).adult;
  };
  attack("admit somebody before the eighteenth birth month's final day", {
    attempt: () => findViolation(birthday, (input) => atBoundary(input, true), SEED),
    control: () => findViolation(birthday, (input) => atBoundary(input, false), SEED),
    succeeds: detected,
  });

  const impossible = fc.record({
    month: fc.constantFrom(2, 4, 6, 9, 11),
    serial: fc.integer({ min: 2, max: 899 }),
  });
  function acceptsDate(month: number, day: number, serial: number) {
    try {
      deriveIdentity(code(2001, month, day, serial), KEY, AT);
      return true;
    } catch (error) {
      if (!(error instanceof InvalidHetuError) || error.problem !== "date") throw error;
      return false;
    }
  }
  attack("derive an identity from an impossible date with a valid checksum", {
    attempt: () =>
      findViolation(impossible, ({ month, serial }) => acceptsDate(month, 31, serial), SEED),
    control: () =>
      findViolation(impossible, ({ month, serial }) => acceptsDate(month, 28, serial), SEED),
    succeeds: detected,
  });

  attack("collapse different individual numbers into the same identity", {
    attempt: () =>
      findViolation(
        birthday,
        ({ month, day, serial }) =>
          deriveIdentity(code(2000, month, day, serial), KEY, AT).hetuHmac ===
          deriveIdentity(code(2000, month, day, serial + 1), KEY, AT).hetuHmac,
        SEED,
      ),
    control: () =>
      findViolation(
        validCode,
        (hetu) =>
          deriveIdentity(hetu, KEY, AT).hetuHmac ===
          deriveIdentity(` \t${hetu.toLowerCase()}\n`, KEY, AT).hetuHmac,
        SEED,
      ),
    succeeds: detected,
  });

  attack("merge new century-sign identities that share the old date and number", {
    attempt: () =>
      findViolation(
        fc.tuple(birthday, fc.constantFrom("B", "C", "D", "E", "F")),
        ([{ month, day, serial }, sign]) =>
          deriveIdentity(code(2000, month, day, serial), KEY, AT).hetuHmac ===
          deriveIdentity(code(2000, month, day, serial, sign), KEY, AT).hetuHmac,
        SEED,
      ),
    control: () =>
      findViolation(
        validCode,
        (hetu) =>
          deriveIdentity(hetu, KEY, AT).hetuHmac ===
          deriveIdentity(hetu.toLowerCase(), KEY, AT).hetuHmac,
        SEED,
      ),
    succeeds: detected,
  });

  // A planted extra field is the positive control of this output detector:
  // there is no legitimate derivation that retains a raw code or legal sex.
  const retainsPersonalData = (result: object) =>
    Object.keys(result).some(
      (key) => !["hetuHmac", "birthYear", "birthMonth", "adult"].includes(key),
    );
  attack("retain the raw code, birth day or legal sex beside the derived identity", {
    attempt: () =>
      findViolation(validCode, (hetu) => retainsPersonalData(deriveIdentity(hetu, KEY, AT)), SEED),
    control: () =>
      findViolation(
        validCode,
        (hetu) => retainsPersonalData({ ...deriveIdentity(hetu, KEY, AT), hetu }),
        SEED,
      ),
    succeeds: detected,
  });
});
