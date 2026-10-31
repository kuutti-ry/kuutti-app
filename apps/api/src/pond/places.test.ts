import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { test } from "../test/harness.ts";
import { PLACE_AREA_ROWS, PLACE_MUNICIPALITY_ROWS } from "./places.generated.ts";
import {
  areaOf,
  homeRules,
  homeSummary,
  keptPlace,
  nameOf,
  pointOf,
  shownPlace,
  townOf,
} from "./places.ts";

// Where a home is (ADR-061 §2 to §4), over the real list of Statistics Finland:
// the one number no name, band or probe narrows anybody below, and the town a
// card says. Figures named here are Paavo 2026's, so a new year's list shows up
// in this file's diff too. The rows are read here on their own, so that a
// parser's fault in places.ts cannot pass for a fact of the list.

const SEEDED = { seed: 20261031 };
const FLOOR = 3000;
const TOWN = 20000;
const rules = { minInhabitants: FLOOR, townMin: TOWN };

const areaRows = PLACE_AREA_ROWS.split("\n").map((row) => {
  const [code = "", municipality = "", x, y, inhabitants] = row.split("|");
  return { code, municipality, x: Number(x), y: Number(y), inhabitants: Number(inhabitants) };
});
const municipalityRows = PLACE_MUNICIPALITY_ROWS.split("\n").map((row) => {
  const [code = "", fi = "", sv, x, y, inhabitants] = row.split("|");
  return { code, fi, sv: sv || fi, x: Number(x), y: Number(y), inhabitants: Number(inhabitants) };
});
const rowOf = (key: string) => {
  const row = areaRows.find((area) => area.code === key);
  return row ?? municipalityRows.find((municipality) => municipality.code === key);
};
const inhabitantsOf = (key: string) => rowOf(key)?.inhabitants;
const LARGEST = Math.max(...municipalityRows.map((municipality) => municipality.inhabitants));
const ALAND = new Set(
  areaRows.filter((area) => area.code.startsWith("22")).map((area) => area.municipality),
);
const nearestAtLeast = (key: string, floor: number) => {
  const from = municipalityRows.find((municipality) => municipality.code === key);
  const by = (m: { x: number; y: number }) =>
    Math.hypot(m.x - (from?.x ?? 0), m.y - (from?.y ?? 0));
  return municipalityRows
    .filter(({ code, inhabitants }) => inhabitants >= floor && ALAND.has(code) === ALAND.has(key))
    .sort((a, b) => by(a) - by(b))[0]?.code;
};

/** How many people stand behind each key under a floor: everybody of every code that keeps it. */
const peopleBehind = (floor: number) => {
  const behind = new Map<string, number>();
  for (const { code, inhabitants } of areaRows) {
    const kept = keptPlace(code, floor);
    if (kept) behind.set(kept, (behind.get(kept) ?? 0) + Math.max(0, inhabitants));
  }
  return behind;
};

const HELSINKI = { fi: "Helsinki", sv: "Helsingfors" };
const MARIEHAMN = { fi: "Maarianhamina", sv: "Mariehamn" };

describe("the list", () => {
  it("holds Paavo's 3,018 areas and 5.56 million people in 308 municipalities", () => {
    expect(areaRows).toHaveLength(3018);
    expect(new Set(areaRows.map((area) => area.code)).size).toBe(3018);
    expect(municipalityRows).toHaveLength(308);
    const people = areaRows.reduce((sum, area) => sum + Math.max(0, area.inhabitants), 0);
    expect(people).toBe(5_557_765);
  });

  it("names a municipality of the list on every area, and every municipality has an area", () => {
    const codes = new Set(municipalityRows.map((municipality) => municipality.code));
    expect(areaRows.filter((area) => !codes.has(area.municipality))).toEqual([]);
    const named = new Set(areaRows.map((area) => area.municipality));
    expect(municipalityRows.filter(({ code }) => !named.has(code))).toEqual([]);
  });

  it("is the phone's list, code for code, so that every area kept has its names", () => {
    expect(areaRows.filter((area) => areaOf(area.code) === null)).toEqual([]);
  });

  it("counts a municipality as its areas, and cuts a bilingual name to one language each", () => {
    const own = areaRows.filter((area) => area.municipality === "478");
    expect(rowOf("478")).toMatchObject({ ...MARIEHAMN, inhabitants: 11891 });
    expect(own.reduce((sum, area) => sum + area.inhabitants, 0)).toBe(11891);
  });
});

