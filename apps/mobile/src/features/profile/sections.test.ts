import { createI18n, typedT } from "@kuutti/i18n";
import { PROFILE_FIELD_KEYS } from "@kuutti/schema";
import {
  LISTED_SECTIONS,
  PROFILE_SECTIONS,
  type SectionItem,
  sectionHintKey,
  sectionOf,
  sectionTitleKey,
} from "./sections";

const ids = (sections: readonly { id: string }[]) => sections.map(({ id }) => id);

describe("PROFILE_SECTIONS", () => {
  it("holds every field of the registry and the document's own parts exactly once", () => {
    const items = PROFILE_SECTIONS.flatMap((section) => [...section.items]);
    expect([...items].sort()).toEqual(
      [...PROFILE_FIELD_KEYS, "displayName", "bio", "prompts"].sort(),
    );
  });
});

describe("LISTED_SECTIONS", () => {
  it("leaves out what one is here for and nothing else, each in its place: it has one door (#542)", () => {
    expect(ids(PROFILE_SECTIONS)).toContain("intent");
    expect(ids(LISTED_SECTIONS)).toEqual(ids(PROFILE_SECTIONS).filter((id) => id !== "intent"));
  });
});

describe("sectionOf", () => {
  it("names the section that holds an item", () => {
    expect(sectionOf("monogamy")).toBe("relationship");
    expect(sectionOf("prompts")).toBe("prompts");
    expect(sectionOf("displayName")).toBe("basics");
  });

  it("holds what one is here for in a section of its own, out of the relationship (#542)", () => {
    expect(sectionOf("intent")).toBe("intent");
  });

  it("refuses an item no section holds", () => {
    expect(() => sectionOf("campus" as SectionItem)).toThrow("no section holds campus");
  });
});

describe("sectionTitleKey", () => {
  it("names what one is here for by onboarding's own question (#542)", () => {
    expect(sectionTitleKey("intent")).toBe("onboarding.intent.title");
  });

  it("names every section of the list by its own title", () => {
    for (const { id } of LISTED_SECTIONS) {
      expect(sectionTitleKey(id)).toBe(`profile.section.${id}.title`);
    }
  });

  it.each(["en", "fi", "sv"] as const)(
    "has words in %s for every title, and every row's hint",
    (locale) => {
      const t = typedT(createI18n({ locale }));
      const keys = [
        ...PROFILE_SECTIONS.map(({ id }) => sectionTitleKey(id)),
        ...LISTED_SECTIONS.flatMap(({ id }) => sectionHintKey(id) ?? []),
      ];
      for (const key of keys) expect(t(key)).not.toBe(key);
    },
  );
});

describe("sectionHintKey", () => {
  it("names what a section holds for a screen reader, each by its own words (#581)", () => {
    const hints = LISTED_SECTIONS.map(({ id }) => [id, sectionHintKey(id)]);
    expect(hints).toEqual([
      ["basics", "profile.section.basics.summary"],
      ["prompts", undefined],
      ["relationship", "profile.section.relationship.summary"],
      ["work", "profile.section.work.summary"],
      ["lifestyle", "profile.section.lifestyle.summary"],
      ["hobbies", "profile.section.hobbies.summary"],
      ["beliefs", "profile.section.beliefs.summary"],
    ]);
  });
});
