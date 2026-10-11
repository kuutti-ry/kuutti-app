import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ageFromYearMonth,
  CENTURY_SIGNS,
  checkCharacter,
  generateHetu,
  hetuProblem,
  isAdult,
  parseHetu,
} from "./hetu.ts";

const SEEDED = { seed: 20261011 };
const CHECK_CHARS = "0123456789ABCDEFHJKLMNPRSTUVWXY";
const AT = new Date(Date.UTC(2026, 8, 13));

/** A deterministic RNG driven by a fast-check array of unit floats. */
function rngFrom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0.5;
}

const unitFloats = fc.array(fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), {
  minLength: 8,
  maxLength: 8,
});

/** A code whose check character is right, so the check under test is the one that fails. */
const withCheck = (ddmmyy: string, sign: string, individual: string) =>
  `${ddmmyy}${sign}${individual}${checkCharacter(ddmmyy, individual)}`;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const signsOf = (century: number) =>
  Object.entries(CENTURY_SIGNS)
    .filter(([, c]) => c === century)
    .map(([s]) => s);

/** Any real birth date the format can carry (1800–2099), a sign of its century and an individual number. */
const birth = fc
  .record({
    year: fc.integer({ min: 1800, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayFraction: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
    signPick: fc.nat(),
    individual: fc.integer({ min: 2, max: 999 }),
  })
  .map(({ year, month, dayFraction, signPick, individual }) => {
    const day = 1 + Math.floor(dayFraction * daysIn(year, month));
    const signs = signsOf(Math.floor(year / 100) * 100);
    const sign = signs[signPick % signs.length] as string;
    const ddmmyy = `${pad(day)}${pad(month)}${pad(year % 100)}`;
    const individualText = pad(individual, 3);
    return {
      year,
      month,
      day,
      sign,
      individual,
      code: `${ddmmyy}${sign}${individualText}${checkCharacter(ddmmyy, individualText)}`,
    };
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("hetu format", () => {
  it("every generated code parses and round-trips its year and month", () => {
    fc.assert(
      fc.property(unitFloats, (values) => {
        const code = generateHetu(rngFrom(values), { at: AT });
        const parsed = parseHetu(code);
        expect(parsed).not.toBeNull();
        expect(String(parsed?.birthYear).slice(-2)).toBe(code.slice(4, 6));
        expect(parsed?.birthMonth).toBe(Number(code.slice(2, 4)));
        expect(parsed && isAdult(parsed, AT)).toBe(true);
      }),
      SEEDED,
    );
  });

  it("rejects a corrupted check character", () => {
    fc.assert(
      fc.property(unitFloats, (values) => {
        const code = generateHetu(rngFrom(values), { at: AT });
        const wrong = code.at(-1) === "0" ? "1" : "0";
        expect(parseHetu(`${code.slice(0, -1)}${wrong}`)).toBeNull();
      }),
      SEEDED,
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
    const parsed = parseHetu(
      generateHetu(rngFrom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]), { at: AT }),
    );
    expect(parsed && Object.keys(parsed).sort()).toEqual([
      "birthDay",
      "birthMonth",
      "birthYear",
      "centurySign",
      "individualNumber",
    ]);
  });

  it("computes age as if born on the last day of the month", () => {
    // Born some day in March 2008: counts as 18 only from 31 March 2026.
    expect(ageFromYearMonth(2008, 3, new Date(Date.UTC(2026, 2, 30)))).toBe(17);
    expect(ageFromYearMonth(2008, 3, new Date(Date.UTC(2026, 2, 31)))).toBe(18);
  });
});

describe("hetu shape: what is refused as format", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["ten characters", "010170-999"],
    ["twelve characters", "010170-999RR"],
    ["letters in the date", "0A0170-999R"],
    ["a space inside", "010170 999R"],
    ["an unknown century sign (G)", "010170G999R"],
    ["an unknown century sign (Z)", "010170Z999R"],
    ["a slash for a sign", "010170/999R"],
    ["a minus sign (U+2212) for the hyphen", "010170−999R"],
    ["an en dash for the hyphen", "010170–999R"],
    ["full-width digits", "０１０１７０-999R"],
    ["Arabic-Indic digits", "٠١٠١٧٠-999R"],
    ["a check character outside A–Z", "010170-999Ä"],
    ["a symbol for the check character", "010170-999*"],
  ])("%s", (_name, input) => {
    expect(hetuProblem(input)).toBe("format");
    expect(parseHetu(input)).toBeNull();
  });

  it("reads lowercase century signs and check characters, and trims Unicode whitespace around the code", () => {
    const code = withCheck("141002", "A", "909"); // 141002A909X, a published test code
    expect(parseHetu(code.toLowerCase())).toEqual(parseHetu(code));
    expect(parseHetu(` ${code} \n`)).toEqual(parseHetu(code));
    expect(parseHetu(code)?.centurySign).toBe("A");
  });
});

