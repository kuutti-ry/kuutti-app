import { MATCHING_CONFIG_V1 } from "@kuutti/db";
import {
  DEMO_PERSONAS,
  PERSONA_CONVERSATIONS,
  PERSONA_HISTORIES,
  PERSONA_QUEUE_DAYS,
  type PersonaHistory,
  personaBirth,
  personaOf,
} from "@kuutti/db/demo";
import { describe, expect, it } from "vitest";
import { bandBetween, inEachOthersPool, type PoolPerson } from "../../src/matching/index.ts";
import { keptPlace, pointOf } from "../../src/pond/index.ts";
import { ageInYears, contactDetailsIn } from "../../src/profile/index.ts";

// The stories' conversations (#348) are matches the product's own rules
// allow: each pair in the other's pool, both ways (rule 7), and every message
// one the send would take; so is the queue of the stories (#379). Their shape
// and their writers are tested in packages/db (conversations.test.ts,
// queue.test.ts).

// The demo's season, and two years on: the windows are wide enough for both.
const DAYS = [new Date(Date.UTC(2026, 9, 17)), new Date(Date.UTC(2028, 11, 31))];
// Every first and last day of a month in between: an age turns at a month's end (TD-14).
const MONTH_ENDS = Array.from({ length: 27 }, (_, i) => [
  new Date(Date.UTC(2026, 9 + i, 1)),
  new Date(Date.UTC(2026, 10 + i, 0)),
]).flat();

const historyOf = (key: string): PersonaHistory => {
  const found = PERSONA_HISTORIES.find((h) => h.key === key);
  if (!found) throw new Error(`no history ${key}`);
  return found;
};

/** Where the pool reads the persona's home: the centre of what is kept of the code they type (ADR-061 §2, §5). */
function homeOf(key: string): PoolPerson["home"] {
  const code = historyOf(key).onboarding?.home ?? "";
  const kept = keptPlace(code, MATCHING_CONFIG_V1.home_min_inhabitants);
  const point = kept === null ? null : pointOf(kept);
  if (!point) throw new Error(`${key} has no home`);
  return {
    ...point,
    edges: {
      nearby: MATCHING_CONFIG_V1.distance_nearby_km,
      close: MATCHING_CONFIG_V1.distance_close_km,
      around: MATCHING_CONFIG_V1.distance_around_km,
    },
  };
}

/** The persona as the pool sees it on the day: the answers of the story, the age the card says. */
function poolPerson(key: string, at: Date): PoolPerson {
  const history = historyOf(key);
  const { onboarding, profile } = history;
  const intent = profile?.fields.intent;
  if (!onboarding || !intent) throw new Error(`${key} is in nobody's pool`);
  const born = personaBirth(personaOf(history), at);
  return {
    gender: onboarding.gender,
    seeks: onboarding.seeks,
    ageWindow: onboarding.ageWindow,
    age: ageInYears(born.year, born.month, at),
    intent,
    home: homeOf(key),
    identityId: key,
    blocks: new Set(),
    fields: profile.fields,
    // No persona sets a deal-breaker; one that does belongs here (#87).
    dealBreakers: [],
  };
}

describe("the stories' conversations", () => {
  it("are between two people in each other's pool, both ways, on every day of the demo", () => {
    for (const told of PERSONA_CONVERSATIONS) {
      const [a, b] = told.between;
      for (const at of DAYS) {
        expect(
          inEachOthersPool(poolPerson(a, at), poolPerson(b, at)),
          `${a} and ${b} on ${at.toISOString().slice(0, 10)}`,
        ).toBe(true);
      }
    }
  });

  it.each([
    ["the contact share's pair (#103)", "elina", "jussi"],
    ["the report's pair (#351)", "laura", "emmi"],
  ])("leave %s in each other's pool and in no other persona's", (_, first, second) => {
    const pair = [first, second];
    // Everybody a pool can hold: an answered intent, as onboarding leaves it.
    const others = PERSONA_HISTORIES.filter(
      (h) => h.onboarding && h.profile?.fields.intent && !pair.includes(h.key),
    ).map((h) => h.key);
    expect(others.length).toBeGreaterThan(0);
    for (const at of MONTH_ENDS) {
      const day = at.toISOString().slice(0, 10);
      expect(inEachOthersPool(poolPerson(first, at), poolPerson(second, at)), day).toBe(true);
      for (const key of pair) {
        for (const other of others) {
          expect(
            inEachOthersPool(poolPerson(key, at), poolPerson(other, at)),
            `${key} and ${other} on ${day}`,
          ).toBe(false);
        }
      }
    }
  });

  it("carry no contact details, which the send would refuse", () => {
    for (const told of PERSONA_CONVERSATIONS) {
      for (const message of told.messages) {
        expect(contactDetailsIn(message.body), message.body).toBeNull();
      }
      // A photo's caption follows the text's rules (#350).
      if (told.photo) expect(contactDetailsIn(told.photo.caption), told.photo.caption).toBeNull();
    }
  });
});

