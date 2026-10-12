import { PROFILE_FIELD_KEYS } from "@kuutti/schema";
import { PROFILE_SECTIONS, type SectionItem, sectionOf } from "./sections";

describe("PROFILE_SECTIONS", () => {
  it("holds every field of the registry and the document's own parts exactly once", () => {
    const items = PROFILE_SECTIONS.flatMap((section) => [...section.items]);
    expect([...items].sort()).toEqual(
      [...PROFILE_FIELD_KEYS, "displayName", "bio", "prompts"].sort(),
    );
  });
});

describe("sectionOf", () => {
  it("names the section that holds an item", () => {
    expect(sectionOf("monogamy")).toBe("relationship");
    expect(sectionOf("prompts")).toBe("prompts");
    expect(sectionOf("displayName")).toBe("basics");
  });

  it("refuses an item no section holds", () => {
    expect(() => sectionOf("campus" as SectionItem)).toThrow("no section holds campus");
  });
});
