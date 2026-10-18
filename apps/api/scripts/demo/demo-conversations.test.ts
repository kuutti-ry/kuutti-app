import {
  PERSONA_CONVERSATIONS,
  PERSONA_HISTORIES,
  type PersonaHistory,
  personaBirth,
  personaOf,
} from "@kuutti/db/demo";
import { describe, expect, it } from "vitest";
import { inEachOthersPool, type PoolPerson } from "../../src/matching/index.ts";
import { ageInYears, contactDetailsIn } from "../../src/profile/index.ts";

// The stories' conversations (#348) are matches the product's own rules
// allow: each pair in the other's pool, both ways (rule 7), and every message
// one the send would take. Their shape and their writer are tested in
// packages/db (conversations.test.ts).

// The demo's season, and two years on: the windows are wide enough for both.
const DAYS = [new Date(Date.UTC(2026, 9, 17)), new Date(Date.UTC(2028, 11, 31))];

const historyOf = (key: string): PersonaHistory => {
  const found = PERSONA_HISTORIES.find((h) => h.key === key);
  if (!found) throw new Error(`no history ${key}`);
  return found;
};

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
    identityId: key,
    blocks: new Set(),
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

  it("leave the contact share's pair in each other's pool and in no other persona's (#103)", () => {
    const pair = ["elina", "jussi"];
    // Everybody a pool can hold: an answered intent, as onboarding leaves it.
    const others = PERSONA_HISTORIES.filter(
      (h) => h.onboarding && h.profile?.fields.intent && !pair.includes(h.key),
    ).map((h) => h.key);
    expect(others.length).toBeGreaterThan(0);
    for (const at of DAYS) {
      const day = at.toISOString().slice(0, 10);
      expect(inEachOthersPool(poolPerson("elina", at), poolPerson("jussi", at)), day).toBe(true);
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

  it("leave the report's pair in each other's pool and in no other persona's (#351)", () => {
    const pair = ["laura", "emmi"];
    // Everybody a pool can hold: an answered intent, as onboarding leaves it.
    const others = PERSONA_HISTORIES.filter(
      (h) => h.onboarding && h.profile?.fields.intent && !pair.includes(h.key),
    ).map((h) => h.key);
    expect(others.length).toBeGreaterThan(0);
    for (const at of DAYS) {
      const day = at.toISOString().slice(0, 10);
      expect(inEachOthersPool(poolPerson("laura", at), poolPerson("emmi", at)), day).toBe(true);
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
