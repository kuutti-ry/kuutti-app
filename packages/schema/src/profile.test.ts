import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BIO_MAX,
  BIO_PRESETS,
  bioOrPromptsComplete,
  CardPreviewResponse,
  Completeness,
  DISPLAY_NAME_MAX,
  PROMPT_KEYS,
  PROMPTS_MAX,
  ProfileCard,
  ProfileDocument,
  ProfileResponse,
  ProfileUpdate,
  PromptAnswer,
} from "./profile.ts";
import { PROFILE_FIELDS } from "./profile-fields.ts";

// The profile as written and the card as seen (#47, ADR-009): trimmed text at
// its bounds, a bio or a placeholder, each prompt once, and a card that says
// the bank verified the age.

const issues = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.join("."),
    message: issue.message,
  })) ?? [];
const codes = (schema: z.ZodType, input: unknown) =>
  issues(schema, input).map((issue) => issue.code);

const at = "2026-10-01T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("a prompt answer", () => {
  it.each(PROMPT_KEYS)("answers the prompt %s", (key) => {
    expect(PromptAnswer.parse({ key, answer: "yes" })).toEqual({ key, answer: "yes" });
  });

  it("is trimmed before it is measured", () => {
    const longest = "a".repeat(160);
    expect(PromptAnswer.parse({ key: "sunday", answer: `  ${longest}\n` }).answer).toBe(longest);
    expect(codes(PromptAnswer, { key: "sunday", answer: `${longest}a` })).toEqual(["too_big"]);
  });

  it.each([
    ["an empty answer", { key: "sunday", answer: "" }, "too_small"],
    ["an answer of spaces", { key: "sunday", answer: " \t\n " }, "too_small"],
    ["a prompt outside the list", { key: "salary", answer: "x" }, "invalid_value"],
    ["an extra key", { key: "sunday", answer: "x", order: 1 }, "unrecognized_keys"],
  ])("refuses %s", (_, answer, code) => {
    expect(codes(PromptAnswer, answer)).toEqual([code]);
  });
});

const profile = {
  displayName: "Aino",
  bio: null,
  bioPreset: null,
  fields: {},
  prompts: [],
};

describe("the profile update", () => {
  it("takes the least: a name and nothing else answered", () => {
    expect(ProfileUpdate.parse(profile)).toEqual(profile);
  });

  it("takes a bio, or a placeholder, each alone", () => {
    expect(ProfileUpdate.parse({ ...profile, bio: " hello " }).bio).toBe("hello");
    for (const bioPreset of BIO_PRESETS) {
      expect(ProfileUpdate.parse({ ...profile, bioPreset }).bioPreset).toBe(bioPreset);
    }
  });

  it("refuses a bio and a placeholder together, said at the placeholder", () => {
    expect(issues(ProfileUpdate, { ...profile, bio: "hello", bioPreset: "photos_speak" })).toEqual([
      { code: "custom", path: "bioPreset", message: "a bio or a placeholder, not both" },
    ]);
  });

  it("refuses a prompt answered twice, said at the prompts", () => {
    const twice = [
      { key: "sunday", answer: "one" },
      { key: "sunday", answer: "two" },
    ];
    expect(issues(ProfileUpdate, { ...profile, prompts: twice })).toEqual([
      { code: "custom", path: "prompts", message: "each prompt at most once" },
    ]);
  });

  it("says both refinements when both are broken", () => {
    const both = {
      ...profile,
      bio: "hello",
      bioPreset: "ask_me_instead",
      prompts: [
        { key: "overrated", answer: "a" },
        { key: "overrated", answer: "b" },
      ],
    };
    expect(issues(ProfileUpdate, both).map((issue) => issue.path)).toEqual([
      "bioPreset",
      "prompts",
    ]);
  });

  it("takes three different prompts and refuses a fourth", () => {
    const three = PROMPT_KEYS.slice(0, PROMPTS_MAX).map((key) => ({ key, answer: "x" }));
    expect(ProfileUpdate.parse({ ...profile, prompts: three }).prompts).toHaveLength(3);
    const four = PROMPT_KEYS.slice(0, 4).map((key) => ({ key, answer: "x" }));
    expect(codes(ProfileUpdate, { ...profile, prompts: four })).toEqual(["too_big"]);
  });

  it.each([
    [DISPLAY_NAME_MAX, "displayName", true],
    [DISPLAY_NAME_MAX + 1, "displayName", false],
    [BIO_MAX, "bio", true],
    [BIO_MAX + 1, "bio", false],
  ])("measures %i characters of %s after trimming: %s", (length, key, ok) => {
    const value = ` ${"x".repeat(length)} `;
    expect(ProfileUpdate.safeParse({ ...profile, [key]: value }).success).toBe(ok);
  });

  it.each([
    ["an empty name", { displayName: "" }, "too_small"],
    ["a name of spaces", { displayName: "   " }, "too_small"],
    ["an empty bio instead of null", { bio: "  " }, "too_small"],
    ["a placeholder outside the list", { bioPreset: "mysterious" }, "invalid_value"],
    ["a field outside the registry", { fields: { starSign: "leo" } }, "unrecognized_keys"],
    [
      "an option outside the field's list",
      { fields: { smoking: "sometimes_maybe" } },
      "invalid_value",
    ],
    [
      "the special-category consent in the document",
      { specialCategoryConsent: true },
      "unrecognized_keys",
    ],
    ["no prompts list", { prompts: undefined }, "invalid_type"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(ProfileUpdate, { ...profile, ...change })).toEqual([code]);
  });
});

