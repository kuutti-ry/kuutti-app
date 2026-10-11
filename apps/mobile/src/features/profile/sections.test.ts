import { PROFILE_FIELD_KEYS } from "@kuutti/schema";
import { PROFILE_SECTIONS } from "./sections";

describe("PROFILE_SECTIONS", () => {
  it("holds every field of the registry and the document's own parts exactly once", () => {
    const items = PROFILE_SECTIONS.flatMap((section) => [...section.items]);
    expect([...items].sort()).toEqual(
      [...PROFILE_FIELD_KEYS, "displayName", "bio", "prompts"].sort(),
    );
  });
});
