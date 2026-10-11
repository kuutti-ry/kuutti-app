import { describe, expect, it } from "vitest";
import { type PersonaHistory, personaOf } from "./histories.ts";
import { assertArtificial, type DemoPersona, personaHetu } from "./personas.ts";
import { createRandom } from "./rng.ts";
import { BIOS, everyText, NAMES, OCCUPATION_TITLES, PROMPT_ANSWERS } from "./words.ts";

// The small parts the demo is made of (#73, ADR-014): the century sign of a
// persona's artificial code, a history that names nobody, the generator's
// refusals, and the list of every line a synthetic person can say.

const persona = (born: DemoPersona["born"], individual = 950): DemoPersona => ({
  key: "probe",
  given: "Probe",
  family: "Person",
  born,
  individual,
  group: "ages",
  note: "A persona made up in a test.",
});

describe("a persona's artificial code", () => {
  const at = new Date(Date.UTC(2026, 9, 11));

  it.each([
    ["1899", { year: 1899, month: 6, day: 15 }, "150699+950P"],
    ["1999", { year: 1999, month: 6, day: 15 }, "150699-950P"],
    ["2000", { year: 2000, month: 1, day: 1 }, "010100A9503"],
  ])("carries the century sign of a birth in %s", (_, born, hetu) => {
    expect(personaHetu(persona(born), at)).toBe(hetu);
  });

  it("is born on the first of the month a relative age points at", () => {
    expect(personaHetu(persona({ yearsAgo: 127, monthsAgo: 0 }), at)).toMatch(/^011099\+950/);
    expect(personaHetu(persona({ yearsAgo: 18, monthsAgo: 10 }), at)).toMatch(/^011207A950/);
  });

  it.each([899, 1000, 950.5, -950])(
    "is refused for an individual number of %d, which a person could hold",
    (n) => {
      const real = persona({ year: 1990, month: 1, day: 1 }, n);
      expect(() => assertArtificial(real)).toThrow(`individual number ${n} is outside 900 to 999`);
      expect(() => personaHetu(real, at)).toThrow(/outside 900 to 999/);
    },
  );

  it.each([900, 999])("takes the edge %d of the artificial range", (n) => {
    expect(() => assertArtificial(persona({ year: 1990, month: 1, day: 1 }, n))).not.toThrow();
  });
});

describe("a history", () => {
  it("that names no persona is a mistake, said as such", () => {
    expect(() => personaOf({ key: "nobody" } as PersonaHistory)).toThrow("no persona nobody");
  });
});

describe("the generator", () => {
  it.each<[Record<string, number>]>([
    [{}],
    [{ a: 0 }],
    [{ a: 0, b: 0 }],
    [{ a: -1, b: 1 }],
    [{ a: Number.NaN }],
  ])("refuses weights that sum to nothing: %o", (weights) => {
    expect(() => createRandom(1).weighted(weights)).toThrow("weights sum to nothing");
  });

  it("never draws a key of weight zero", () => {
    const random = createRandom(7);
    for (let i = 0; i < 500; i += 1)
      expect(random.weighted({ never: 0, always: 3 })).toBe("always");
  });

  it("refuses to pick from nothing, and samples no more than there is", () => {
    const random = createRandom(3);
    expect(() => random.pick([])).toThrow("nothing to pick from");
    expect(random.sample(["a", "b"], 5).sort()).toEqual(["a", "b"]);
    expect(random.sample(["a", "b"], 0)).toEqual([]);
  });
});

describe("every line a synthetic person can say", () => {
  const lines = everyText();

  it("holds every name, title, bio and prompt answer, in every language", () => {
    const expected = [
      ...Object.values(NAMES).flat(),
      ...Object.values(OCCUPATION_TITLES).flat(),
      ...Object.values(BIOS).flat(),
      ...Object.values(PROMPT_ANSWERS).flatMap((answers) => Object.values(answers).flat()),
    ];
    expect(lines).toEqual(expected);
    for (const language of ["fi", "sv", "en"] as const) {
      expect(lines, language).toEqual(expect.arrayContaining([...BIOS[language]]));
    }
  });

  it("is text: none of it empty, none of it padded", () => {
    for (const line of lines) {
      expect(line.length, line).toBeGreaterThan(0);
      expect(line.trim(), line).toBe(line);
    }
  });
});
