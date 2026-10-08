import { describe, expect, it } from "vitest";
import {
  CARD_FIELD_KEYS,
  cardFields,
  DEAL_BREAKER_FIELDS,
  HOBBIES,
  HOBBY_GROUP_KEYS,
  HOBBY_GROUPS,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  ProfileFields,
  SPECIAL_CATEGORY_FIELDS,
} from "./profile-fields.ts";

describe("the profile field registry (ADR-019)", () => {
  it("gives every field a kind, a role and a preference rule, and the contract names exactly those fields", () => {
    for (const key of PROFILE_FIELD_KEYS) {
      const spec = PROFILE_FIELDS[key];
      expect(["single", "multi", "text", "number", "flag"], key).toContain(spec.kind);
      expect(["hard", "soft", "info", "hidden"], key).toContain(spec.role);
      expect(["hard", "deal_breaker", "soft", "none"], key).toContain(spec.preferenceAbout);
      expect(typeof spec.specialCategory, key).toBe("boolean");
    }
    expect(Object.keys(ProfileFields.shape)).toEqual(PROFILE_FIELD_KEYS);
  });

  it("flags politics and religion as article 9, shown and never filtered, and nothing else", () => {
    expect(SPECIAL_CATEGORY_FIELDS).toEqual(["politics", "religion"]);
    for (const key of SPECIAL_CATEGORY_FIELDS) {
      expect(PROFILE_FIELDS[key].role).toBe("info");
      expect(PROFILE_FIELDS[key].preferenceAbout).toBe("none");
    }
  });

  it("allows a deal-breaker only on a shown field, never on a soft or hidden one", () => {
    for (const key of DEAL_BREAKER_FIELDS) expect(PROFILE_FIELDS[key].role, key).toBe("info");
    expect(DEAL_BREAKER_FIELDS).toEqual([
      "monogamy",
      "hasKids",
      "wantsKids",
      "smoking",
      "languages",
    ]);
    expect(PROFILE_FIELDS.intent).toMatchObject({ role: "hard", preferenceAbout: "hard" });
  });

  it("puts on a card what is shown and what was matched on, never a soft value or a setting", () => {
    expect(CARD_FIELD_KEYS).toContain("intent");
    expect(CARD_FIELD_KEYS).toContain("height");
    expect(CARD_FIELD_KEYS).toContain("politics");
    for (const key of ["education", "drinking", "drugsAttitude", "hideFromField"] as const) {
      expect(CARD_FIELD_KEYS).not.toContain(key);
    }
    expect(
      cardFields({ intent: "casual", education: "amk", hideFromField: true, height: 178 }),
    ).toEqual({ intent: "casual", height: 178 });
  });

  it("parses the sheet's answers and refuses what it does not list", () => {
    expect(
      ProfileFields.safeParse({
        intent: "open_to_either",
        height: 140,
        hobbies: ["sauna", "hiking"],
        politics: ["none_of_them"],
        religion: "agnostic",
        zodiac: "corgi",
        languages: ["fi", "se"],
        hideFromField: false,
        occupationTitle: "Nurse",
      }).success,
    ).toBe(true);
    for (const bad of [
      { intent: "friends" },
      { smoking: "snus" },
      { education: "master" },
      { height: 139 },
      { height: 221 },
      { height: 170.5 },
      { hobbies: HOBBIES.slice(0, 6) },
      { hobbies: [] },
      { languages: ["fi", "sv", "en", "et", "ru", "uk"] },
      { campus: "Otaniemi" },
      { hideFromField: "yes" },
      { occupationTitle: "x".repeat(41) },
    ]) {
      expect(ProfileFields.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("groups every hobby once, in one of the twelve groups, and keeps 'other' apart", () => {
    const grouped = Object.values(HOBBY_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped, "other"].sort()).toEqual([...HOBBIES].sort());
    expect(Object.keys(HOBBY_GROUPS)).toEqual([...HOBBY_GROUP_KEYS]);
    expect(HOBBY_GROUP_KEYS).toHaveLength(12);
  });
});
