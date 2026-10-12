import { describe, expect, it } from "vitest";
import { GROUP_REASON, groupLineKeys, groupOf, LABEL_GROUPS } from "./label-groups.ts";

// What the check does with Rekognition's moderation labels (#253, ADR-006 §2):
// the maintainer's groups of 12/10/2026, by the taxonomy's names, any case.

describe("label groups", () => {
  it.each([
    ["Explicit", "nudity"],
    ["Exposed Male Genitalia", "nudity"],
    ["exposed female genitalia", "nudity"],
    ["Implied Nudity", "nudity"],
    ["Obstructed Male Genitalia", "nudity"],
    ["Weapons", "violence"],
    ["Self-Harm", "violence"],
    ["Corpses", "disturbing"],
    ["Hate Symbols", "hate"],
    ["Nazi Party", "hate"],
    ["Bare Back", "allowed"],
    ["Exposed Male Nipple", "allowed"],
    ["Kissing on the Lips", "allowed"],
    ["MALE SWIMWEAR OR UNDERWEAR", "allowed"],
    ["Smoking", "allowed"],
    ["Pills", "allowed"],
    ["Alcoholic Beverages", "allowed"],
    ["Middle Finger", "allowed"],
    ["Gambling", "allowed"],
  ])("%s is %s", (name, group) => {
    expect(groupOf(name)).toBe(group);
  });

  it("knows nothing of a name outside the taxonomy, so a person decides on it", () => {
    expect(groupOf("Suggestive")).toBeUndefined();
    expect(groupOf("")).toBeUndefined();
  });

  it("gives each hard group the words the owner reads and its two lines in matching_config", () => {
    expect(LABEL_GROUPS.map((group) => [group, GROUP_REASON[group]])).toEqual([
      ["nudity", "nudity"],
      ["violence", "violence"],
      ["disturbing", "other"],
      ["hate", "other"],
    ]);
    expect(groupLineKeys("nudity")).toEqual({
      review: "photo_moderation_nudity_review",
      reject: "photo_moderation_nudity_reject",
    });
  });
});
