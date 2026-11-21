import { postalMatches } from "@kuutti/schema/postal-areas";
import { ageFromYearMonth } from "@kuutti-ry/tunnistus-oidc/hetu";
import { describe, expect, it } from "vitest";
import { PERSONA_HISTORIES, personaOf } from "./histories.ts";
import { DEMO_PERSONAS, personaBirth } from "./personas.ts";

// The stories of the personas (#73, ADR-014 §12).

// The demo's season, and two years on: a window wide enough for the one holds for the other.
const DAYS = [new Date(Date.UTC(2026, 9, 9)), new Date(Date.UTC(2028, 11, 31))];

describe("the stories of the personas", () => {
  it("seek an age window that holds the persona's own age, by the product's own age rule", () => {
    for (const history of PERSONA_HISTORIES) {
      if (!history.onboarding) continue;
      const { min, max } = history.onboarding.ageWindow;
      for (const at of DAYS) {
        const born = personaBirth(personaOf(history), at);
        const age = ageFromYearMonth(born.year, born.month, at);
        const where = `${history.key}, ${age} on ${at.toISOString().slice(0, 10)}`;
        expect(age, where).toBeGreaterThanOrEqual(min);
        expect(age, where).toBeLessThanOrEqual(max);
      }
    }
  });

  it("type a home the list knows, and only Otto, who left at the bank, has none", () => {
    for (const history of PERSONA_HISTORIES) {
      if (history.key === "otto") {
        expect(history.onboarding).toBeNull();
        continue;
      }
      const home = history.onboarding?.home ?? "";
      expect(
        postalMatches(home, 2).map((area) => area.code),
        history.key,
      ).toEqual([home]);
    }
  });

  it("make a member with a whole profile of every test user of the bed a person can sign in as (#560)", () => {
    // Mikael's bank returns a code the parser refuses (docs/vendors/telia.md 1.4): nobody reaches him.
    const reachable = DEMO_PERSONAS.filter((p) => p.bank && p.key !== "mikael");
    expect(reachable.map((p) => p.key)).toEqual([
      "aino",
      "sanna",
      "onni",
      "noa",
      "kerttu",
      "tapio",
      "ilona",
      "helmi",
    ]);
    for (const persona of reachable) {
      const history = PERSONA_HISTORIES.find((h) => h.key === persona.key);
      // Signed in, never refused: no ban, no deletion, and an onboarding that is done.
      expect(history?.onboarding, persona.key).not.toBeNull();
      expect(["nothing", "older_terms"], persona.key).toContain(history?.afterwards);
      expect(history?.profile?.fields.intent, persona.key).toBeDefined();
      expect(
        history?.profile?.bio ?? history?.profile?.bioPreset ?? null,
        persona.key,
      ).not.toBeNull();
    }
    // The states a flow needs are on people of the mock bank alone.
    for (const history of PERSONA_HISTORIES) {
      if (history.onboarding === null || ["banned", "deleted"].includes(history.afterwards)) {
        expect(personaOf(history).bank, history.key).toBeUndefined();
      }
    }
  });
});
