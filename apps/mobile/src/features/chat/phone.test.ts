import fc from "fast-check";
import { getCountries, getExampleNumber } from "libphonenumber-js/min";
import examples from "libphonenumber-js/mobile/examples";
import { codeOf, countries, readPhone, search, showPhone } from "./phone";

// A number as a person types it, read under the code chosen (#511).

describe("readPhone", () => {
  it.each([
    ["040 660 1234"],
    ["0406601234"],
    ["40 660 1234"],
    ["+358 40 660 1234"],
    ["+358 (0)40 660 1234"],
    ["+358 040 660 1234"],
    ["00358 40 660 1234"],
    ["358 40 660 1234"],
    ["040-660 12 34"],
  ])("reads %s under +358 as +358406601234", (typed) => {
    expect(readPhone(typed, "FI")).toEqual({ e164: "+358406601234", region: "FI" });
  });

  it.each([
    ["+46 70 123 45 67", "FI", "+46701234567", "SE"],
    ["070-123 45 67", "SE", "+46701234567", "SE"],
    ["06 1234 5678", "IT", "+390612345678", "IT"],
    ["8 912 345-67-89", "RU", "+79123456789", "RU"],
  ] as const)("reads %s under %s as %s, a number of %s", (typed, region, e164, country) => {
    expect(readPhone(typed, region)).toEqual({ e164, region: country });
  });

  it.each([
    ["4", "short"],
    ["040 660 1234 5678 9", "long"],
    ["040 66", "invalid"],
    ["040 SOITA MULLE", "invalid"],
    ["+358 358 40 660 1234", "invalid"],
    // The card reads no empty field: an emptied one keeps what is stored.
    ["", "invalid"],
  ] as const)("refuses %p as %s", (typed, refused) => {
    expect(readPhone(typed, "FI")).toEqual({ refused });
  });

  it("reads every country's own example number back to itself once shown", () => {
    const regions = getCountries().filter((region) => getExampleNumber(region, examples));
    fc.assert(
      fc.property(fc.constantFrom(...regions), (region) => {
        const e164 = getExampleNumber(region, examples)?.number as string;
        const shown = showPhone(e164);
        const read = readPhone(shown.rest, shown.region);
        return "e164" in read && read.e164 === e164;
      }),
      { seed: 511, numRuns: 200 },
    );
  });
});

describe("showPhone", () => {
  it("shows a stored number as its code and the rest grouped", () => {
    expect(showPhone("+358406601234")).toEqual({ region: "FI", rest: "40 6601234" });
    expect(codeOf("FI")).toBe("+358");
  });

  it("shows what it cannot read as it is, under Finland's code", () => {
    expect(showPhone("+999")).toEqual({ region: "FI", rest: "+999" });
  });
});

describe("the countries", () => {
  it("are named in the app's language, in its order, with their code and flag", () => {
    const fi = countries("fi");
    const sweden = fi.find((country) => country.region === "SE");
    expect(sweden).toMatchObject({ name: "Ruotsi", english: "Sweden", code: "+46", flag: "🇸🇪" });
    const names = fi.map((country) => country.name);
    expect([...names].sort(new Intl.Collator("fi").compare)).toEqual(names);
  });

  it("are found by name in either language, folding case and accents, or by code", () => {
    const sv = countries("sv");
    expect(search(sv, "aland").map((c) => c.region)).toContain("AX");
    expect(search(sv, "SWEDEN").map((c) => c.region)).toEqual(["SE"]);
    for (const code of ["46", "+46", "0046"]) {
      expect(search(sv, code).map((c) => c.region)).toContain("SE");
    }
    expect(search(sv, "  ")).toHaveLength(sv.length);
    expect(search(sv, "xyzzy")).toEqual([]);
  });
});