describe("keptPlace, a postal code", () => {
  it("keeps an area of at least the floor as its code: Kallio at 3,000", () => {
    expect(inhabitantsOf("00530")).toBeGreaterThanOrEqual(FLOOR);
    expect(keptPlace("00530", FLOOR)).toBe("00530");
  });

  it("keeps the municipality of an area under the floor: Koli keeps Lieksa", () => {
    expect(inhabitantsOf("83960")).toBeLessThan(FLOOR);
    expect(keptPlace("83960", FLOOR)).toBe("422");
  });

  it("keeps the municipality of an area nobody lives in, which is still on the list", () => {
    expect(inhabitantsOf("00230")).toBe(0);
    expect(keptPlace("00230", FLOOR)).toBe("091");
    expect(inhabitantsOf("01770")).toBe(0);
    expect(keptPlace("01770", FLOOR)).toBe("092");
  });

  it("takes an area at the floor exactly, and not one under it by a person", () => {
    const exact = inhabitantsOf("27500") ?? 0;
    expect(exact).toBe(3009);
    expect(keptPlace("27500", exact)).toBe("27500");
    expect(keptPlace("27500", exact + 1)).toBe("050");
  });

  it("goes past a municipality under the floor to the nearest above it", () => {
    expect(inhabitantsOf("23950")).toBeLessThan(FLOOR);
    expect(inhabitantsOf("631")).toBeLessThan(FLOOR);
    expect(keptPlace("23950", FLOOR)).toBe("684");
  });

  it("keeps everybody of a small municipality in one place, whichever their area", () => {
    const own = areaRows.filter((area) => area.municipality === "090");
    expect(own.length).toBeGreaterThan(1);
    expect(new Set(own.map((area) => keptPlace(area.code, FLOOR)))).toEqual(new Set(["309"]));
  });
});

describe("A home keeps the postal area, else its municipality, else the nearest municipality with enough people", () => {
  it.each([
    [3000, "00530", 17951, 672201, "00530", "the area"],
    [3009, "27500", 3009, 11021, "27500", "the area"],
    [3010, "27500", 3009, 11021, "050", "its municipality"],
    [3000, "83960", 271, 9887, "422", "its municipality"],
    [3000, "00230", 0, 672201, "091", "its municipality"],
    [3042, "54710", 1253, 3042, "416", "its municipality"],
    [3043, "54710", 1253, 3042, "831", "the nearest one with enough"],
    [3000, "23950", 458, 1836, "684", "the nearest one with enough"],
  ] as const)(
    "at a floor of %s, %s of %s people in a municipality of %s keeps %s, %s",
    (floor, code, area, municipality, kept, _which) => {
      expect(inhabitantsOf(code)).toBe(area);
      const own = areaRows.find((row) => row.code === code)?.municipality ?? "";
      expect(inhabitantsOf(own)).toBe(municipality);
      expect(keptPlace(code, floor)).toBe(kept);
    },
  );
});