describe("the profile as its owner reads it back", () => {
  const document = {
    displayName: "Aino",
    bio: "hello",
    bioPreset: null,
    fields: { smoking: "never" },
    prompts: [{ key: "sunday", answer: "sauna" }],
    specialCategoryConsent: { version: "2026-09-01", at },
    updatedAt: at,
  };

  it("carries the special-category consent read-only, or null", () => {
    expect(ProfileDocument.parse(document)).toEqual(document);
    expect(
      ProfileDocument.parse({ ...document, specialCategoryConsent: null }).specialCategoryConsent,
    ).toBeNull();
    expect(
      codes(ProfileDocument, { ...document, specialCategoryConsent: { version: "1", at: "now" } }),
    ).toEqual(["invalid_format"]);
  });

  it("is null before the first save, with what is missing", () => {
    const response = {
      profile: null,
      completeness: { complete: false, missing: ["display_name", "photos"] },
    };
    expect(ProfileResponse.parse(response)).toEqual(response);
  });

  it("refuses an unknown missing item", () => {
    expect(codes(Completeness, { complete: false, missing: ["height"] })).toEqual([
      "invalid_value",
    ]);
    expect(codes(Completeness, { complete: false, missing: Array(9).fill("photos") })).toEqual([
      "too_big",
    ]);
  });
});

describe("the card another person sees", () => {
  const card = {
    accountId: uuid(1),
    displayName: "Aino",
    age: { years: 34, verifiedByBank: true },
    gender: "woman",
    pond: null,
    photos: [{ id: uuid(2), blurhash: "LEHV6n", width: 800, height: 1067, caption: null }],
    fields: {},
    bio: null,
    bioPreset: "photos_speak",
    prompts: [],
    shared: { hobbies: ["sauna"], languages: [] },
  };

  it("carries the owner's caption of a photo (#296), null when the API did not say", () => {
    const withLine = { ...card, photos: [{ ...card.photos[0], caption: "summer_day" }] };
    expect(ProfileCard.parse(withLine).photos[0]?.caption).toBe("summer_day");
    const older = {
      ...card,
      photos: [{ id: uuid(2), blurhash: "LEHV6n", width: 800, height: 1067 }],
    };
    expect(ProfileCard.parse(older).photos[0]?.caption).toBeNull();
  });

  it("parses with the bank-verified age", () => {
    expect(ProfileCard.parse(card)).toEqual(card);
  });

  it("drops what a card never carries, like a like count", () => {
    expect(ProfileCard.parse({ ...card, likes: 12, exposures: 40 })).not.toHaveProperty("likes");
  });

  it.each([
    [
      "an age the bank did not verify",
      { age: { years: 34, verifiedByBank: false } },
      "invalid_value",
    ],
    ["an age of 17", { age: { years: 17, verifiedByBank: true } }, "too_small"],
    ["an age of 131", { age: { years: 131, verifiedByBank: true } }, "too_big"],
    [
      "a photo with a URL in place of its size",
      { photos: [{ id: uuid(2), blurhash: "LEHV6n", url: "https://x" }] },
      "invalid_type",
    ],
    [
      "too many shared hobbies",
      {
        shared: {
          hobbies: Array(PROFILE_FIELDS.hobbies.options.length + 1).fill("x"),
          languages: [],
        },
      },
      "too_big",
    ],
    [
      "too many shared languages",
      {
        shared: {
          hobbies: [],
          languages: Array(PROFILE_FIELDS.languages.options.length + 1).fill("fi"),
        },
      },
      "too_big",
    ],
    ["a gender outside the list", { gender: "female" }, "invalid_value"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(ProfileCard, { ...card, ...change })).toContain(code);
  });

  it("marks every hobby and language as shared, more than the old five (#239)", () => {
    const all = {
      hobbies: [...PROFILE_FIELDS.hobbies.options],
      languages: [...PROFILE_FIELDS.languages.options],
    };
    expect(ProfileCard.parse({ ...card, shared: all }).shared).toEqual(all);
  });

  it("previews the owner's own card, or none, with what is missing", () => {
    const completeness = { complete: true, missing: [] };
    expect(CardPreviewResponse.parse({ card, completeness }).card?.displayName).toBe("Aino");
    expect(CardPreviewResponse.parse({ card: null, completeness }).card).toBeNull();
  });
});

describe("the words that count for completeness", () => {
  const words = (bio: string | null, bioPreset: string | null = null, answeredPrompts = 0) =>
    bioOrPromptsComplete({ bio, bioPreset, answeredPrompts });

  it("takes a bio of the minimum length, measured after trimming", () => {
    expect(words("x".repeat(50))).toBe(true);
    expect(words("x".repeat(49))).toBe(false);
    expect(words(`  ${"x".repeat(49)}  `)).toBe(false);
    expect(words(`  ${"x".repeat(50)}  `)).toBe(true);
  });

  it("takes a ready line alone, or two answered prompts alone", () => {
    expect(words(null, "lazy_nice_fellow")).toBe(true);
    expect(words(null, null, 2)).toBe(true);
    expect(words(null, null, 3)).toBe(true);
  });

  it("refuses nothing, an empty bio, and a short bio with one prompt", () => {
    expect(words(null)).toBe(false);
    expect(words("")).toBe(false);
    expect(words("x".repeat(49), null, 1)).toBe(false);
  });
});
