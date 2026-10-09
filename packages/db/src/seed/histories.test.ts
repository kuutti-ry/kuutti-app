import { ageFromYearMonth } from "@kuutti/tunnistus-oidc/hetu";
import { describe, expect, it } from "vitest";
import { PERSONA_HISTORIES, personaOf } from "./histories.ts";
import { personaBirth } from "./personas.ts";

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
});