describe("who stands behind a key", () => {
  it("An area large enough gives way where too few would be left behind its municipality's key", () => {
    expect(inhabitantsOf("21380")).toBe(3455);
    expect(inhabitantsOf("21370")).toBe(547);
    expect(keptPlace("21380", FLOOR)).toBe("019");
    expect(keptPlace("21370", FLOOR)).toBe("019");
  });

  it("Whichever the key, at least the floor's number of people stand behind it", () => {
    const behind = [...peopleBehind(FLOOR)].filter(([, people]) => people > 0);
    expect(behind).toHaveLength(750);
    expect(Math.min(...behind.map(([, people]) => people))).toBe(3009);
  });

  it("gives way as little as it takes: the 34 smallest it can, and every other large area stays", () => {
    const large = areaRows.filter((area) => area.inhabitants >= FLOOR);
    const gone = large.filter((area) => keptPlace(area.code, FLOOR) !== area.code);
    expect(gone).toHaveLength(34);
    // Within a municipality, whatever stays is at least as large as whatever went.
    for (const area of gone) {
      for (const other of large.filter((row) => row.municipality === area.municipality)) {
        if (keptPlace(other.code, FLOOR) === other.code) {
          expect(other.inhabitants, other.code).toBeGreaterThanOrEqual(area.inhabitants);
        }
      }
    }
  });

  it("counts the small municipalities that fall to a key, which can spare an area of its own", () => {
    // Forssa's people left behind its key are too few alone; those of Tammela's neighbours are not.
    const spared = areaRows.filter((area) => {
      const left = areaRows
        .filter(
          (row) =>
            row.municipality === area.municipality &&
            keptPlace(row.code, FLOOR) === area.municipality,
        )
        .reduce((sum, row) => sum + Math.max(0, row.inhabitants), 0);
      const behind = peopleBehind(FLOOR).get(area.municipality) ?? 0;
      return (
        area.inhabitants >= FLOOR &&
        keptPlace(area.code, FLOOR) === area.code &&
        left > 0 &&
        left < FLOOR &&
        behind >= FLOOR
      );
    });
    expect(spared.length).toBeGreaterThan(0);
  });

  it("names nobody's key where nobody is left behind it: every area of a town can keep its own", () => {
    const whole = peopleBehind(1);
    expect(whole.get("091") ?? 0).toBe(0);
    expect(keptPlace("00530", 1)).toBe("00530");
  });

  it("holds at every floor, not only at the design's", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: LARGEST }), (floor) =>
        [...peopleBehind(floor).values()].every((people) => people === 0 || people >= floor),
      ),
      // Each run reads every code on the list.
      { ...SEEDED, numRuns: 200 },
    );
  });

  it("answers a floor changed back as it did before", () => {
    const first = keptPlace("21380", 3000);
    expect(keptPlace("21380", 3400)).toBe(first);
    expect(keptPlace("21380", 3456)).toBe("019");
    expect(keptPlace("21380", 500)).toBe("21380");
    expect(keptPlace("21380", 3000)).toBe(first);
  });
});

describe("keptPlace, a municipality", () => {
  it("keeps a municipality of at least the floor", () => {
    expect(keptPlace("091", FLOOR)).toBe("091");
    expect(keptPlace("422", FLOOR)).toBe("422");
  });

  it("takes a municipality at the floor exactly, and not one under it by a person", () => {
    expect(inhabitantsOf("416")).toBe(3042);
    expect(keptPlace("416", 3042)).toBe("416");
    expect(keptPlace("416", 3043)).toBe(nearestAtLeast("416", 3043));
    expect(keptPlace("416", 3043)).not.toBe("416");
  });

  it.each([
    ["Sottunga", "766", "478"],
    ["Sauvo", "738", "202"],
    ["Heinävesi", "090", "309"],
  ])("sends %s to the nearest above the floor", (_, under, kept) => {
    expect(inhabitantsOf(under)).toBeLessThan(FLOOR);
    expect(inhabitantsOf(kept)).toBeGreaterThanOrEqual(FLOOR);
    expect(keptPlace(under, FLOOR)).toBe(kept);
  });

  it("finds the nearest by centre for every municipality under the floor", () => {
    const under = municipalityRows.filter((municipality) => municipality.inhabitants < FLOOR);
    expect(under).toHaveLength(96);
    for (const { code } of under) {
      expect(keptPlace(code, FLOOR), code).toBe(nearestAtLeast(code, FLOOR));
    }
  });
});

describe("keptPlace, a stored key", () => {
  it("reads as itself while the floor stands", () => {
    expect(keptPlace("00530", FLOOR)).toBe("00530");
    expect(keptPlace("422", FLOOR)).toBe("422");
  });

  it("coarsens at once when the floor rises (§2)", () => {
    expect(inhabitantsOf("00530")).toBe(17951);
    expect(keptPlace("00530", 17951)).toBe("00530");
    expect(keptPlace("00530", 17952)).toBe("091");
    expect(keptPlace("422", 10000)).toBe(nearestAtLeast("422", 10000));
    expect(keptPlace("422", 10000)).not.toBe("422");
  });

  it("refines nobody when the floor falls, a municipality having no digits to go back to", () => {
    expect(keptPlace("422", 0)).toBe("422");
    expect(keptPlace("091", 1)).toBe("091");
  });

  it("goes when the list no longer knows it", () => {
    expect(keptPlace("12345", FLOOR)).toBeNull();
    expect(keptPlace("000", FLOOR)).toBeNull();
  });
});