describe("hetu check character", () => {
  it("is the remainder of the nine digits divided by 31, in the 31-character alphabet", () => {
    expect(checkCharacter("010170", "999")).toBe("R"); // 10170999 % 31 = 24
    expect(checkCharacter("000000", "000")).toBe("0");
    expect(checkCharacter("000000", "030")).toBe("Y"); // 30, the last character
    expect(checkCharacter("000000", "031")).toBe("0"); // wraps
    expect(checkCharacter("000000", "016")).toBe("H"); // G is skipped
  });

  it.each(["G", "I", "O", "Q", "Z"])(
    "never accepts %s, which the alphabet leaves out",
    (letter) => {
      for (const individual of ["002", "123", "999"]) {
        expect(hetuProblem(`010170-${individual}${letter}`)).toBe("checksum");
      }
    },
  );

  it("is checked before the date: an impossible date with a wrong check character is a checksum problem", () => {
    const right = checkCharacter("320190", "123");
    const wrong = right === "0" ? "1" : "0";
    expect(hetuProblem(`320190-123${wrong}`)).toBe("checksum");
    expect(hetuProblem(`320190-123${right}`)).toBe("date");
  });
});

describe("hetu date", () => {
  it.each([
    ["day 00", "000190", "-", "date"],
    ["day 32", "320190", "-", "date"],
    ["month 00", "010090", "-", "date"],
    ["month 13", "011390", "-", "date"],
    ["31 April", "310490", "-", "date"],
    ["31 December", "311290", "-", null],
    ["1 January", "010190", "-", null],
    ["29 February 2000, a leap year by the 400 rule", "290200", "A", null],
    ["29 February 1900, not a leap year by the 100 rule", "290200", "-", "date"],
    ["29 February 2024", "290224", "B", null],
    ["29 February 2023", "290223", "C", "date"],
    ["29 February 1896, + century", "290296", "+", null],
    ["29 February 1897, + century", "290297", "+", "date"],
  ])("%s", (_name, ddmmyy, sign, problem) => {
    expect(hetuProblem(withCheck(ddmmyy, sign, "123"))).toBe(problem);
  });
});

describe("hetu individual number", () => {
  it.each([
    ["000", "individual"],
    ["001", "individual"],
    ["002", null],
    ["899", null],
    ["900", null], // temporary and test identities parse; what to do with them is the caller's
    ["999", null],
  ])("%s", (individual, problem) => {
    expect(hetuProblem(withCheck("010170", "-", individual))).toBe(problem);
    if (problem === null) {
      expect(parseHetu(withCheck("010170", "-", individual))?.individualNumber).toBe(
        Number(individual),
      );
    }
  });

  it("is checked after the date", () => {
    expect(hetuProblem(withCheck("320190", "-", "001"))).toBe("date");
  });
});

describe("the codes Telia's test bed returns (docs/vendors/telia.md, Pre-production test users)", () => {
  // Verbatim from the vendor file's examples and its table of what the bed
  // returned; the outcome is what the parser says of each.
  it.each([
    ["220750-999Y", 1950, 7],
    ["141002A909X", 2002, 10],
    ["010280-952L", 1980, 2],
    ["010132-998W", 1932, 1],
    ["010170-999R", 1970, 1],
  ])("%s parses", (code, year, month) => {
    expect(hetuProblem(code)).toBeNull();
    expect(parseHetu(code)).toMatchObject({ birthYear: year, birthMonth: month });
  });

  it.each([
    ["410165-012D", "date"], // Ålandsbanken: day 41
    ["750240-1228", "date"], // S-Pankki: day 75
    // Danske: the file names individual number 000; the check character is
    // wrong too (H would be right), and the check character is read first.
    ["010108-000Z", "checksum"],
    ["280453-111A", "checksum"], // Danske's published code
    ["010100A001N", "checksum"], // Samlink's first person
  ])("%s is refused as %s", (code, problem) => {
    expect(hetuProblem(code)).toBe(problem);
    expect(parseHetu(code)).toBeNull();
  });
});