describe("the queue of the stories (#379)", () => {
  it("shows every band, a card to each, from where its owner lives (ADR-061 §5)", () => {
    for (const story of PERSONA_QUEUE_DAYS) {
      const cards = PERSONA_HISTORIES.filter((h) => personaOf(h).group === "cards").map((h) => [
        h.key,
        bandBetween(homeOf(story.of), homeOf(h.key)),
      ]);
      expect(Object.fromEntries(cards)).toEqual({
        henna: "nearby",
        katja: "close",
        minna: "around",
        riikka: "far",
      });
    }
  });

  it("holds people in each other's pool, both ways, and in no other persona's, on every day of the demo", () => {
    for (const story of PERSONA_QUEUE_DAYS) {
      // The queue's owner and everybody of her cast, who are each other's people only.
      const cast = PERSONA_HISTORIES.filter(
        (h) => h.key === story.of || personaOf(h).group === "cards",
      ).map((h) => h.key);
      expect(cast).toEqual(expect.arrayContaining([story.of, ...story.likedBy]));
      expect(cast.length).toBeGreaterThan(1 + story.likedBy.length);
      const others = PERSONA_HISTORIES.filter(
        (h) => h.onboarding && h.profile?.fields.intent && !cast.includes(h.key),
      ).map((h) => h.key);
      for (const at of MONTH_ENDS) {
        const day = at.toISOString().slice(0, 10);
        for (const card of cast.filter((key) => key !== story.of)) {
          expect(
            inEachOthersPool(poolPerson(story.of, at), poolPerson(card, at)),
            `${story.of} and ${card} on ${day}`,
          ).toBe(true);
        }
        for (const key of cast) {
          for (const other of others) {
            expect(
              inEachOthersPool(poolPerson(key, at), poolPerson(other, at)),
              `${key} and ${other} on ${day}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});

describe("the test persons of the bed (#560)", () => {
  it("are each other's people where their answers allow, so two people at two phones can meet", () => {
    // Mikael's bank returns a code the parser refuses (docs/vendors/telia.md 1.4): nobody reaches him.
    const reachable = DEMO_PERSONAS.filter((p) => p.bank && p.key !== "mikael").map((p) => p.key);
    expect(reachable).toHaveLength(8);
    const pairsOn = (at: Date) =>
      reachable
        .flatMap((first, i) =>
          reachable
            .slice(i + 1)
            .filter((second) => inEachOthersPool(poolPerson(first, at), poolPerson(second, at)))
            .map((second) => [first, second].sort().join("+")),
        )
        .sort();
    // Kerttu seeks people up to 56, which Tapio is until July 2027.
    const tapioIs57 = new Date(Date.UTC(2027, 6, 1));
    for (const at of MONTH_ENDS) {
      const always = ["aino+onni", "ilona+tapio", "sanna+tapio"];
      expect(pairsOn(at), at.toISOString().slice(0, 10)).toEqual(
        at < tapioIs57 ? [...always, "kerttu+tapio"].sort() : always,
      );
    }
    // Two have only the cast. Noa, 43, could be Aino's alone, who seeks non-binary people too,
    // and a window of hers that held Noa would hold Jussi, 39, whom the contact share's flow
    // keeps to Elina (above). Helmi, 94: nobody of her years exists, and she has no photos.
    const linked = new Set(pairsOn(MONTH_ENDS[0] as Date).flatMap((pair) => pair.split("+")));
    expect(reachable.filter((key) => !linked.has(key))).toEqual(["noa", "helmi"]);
  });
});