describe("keptPlace, what it refuses", () => {
  it.each([
    ["a code the list lacks", "99999"],
    ["all zeros", "00000"],
    ["a number of no municipality", "999"],
    ["nothing", ""],
    ["four digits", "0053"],
    ["two digits", "91"],
    ["letters", "abcde"],
    ["a name", "Kallio"],
    ["a space after a code", "00530 "],
    ["a key of the old shape", "area:00530"],
  ])("knows nothing of %s", (_, key) => {
    expect(keptPlace(key, FLOOR)).toBeNull();
  });

  it("keeps nothing under a floor no municipality reaches: never below the number", () => {
    expect(LARGEST).toBe(672_201);
    expect(keptPlace("091", LARGEST)).toBe("091");
    expect(keptPlace("00530", LARGEST)).toBe("091");
    expect(keptPlace("766", LARGEST)).toBe("091");
    expect(keptPlace("091", LARGEST + 1)).toBeNull();
    expect(keptPlace("00530", LARGEST + 1)).toBeNull();
  });
});

describe("the point of a place", () => {
  it("is an area's own centre and a municipality's weighted one, in metres", () => {
    const { x, y } = rowOf("00530") ?? {};
    expect(pointOf("00530")).toEqual({ x, y });
    const own = areaRows.filter((area) => area.municipality === "091");
    const people = own.reduce((sum, area) => sum + Math.max(0, area.inhabitants), 0);
    const mean = (axis: "x" | "y") =>
      Math.round(own.reduce((sum, a) => sum + Math.max(0, a.inhabitants) * a[axis], 0) / people);
    expect(pointOf("091")).toEqual({ x: mean("x"), y: mean("y") });
  });

  it("is nothing for what the list lacks", () => {
    expect(pointOf("99999")).toBeNull();
    expect(pointOf("999")).toBeNull();
    expect(pointOf("")).toBeNull();
  });
});

describe("the town a card shows", () => {
  it("is the municipality where it is large enough, from an area or from itself", () => {
    expect(townOf("091", TOWN)).toEqual(HELSINKI);
    expect(townOf("00530", TOWN)).toEqual(HELSINKI);
  });

  it("takes a municipality at the town floor exactly, and not one under it by a person", () => {
    expect(inhabitantsOf("140")).toBe(20269);
    expect(townOf("140", 20269)).toEqual({ fi: "Iisalmi", sv: "Idensalmi" });
    expect(townOf("140", 20270).fi).not.toBe("Iisalmi");
  });

  it("stays the place's own municipality though another town's centre lies nearer", () => {
    expect(townOf("00730", TOWN)).toEqual(HELSINKI);
    expect(townOf("01450", TOWN).fi).toBe("Vantaa");
  });

  it("is the nearest large enough for a smaller place", () => {
    expect(inhabitantsOf("422")).toBeLessThan(TOWN);
    expect(townOf("422", TOWN)).toEqual({ fi: "Joensuu", sv: "Joensuu" });
  });

  it("is measured from the place kept: Kalajoki's centre reads nearer Raahe than Kalajoki as a whole does", () => {
    expect(keptPlace("85100", FLOOR)).toBe("85100");
    expect(townOf("85100", TOWN).fi).toBe("Raahe");
    expect(townOf("165", TOWN).fi).toBe("Hämeenlinna");
  });

  it("Nobody of Åland is kept across the sea while Åland has a place large enough", () => {
    expect(keptPlace("22840", FLOOR)).toBe("170");
    expect(townOf("170", TOWN)).toEqual(MARIEHAMN);
    expect(ALAND.size).toBe(16);
    const codes = areaRows.filter((area) => area.code.startsWith("22"));
    expect(codes).toHaveLength(32);
    expect(inhabitantsOf("478")).toBeLessThan(TOWN);
    for (const { code } of codes) {
      const kept = keptPlace(code, FLOOR) ?? "";
      expect(ALAND.has(areaRows.find((row) => row.code === kept)?.municipality ?? kept), code).toBe(
        true,
      );
      expect(townOf(kept, TOWN), code).toEqual(MARIEHAMN);
    }
  });

  it("crosses the sea only where Åland has nothing large enough, so the floor still holds", () => {
    const largest = Math.max(
      ...municipalityRows.filter(({ code }) => ALAND.has(code)).map((m) => m.inhabitants),
    );
    expect(ALAND.has(keptPlace("22840", largest) ?? "")).toBe(true);
    const kept = keptPlace("22840", largest + 1) ?? "";
    expect(ALAND.has(kept)).toBe(false);
    expect(inhabitantsOf(kept)).toBeGreaterThan(largest);
  });

  it("sends nobody of the mainland to Åland, as a place or as a town", () => {
    for (const { code } of areaRows.filter((area) => !area.code.startsWith("22"))) {
      const kept = keptPlace(code, FLOOR) ?? "";
      expect(ALAND.has(kept), code).toBe(false);
      expect(townOf(kept, TOWN), code).not.toEqual(MARIEHAMN);
    }
  });

  it("keeps Maarianhamina at any size, and it alone is left under a floor nobody reaches", () => {
    expect(townOf("478", LARGEST + 1)).toEqual(MARIEHAMN);
    expect(townOf("091", LARGEST + 1)).toEqual(MARIEHAMN);
  });

  it("gives no town to a key the list lacks, and does not name it", () => {
    expect(() => townOf("12345", TOWN)).toThrow("townOf: a place that is not on the list");
    expect(() => townOf("", TOWN)).toThrow("townOf: a place that is not on the list");
  });
});

