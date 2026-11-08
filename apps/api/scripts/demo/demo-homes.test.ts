import { MATCHING_CONFIG_V1 } from "@kuutti/db";
import {
  DEMO_SIZE_MAX,
  generatePopulation,
  PERSONA_HISTORIES,
  writePopulation,
} from "@kuutti/db/demo";
import { DISTANCE_BANDS } from "@kuutti/schema";
import { POSTAL_CODE_LENGTH } from "@kuutti/schema/postal-areas";
import { it } from "vitest";
import { bandBetween, type PoolPerson } from "../../src/matching/index.ts";
import { homeSummary, keptPlace, pointOf, readHome } from "../../src/pond/index.ts";
import { captureLogger, describe, expect, test } from "../../src/test/harness.ts";
import { populationHomes, populationWithHomes } from "./homes.ts";

// The demo's homes on the real list (#514, ADR-061 §2): what the population is
// drawn from and what the stories keep. How the generator draws is tested
// beside it, on a few places (packages/db/src/seed/population.test.ts).

const FLOOR = MATCHING_CONFIG_V1.home_min_inhabitants;
const RULES = { minInhabitants: FLOOR, townMin: MATCHING_CONFIG_V1.home_town_min_inhabitants };
const VERSIONS = { terms: "test-terms", privacy: "test-privacy", special_category: "test-special" };

const sum = (homes: Readonly<Record<string, number>>) =>
  Object.values(homes).reduce((total, people) => total + people, 0);

const homeAt = (place: string): PoolPerson["home"] => {
  const point = pointOf(place);
  if (!point) throw new Error(`${place} is not on the list`);
  return {
    ...point,
    edges: {
      nearby: MATCHING_CONFIG_V1.distance_nearby_km,
      close: MATCHING_CONFIG_V1.distance_close_km,
      around: MATCHING_CONFIG_V1.distance_around_km,
    },
  };
};

describe("the places the population is drawn from", () => {
  const homes = populationHomes();

  it("are places the rule keeps, with the country's people behind them", () => {
    for (const [place, people] of Object.entries(homes)) {
      expect(keptPlace(place, FLOOR), place).toBe(place);
      expect(people, place).toBeGreaterThan(0);
    }
    // 5.56 million in the list of 2026 (ADR-061's Context); the yearly list moves it a little.
    expect(sum(homes)).toBeGreaterThan(5_400_000);
    expect(sum(homes)).toBeLessThan(5_700_000);
  });

  it("count a small place's people for whoever keeps them", () => {
    // Kerttu's area: Ingå keeps its people.
    expect(homes["10210"]).toBeUndefined();
    expect(homes["149"]).toBeGreaterThan(0);
    // Helmi's area and her municipality: Mäntsälä keeps both.
    expect(homes["07560"]).toBeUndefined();
    expect(homes["616"]).toBeUndefined();
    expect(homes["505"]).toBeGreaterThan(0);
  });

  it("coarsen with a raised floor, and are none where no municipality reaches it", () => {
    const raised = populationHomes(20_000);
    expect(Object.keys(raised).length).toBeLessThan(Object.keys(homes).length);
    expect(sum(raised)).toBe(sum(homes));
    expect(populationHomes(10_000_000)).toEqual({});
  });
});

describe("the population on the real list", () => {
  const homes = populationHomes();
  const people = generatePopulation({ homes });

  it("keeps every home where the rule keeps it, and each reads as one", () => {
    const held = people.flatMap((person) => person.home ?? []);
    expect(held).toHaveLength(276);
    for (const { place, showsArea } of held) {
      expect(keptPlace(place, FLOOR), place).toBe(place);
      expect(homeSummary(place, showsArea, RULES)?.showArea, place).toBe(showsArea);
    }
  });

  it("is spread as the country's people are: seven in ten in an area of their own", () => {
    const held = generatePopulation({ size: DEMO_SIZE_MAX, homes }).flatMap((p) => p.home ?? []);
    const inAnArea = held.filter((home) => home.place.length === POSTAL_CODE_LENGTH);
    // ADR-061 §2: 71 % of the people.
    expect(inAnArea.length / held.length).toBeGreaterThan(0.68);
    expect(inAnArea.length / held.length).toBeLessThan(0.74);
  });

  it("reaches every band from one home", () => {
    const kallio = homeAt("00530");
    const bands = new Set(
      people.flatMap((p) => (p.home ? [bandBetween(kallio, homeAt(p.home.place))] : [])),
    );
    expect(bands).toEqual(new Set(DISTANCE_BANDS));
  });

  test("reads, once written, as the home that was drawn", async ({ ctx }) => {
    const { logger } = await captureLogger();
    // What the command writes: without its homes the writer refuses the first who onboarded.
    const few = populationWithHomes({ size: 40, seed: 7 });
    await writePopulation(ctx.client, few, VERSIONS);
    const { rows } = await ctx.client.query<{ id: string; subject: string }>(
      `SELECT a.id, i.broker_subject AS subject FROM account a JOIN identity i ON i.id = a.identity_id
       WHERE i.broker_subject LIKE '%demo-%'`,
    );
    expect(rows).toHaveLength(40);
    for (const person of few) {
      const account = rows.find((row) => row.subject.endsWith(person.label));
      const read = await readHome({ db: ctx.client, logger }, account?.id ?? "");
      expect(read, person.label).toEqual(
        person.home && homeSummary(person.home.place, person.home.showsArea, RULES),
      );
    }
  });
});

describe("what is kept of the codes the stories type", () => {
  const code = (key: string) => PERSONA_HISTORIES.find((h) => h.key === key)?.onboarding?.home;

  it("is a place for everybody who gets that far", () => {
    for (const history of PERSONA_HISTORIES) {
      if (!history.onboarding) continue;
      expect(keptPlace(history.onboarding.home, FLOOR), history.key).not.toBeNull();
    }
  });

  it.each([
    ["the area, where it is large enough", "iida", "00530"],
    ["the municipality, where the area is not", "kerttu", "149"],
    ["the nearest municipality that is, where hers is not", "helmi", "505"],
  ])("is %s: %s", (_, key, kept) => {
    expect(keptPlace(code(key) ?? "", FLOOR)).toBe(kept);
  });
});
