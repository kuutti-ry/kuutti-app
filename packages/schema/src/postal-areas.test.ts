import { describe, expect, it } from "vitest";
import * as packageRoot from "./index.ts";
import { PostalCode } from "./onboarding.ts";
import { POSTAL_AREA_ROWS } from "./postal-areas.generated.ts";
import { POSTAL_AREAS_CREDIT, POSTAL_CODE_LENGTH, postalMatches } from "./postal-areas.ts";

// The phone's list (ADR-061 §4): the areas whose code starts with what is typed,
// over the real list of Statistics Finland, whose year the count below names.

const every = "0123456789"
  .split("")
  .flatMap((digit) => postalMatches(digit, Number.POSITIVE_INFINITY));

describe("the list of postal areas", () => {
  it("holds the 3,018 areas of Paavo 2026, each once, by code", () => {
    expect(every).toHaveLength(3018);
    const codes = every.map((row) => row.code);
    expect(new Set(codes).size).toBe(3018);
    expect(codes).toEqual([...codes].sort());
  });

  it("has a code of five digits on every row, the contract's", () => {
    expect(POSTAL_CODE_LENGTH).toBe(5);
    for (const { code } of every) expect(PostalCode.safeParse(code).success, code).toBe(true);
  });

  it("has a Finnish and a Swedish name on every row, with no space to spare", () => {
    for (const { code, fi, sv } of every) {
      expect(fi.trim(), code).toBe(fi);
      expect(fi, code).not.toBe("");
      expect(sv.trim(), code).toBe(sv);
      expect(sv, code).not.toBe("");
    }
  });

  it("is one string with one line a row, so that it costs nothing until it is searched", () => {
    expect(typeof POSTAL_AREA_ROWS).toBe("string");
    expect(POSTAL_AREA_ROWS.split("\n")).toHaveLength(3018);
  });

  it("stays out of the package root, so that no other import carries it", () => {
    expect(Object.keys(packageRoot)).not.toContain("postalMatches");
    expect(Object.keys(packageRoot)).not.toContain("POSTAL_AREAS_CREDIT");
  });
});

describe("searching the list", () => {
  it("finds a whole code and nothing else", () => {
    expect(postalMatches("00530", 10)).toEqual([{ code: "00530", fi: "Kallio", sv: "Berghäll" }]);
  });

  it("finds the rows a beginning names, by code", () => {
    expect(postalMatches("005", 3).map((row) => row.code)).toEqual(["00500", "00510", "00520"]);
    const many = postalMatches("90", 500).map((row) => row.code);
    expect(many.length).toBeGreaterThan(10);
    expect(many.every((code) => code.startsWith("90"))).toBe(true);
    expect(many).toEqual([...many].sort());
  });

  it("offers nothing when nothing is typed", () => {
    expect(postalMatches("", 10)).toEqual([]);
  });

  it.each([
    ["a code the list lacks", "99999"],
    ["a beginning no code has", "000"],
    ["letters", "abc"],
    ["more than a code's digits", "005300"],
    ["a code with a space", " 00530"],
  ])("finds nothing for %s", (_, typed) => {
    expect(postalMatches(typed, 10)).toEqual([]);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [1, 1],
    [3, 3],
  ])("gives at most the limit: %d gives %d", (limit, count) => {
    expect(postalMatches("00", limit)).toHaveLength(count);
  });

  it("gives what there is under a larger limit", () => {
    expect(postalMatches("00530", 500)).toHaveLength(1);
  });

  it("keeps a code's leading zeros", () => {
    expect(postalMatches("00100", 1)[0]?.code).toBe("00100");
    expect(postalMatches("0", 1)[0]?.code).toBe("00100");
    expect(postalMatches("100", 1)).toEqual([]);
    expect(every.filter(({ code }) => code.startsWith("0")).length).toBeGreaterThan(300);
  });

  it("gives a row's Swedish name, and its Finnish one where the two are one", () => {
    expect(postalMatches("00100", 1)).toEqual([
      {
        code: "00100",
        fi: "Helsinki keskusta - Etu-Töölö",
        sv: "Helsingfors centrum - Främre Tölö",
      },
    ]);
    expect(postalMatches("83960", 1)).toEqual([{ code: "83960", fi: "Koli", sv: "Koli" }]);
    expect(POSTAL_AREA_ROWS).toContain("\n83960|Koli|\n");
  });

  it("parses the list once", () => {
    expect(postalMatches("00100", 1)[0]).toBe(postalMatches("00100", 1)[0]);
  });
});

describe("the credit the licence asks for", () => {
  it("names the year, the day read and the terms, in one object", () => {
    expect(POSTAL_AREAS_CREDIT.year).toBe(2026);
    expect(POSTAL_AREAS_CREDIT.date).toMatch(/^2026-\d{2}-\d{2}$/);
    expect(POSTAL_AREAS_CREDIT.licence).toBe("CC BY 4.0");
    expect(POSTAL_AREAS_CREDIT.licenceUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(POSTAL_AREAS_CREDIT.sourceUrl).toBe("https://geo.stat.fi/geoserver");
  });

  it("says in English and in Finnish who the list is from and what Kuutti changed", () => {
    const [yyyy, mm, dd] = POSTAL_AREAS_CREDIT.date.split("-");
    const day = `${Number(dd)}.${Number(mm)}.${yyyy}`;
    expect(POSTAL_AREAS_CREDIT.en.source).toContain("Paavo");
    expect(POSTAL_AREAS_CREDIT.en.source).toContain("Statistics Finland");
    expect(POSTAL_AREAS_CREDIT.en.source).toContain(day);
    expect(POSTAL_AREAS_CREDIT.en.changes).toContain("Changed by Kuutti");
    expect(POSTAL_AREAS_CREDIT.fi.source).toContain("Paavo");
    expect(POSTAL_AREAS_CREDIT.fi.source).toContain("Tilastokeskus");
    expect(POSTAL_AREAS_CREDIT.fi.source).toContain(day);
    expect(POSTAL_AREAS_CREDIT.fi.changes).toContain("Kuutin tekemät muutokset");
  });
});
