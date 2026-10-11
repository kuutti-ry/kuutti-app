// biome-ignore lint/style/noRestrictedImports: a test of the demo's words against the slice's own rule; nothing of it is bundled
import { everyText, generatePopulation } from "@kuutti/db/demo";
import { describe, expect, it } from "vitest";
import { contactDetailsIn } from "./text.ts";

// The words of the synthetic population (#73, ADR-014) are text a person
// could have typed, so they pass the rule a person's text passes. Here and
// not with the generator: the rule is the profile slice's.

describe("the words of the synthetic population", () => {
  it("carry no way to reach anybody: every line passes the plain-text rule", () => {
    const lines = everyText();
    expect(lines.length).toBeGreaterThan(100);
    for (const line of lines) {
      expect(contactDetailsIn(line), line).toBeNull();
    }
  });

  it("and so does everything the generator puts on a profile", () => {
    for (const person of generatePopulation()) {
      if (!person.profile) continue;
      const { displayName, bio, fields, prompts } = person.profile;
      for (const text of [
        displayName,
        bio,
        fields.occupationTitle,
        ...prompts.map((p) => p.answer),
      ]) {
        if (text != null) expect(contactDetailsIn(text), `${person.label}: ${text}`).toBeNull();
      }
    }
  });
});