describe("hetu properties", () => {
  it("round-trips every date the format carries, with every sign of its century and any individual number", () => {
    fc.assert(
      fc.property(birth, ({ code, year, month, day, sign, individual }) => {
        expect(hetuProblem(code)).toBeNull();
        expect(parseHetu(code)).toEqual({
          birthYear: year,
          birthMonth: month,
          birthDay: day,
          centurySign: sign,
          individualNumber: individual,
        });
        expect(parseHetu(code.toLowerCase())).toEqual(parseHetu(code));
      }),
      { ...SEEDED, numRuns: 500 },
    );
  });

  it("maps every century sign to its century, and the signs of one century are interchangeable (2023 reform)", () => {
    fc.assert(
      fc.property(birth, fc.nat(), ({ code, sign, year }, pick) => {
        const century = CENTURY_SIGNS[sign] as number;
        const others = signsOf(century);
        const other = others[pick % others.length] as string;
        const swapped = `${code.slice(0, 6)}${other}${code.slice(7)}`;
        expect(parseHetu(swapped)).toEqual({ ...parseHetu(code), centurySign: other });
        expect(Math.floor(year / 100) * 100).toBe(century);
      }),
      SEEDED,
    );
  });

  it("detects any single changed digit: 31 is prime and divides no d·10^k", () => {
    fc.assert(
      fc.property(
        birth,
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 9 }),
        ({ code }, position, delta) => {
          const digits = `${code.slice(0, 6)}${code.slice(7, 10)}`;
          const changed = String((Number(digits[position]) + delta) % 10);
          const mutated = `${digits.slice(0, position)}${changed}${digits.slice(position + 1)}`;
          const mutatedCode = `${mutated.slice(0, 6)}${code[6]}${mutated.slice(6)}${code[10]}`;
          expect(hetuProblem(mutatedCode)).toBe("checksum");
        },
      ),
      SEEDED,
    );
  });

  it("detects two different adjacent digits swapped", () => {
    fc.assert(
      fc.property(birth, fc.integer({ min: 0, max: 7 }), ({ code }, position) => {
        const digits = `${code.slice(0, 6)}${code.slice(7, 10)}`;
        const a = digits[position] as string;
        const b = digits[position + 1] as string;
        fc.pre(a !== b);
        const swapped = `${digits.slice(0, position)}${b}${a}${digits.slice(position + 2)}`;
        const swappedCode = `${swapped.slice(0, 6)}${code[6]}${swapped.slice(6)}${code[10]}`;
        expect(hetuProblem(swappedCode)).toBe("checksum");
      }),
      SEEDED,
    );
  });

  it("parseHetu and hetuProblem agree on every input, and neither throws", () => {
    const mutated = birth.chain(({ code }) =>
      fc
        .tuple(fc.nat({ max: 10 }), fc.string({ unit: "binary", minLength: 0, maxLength: 2 }))
        .map(([at, text]) => `${code.slice(0, at)}${text}${code.slice(at + 1)}`),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: "binary", maxLength: 16 }),
          mutated,
          birth.map((b) => b.code),
        ),
        (input) => {
          const parsed = parseHetu(input);
          const problem = hetuProblem(input);
          expect(parsed === null).toBe(problem !== null);
        },
      ),
      { ...SEEDED, numRuns: 1000 },
    );
  });

  it("refuses as format anything that is not eleven characters once trimmed", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 30 }), (input) => {
        fc.pre(input.trim().length !== 11);
        expect(hetuProblem(input)).toBe("format");
      }),
      SEEDED,
    );
  });

  it("names a check character from the alphabet for any nine digits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999_999_999 }), (n) => {
        const nine = String(n).padStart(9, "0");
        const check = checkCharacter(nine.slice(0, 6), nine.slice(6));
        expect(check).toBe(CHECK_CHARS[n % 31]);
        expect("GIOQZ").not.toContain(check);
      }),
      SEEDED,
    );
  });
});