describe("the area of a place", () => {
  it("is both names of an area kept", () => {
    expect(areaOf("00530")).toEqual({ fi: "Kallio", sv: "Berghäll" });
  });

  it("repeats the Finnish name where the two are one", () => {
    expect(areaOf("27500")).toEqual({ fi: "Kauttua", sv: "Kauttua" });
  });

  it("is nothing for a municipality, whose number also begins some postal codes", () => {
    expect(areaRows.some((area) => area.code.startsWith("091"))).toBe(true);
    expect(areaOf("091")).toBeNull();
  });

  it("is nothing for what the list lacks", () => {
    expect(areaOf("99999")).toBeNull();
    expect(areaOf("")).toBeNull();
  });
});

describe("what a kept place is called", () => {
  it("is the area's name where an area is kept", () => {
    expect(nameOf("00530")).toEqual({ fi: "Kallio", sv: "Berghäll" });
  });

  it("is the municipality's where one is kept, which is not the town of a small one", () => {
    expect(nameOf("422")).toEqual({ fi: "Lieksa", sv: "Lieksa" });
    expect(nameOf("091")).toEqual(HELSINKI);
  });

  it("is a caller's fault for a key the list lacks, and does not name it", () => {
    expect(() => nameOf("12345")).toThrow("nameOf: a place that is not on the list");
    expect(() => nameOf("")).toThrow("nameOf: a place that is not on the list");
  });
});

describe("the one name a card says", () => {
  const area = { fi: "Kallio", sv: "Berghäll" };

  it("is the town unless the person chose the area", () => {
    expect(shownPlace({ town: HELSINKI, area, showArea: false })).toEqual(HELSINKI);
    expect(shownPlace({ town: HELSINKI, area, showArea: true })).toEqual(area);
  });

  it("is the town where there is no area to show, whatever the switch says", () => {
    expect(shownPlace({ town: HELSINKI, area: null, showArea: true })).toEqual(HELSINKI);
  });
});

describe("a home as its owner reads it", () => {
  it("names the town and the area, and the choice where an area is kept", () => {
    expect(homeSummary("00530", false, rules)).toEqual({
      town: HELSINKI,
      area: { fi: "Kallio", sv: "Berghäll" },
      showArea: false,
    });
    expect(homeSummary("00530", true, rules)?.showArea).toBe(true);
  });

  it("has no area where a municipality is kept, and the choice cannot stand", () => {
    expect(homeSummary("422", true, rules)).toEqual({
      town: { fi: "Joensuu", sv: "Joensuu" },
      area: null,
      showArea: false,
    });
  });

  it("is nothing without a home", () => {
    expect(homeSummary(null, true, rules)).toBeNull();
  });

  it("is nothing for a key the list no longer knows, which opens the step again", () => {
    expect(homeSummary("12345", false, rules)).toBeNull();
  });

  it("reads a stored key through the floor, so a raised one takes the area away at once", () => {
    const raised = { ...rules, minInhabitants: 20000 };
    expect(homeSummary("00530", true, raised)).toEqual({
      town: HELSINKI,
      area: null,
      showArea: false,
    });
  });

  it("is nothing under a floor no municipality reaches", () => {
    expect(homeSummary("00530", true, { ...rules, minInhabitants: LARGEST + 1 })).toBeNull();
  });

  it("follows the town floor it is given", () => {
    const smaller = { ...rules, townMin: 9000 };
    expect(homeSummary("422", false, smaller)?.town).toEqual({ fi: "Lieksa", sv: "Lieksa" });
  });
});

