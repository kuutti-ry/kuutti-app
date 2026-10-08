import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ageFromYearMonth,
  CENTURY_SIGNS,
  checkCharacter,
  generateHetu,
  hetuProblem,
  isAdult,
  parseHetu,
} from "./hetu-format.ts";

/** A deterministic RNG driven by a fast-check array of unit floats. */
function rngFrom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0.5;
}

const unitFloats = fc.array(fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), {
  minLength: 8,
  maxLength: 8,
});

describe("hetu format", () => {
  it("every generated code parses and round-trips its year and month", () => {
    fc.assert(
      fc.property(unitFloats, (values) => {
        const at = new Date(Date.UTC(2026, 8, 13));
        const code = generateHetu(rngFrom(values), { at });
        const parsed = parseHetu(code);
        expect(parsed).not.toBeNull();
        expect(String(parsed?.birthYear).slice(-2)).toBe(code.slice(4, 6));
        expect(parsed?.birthMonth).toBe(Number(code.slice(2, 4)));
        expect(parsed && isAdult(parsed, at)).toBe(true);
      }),
    );
  });

  it("rejects a corrupted check character", () => {
    fc.assert(
      fc.property(unitFloats, (values) => {
        const code = generateHetu(rngFrom(values));
        const wrong = code.at(-1) === "0" ? "1" : "0";
        expect(parseHetu(`${code.slice(0, -1)}${wrong}`)).toBeNull();
      }),
    );
  });

  it("accepts every century separator", () => {
    for (const sign of Object.keys(CENTURY_SIGNS)) {
      const code = `010190${sign}002`;
      const parsed = parseHetu(
        `${code}${"0123456789ABCDEFHJKLMNPRSTUVWXY"[Number.parseInt("010190002", 10) % 31]}`,
      );
      expect(parsed?.centurySign).toBe(sign);
      expect(parsed?.birthYear).toBe(
        CENTURY_SIGNS[sign] === 1800 ? 1890 : CENTURY_SIGNS[sign] === 1900 ? 1990 : 2090,
      );
    }
  });

  it("rejects impossible dates, temporary numbers, and garbage", () => {
    expect(parseHetu("310290-123P")).toBeNull();
    expect(parseHetu("010190-001A")).toBeNull();
    expect(parseHetu("not a code")).toBeNull();
    expect(parseHetu("")).toBeNull();
  });

  it("names the check a refused code fails, and nothing else", () => {
    // A code whose check character is right, so a later check is what fails.
    const withCheck = (ddmmyy: string, sign: string, individual: string) =>
      `${ddmmyy}${sign}${individual}${checkCharacter(ddmmyy, individual)}`;
    expect(hetuProblem("not a code")).toBe("format");
    expect(hetuProblem("0101901234A")).toBe("format");
    expect(hetuProblem("010190-123B")).toBe("checksum");
    expect(hetuProblem(withCheck("310290", "-", "123"))).toBe("date");
    expect(hetuProblem(withCheck("011390", "-", "123"))).toBe("date");
    expect(hetuProblem(withCheck("010190", "-", "001"))).toBe("individual");
    expect(hetuProblem(withCheck("010170", "-", "999"))).toBeNull();
    expect(hetuProblem(" 010170-999r ")).toBeNull();
  });

  it("never exposes sex", () => {
    const parsed = parseHetu(generateHetu(rngFrom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])));
    expect(parsed && Object.keys(parsed)).not.toContain("sex");
  });

  it("computes age as if born on the last day of the month", () => {
    // Born some day in March 2008: counts as 18 only from 31 March 2026.
    expect(ageFromYearMonth(2008, 3, new Date(Date.UTC(2026, 2, 30)))).toBe(17);
    expect(ageFromYearMonth(2008, 3, new Date(Date.UTC(2026, 2, 31)))).toBe(18);
  });
});