describe("age from year and month", () => {
  /** The age of someone born on a given day; 29 February counts from 28 February in a common year (the earliest reading). */
  function trueAge(year: number, month: number, day: number, at: Date): number {
    const thisYear = at.getUTCFullYear();
    const birthday = Date.UTC(thisYear, month - 1, Math.min(day, daysIn(thisYear, month)));
    return thisYear - year - (at.getTime() < birthday ? 1 : 0);
  }

  it("never overstates the age, and is at most a year under it, whatever the birth day in the month", () => {
    fc.assert(
      fc.property(
        birth,
        fc.date({ min: new Date("1900-01-01"), max: new Date("2120-12-31"), noInvalidDate: true }),
        ({ year, month, day }, at) => {
          const age = ageFromYearMonth(year, month, at);
          const truth = trueAge(year, month, day, at);
          expect(age).toBeLessThanOrEqual(truth);
          expect(truth - age).toBeLessThanOrEqual(1);
        },
      ),
      { ...SEEDED, numRuns: 500 },
    );
  });

  it("counts from midnight UTC of the last day of the birth month", () => {
    expect(ageFromYearMonth(2008, 12, new Date("2026-12-30T23:59:59.999Z"))).toBe(17);
    expect(ageFromYearMonth(2008, 12, new Date("2026-12-31T00:00:00.000Z"))).toBe(18);
    expect(ageFromYearMonth(2008, 1, new Date("2026-12-31T00:00:00.000Z"))).toBe(18);
  });

  it("takes the last day of February from the birth year, so a leap February counts from 1 March in a common year", () => {
    // February 2008 had 29 days; 29 February 2026 does not exist and rolls to 1 March.
    expect(ageFromYearMonth(2008, 2, new Date("2026-02-28T12:00:00Z"))).toBe(17);
    expect(ageFromYearMonth(2008, 2, new Date("2026-03-01T00:00:00Z"))).toBe(18);
    // February 2007 had 28 days.
    expect(ageFromYearMonth(2007, 2, new Date("2025-02-28T00:00:00Z"))).toBe(18);
  });

  it("is below zero before the birth month ends", () => {
    expect(ageFromYearMonth(2026, 10, new Date("2026-10-11T00:00:00Z"))).toBe(-1);
  });

  it("makes an adult exactly at eighteen", () => {
    const parsed = parseHetu(withCheck("150308", "A", "123"));
    if (!parsed) throw new Error("fixture does not parse");
    expect(isAdult(parsed, new Date("2026-03-30T23:59:59Z"))).toBe(false);
    expect(isAdult(parsed, new Date("2026-03-31T00:00:00Z"))).toBe(true);
  });

  it("asks the clock when no instant is given", () => {
    const parsed = parseHetu(withCheck("150308", "A", "123"));
    if (!parsed) throw new Error("fixture does not parse");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-30T12:00:00Z"));
    expect(isAdult(parsed)).toBe(false);
    vi.setSystemTime(new Date("2026-03-31T12:00:00Z"));
    expect(isAdult(parsed)).toBe(true);
  });
});

describe("generateHetu", () => {
  it("stays within the ages asked for, in 002–899, with a sign of the right century", () => {
    fc.assert(
      fc.property(
        unitFloats,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 30 }),
        fc.date({ min: new Date("1950-01-01"), max: new Date("2070-12-31"), noInvalidDate: true }),
        (values, minAge, span, at) => {
          const maxAge = minAge + span;
          const code = generateHetu(rngFrom(values), { minAge, maxAge, at });
          const parsed = parseHetu(code);
          expect(parsed).not.toBeNull();
          if (!parsed) return;
          const age = ageFromYearMonth(parsed.birthYear, parsed.birthMonth, at);
          // The comment's promise: the age asked for, or one more when a
          // leap February moves the year back; never below minAge.
          expect(age).toBeGreaterThanOrEqual(minAge);
          expect(age).toBeLessThanOrEqual(maxAge + 1);
          expect(parsed.individualNumber).toBeGreaterThanOrEqual(2);
          expect(parsed.individualNumber).toBeLessThanOrEqual(899);
          expect(CENTURY_SIGNS[parsed.centurySign]).toBe(Math.floor(parsed.birthYear / 100) * 100);
        },
      ),
      { ...SEEDED, numRuns: 500 },
    );
  });

  it("reaches both ends of the individual numbers and every sign of a century", () => {
    expect(parseHetu(generateHetu(() => 0, { at: AT }))?.individualNumber).toBe(2);
    expect(parseHetu(generateHetu(() => 0.999_999, { at: AT }))?.individualNumber).toBe(899);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      // Age, month and day at their lowest; the fourth draw picks the sign.
      const draws = [0, 0, 0, (i + 0.5) / 6, 0];
      const parsed = parseHetu(generateHetu(rngFrom(draws), { at: AT, minAge: 30, maxAge: 30 }));
      seen.add(parsed?.centurySign ?? "");
    }
    expect([...seen].sort()).toEqual(signsOf(1900).sort());
  });

  it("defaults to adults of 18 to 70 at the present moment", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);
    const youngest = parseHetu(generateHetu(() => 0));
    const oldest = parseHetu(generateHetu(() => 0.999_999));
    if (!youngest || !oldest) throw new Error("generated code does not parse");
    expect(ageFromYearMonth(youngest.birthYear, youngest.birthMonth, AT)).toBe(18);
    const oldestAge = ageFromYearMonth(oldest.birthYear, oldest.birthMonth, AT);
    expect(oldestAge).toBeGreaterThanOrEqual(70);
    expect(oldestAge).toBeLessThanOrEqual(71);
  });
});