describe("the rules a home is read by", () => {
  test("are the two tunables, the latest version of each", async ({ ctx }) => {
    expect(await homeRules(ctx.client)).toEqual({ minInhabitants: 3000, townMin: 20000 });
    await ctx.client.query(
      `INSERT INTO matching_config (version, key, value, created_by)
       VALUES (2, 'home_min_inhabitants', '5000'::jsonb, 'places test')`,
    );
    expect(await homeRules(ctx.client)).toEqual({ minInhabitants: 5000, townMin: 20000 });
  });
});

describe("whatever the place and the floor", () => {
  const anyKey = fc.constantFrom(
    ...areaRows.map((area) => area.code),
    ...municipalityRows.map((municipality) => municipality.code),
  );
  const anyFloor = fc.oneof(
    fc.constant(FLOOR),
    fc.integer({ min: 0, max: 30_000 }),
    fc.integer({ min: 0, max: LARGEST + 1000 }),
  );

  it("reading what is kept again keeps the same", () => {
    fc.assert(
      fc.property(anyKey, anyFloor, (key, floor) => {
        const kept = keptPlace(key, floor);
        return kept === null || keptPlace(kept, floor) === kept;
      }),
      { ...SEEDED, numRuns: 2000 },
    );
  });

  it("a place kept has at least the floor, wherever any municipality does", () => {
    fc.assert(
      fc.property(anyKey, anyFloor, (key, floor) => {
        const kept = keptPlace(key, floor);
        if (floor > LARGEST) return kept === null;
        return kept !== null && (inhabitantsOf(kept) ?? -1) >= floor;
      }),
      { ...SEEDED, numRuns: 2000 },
    );
  });

  it("a raised floor reads a stored key at least as coarse, and a municipality never as an area", () => {
    fc.assert(
      fc.property(anyKey, anyFloor, anyFloor, (key, one, other) => {
        const [low, high] = [Math.min(one, other), Math.max(one, other)];
        const stored = keptPlace(key, low);
        if (stored === null || high > LARGEST) return true;
        const read = keptPlace(stored, high);
        if (read === null || (inhabitantsOf(read) ?? -1) < high) return false;
        return stored.length === 5 || read.length === 3;
      }),
      { ...SEEDED, numRuns: 2000 },
    );
  });

  it("a code the list lacks is never kept, nor any other text", () => {
    const known = new Set(areaRows.map((area) => area.code));
    fc.assert(
      fc.property(fc.stringMatching(/^\d{5}$/), anyFloor, (code, floor) => {
        return known.has(code) || keptPlace(code, floor) === null;
      }),
      { ...SEEDED, numRuns: 2000 },
    );
    fc.assert(
      fc.property(fc.string(), (text) => {
        return /^\d+$/.test(text) || keptPlace(text, FLOOR) === null;
      }),
      SEEDED,
    );
  });

  it("every place has a point and a town, and a town is large enough or Maarianhamina", () => {
    const names = new Map(municipalityRows.map((m) => [m.fi, m.inhabitants]));
    fc.assert(
      fc.property(anyKey, fc.integer({ min: 1, max: LARGEST + 1000 }), (key, townMin) => {
        const town = townOf(key, townMin);
        return (
          pointOf(key) !== null &&
          (town.fi === MARIEHAMN.fi || (names.get(town.fi) ?? -1) >= townMin)
        );
      }),
      { ...SEEDED, numRuns: 2000 },
    );
  });

  it("every code on the list reads as a home at the floor of the design", () => {
    for (const { code } of areaRows) {
      expect(homeSummary(keptPlace(code, FLOOR), false, rules), code).not.toBeNull();
    }
  });
});
