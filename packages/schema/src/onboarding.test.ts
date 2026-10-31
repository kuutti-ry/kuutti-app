import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ACTIVATION_STEPS,
  AGE_MAX,
  AGE_MIN,
  AgeWindow,
  CONSENT_KINDS,
  ConsentRecord,
  ConsentRequest,
  ConsentsResponse,
  GENDERS,
  GenderUpdate,
  HomeSummary,
  HomeUpdate,
  ONBOARDING_STEPS,
  OnboardingStatus,
  PLACE_NAME_MAX,
  PlaceName,
  PondSummary,
  PostalCode,
  PreferencesResponse,
  PreferencesUpdate,
  WithdrawableConsentKind,
} from "./onboarding.ts";

// Onboarding and consents (#46, ADR-010): the hard filters of rule 7 at their
// bounds, the refinements with their messages, and the consents.

const issues = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.join("."),
    message: issue.message,
  })) ?? [];
const codes = (schema: z.ZodType, input: unknown) =>
  issues(schema, input).map((issue) => issue.code);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-01T12:00:00.000Z";

describe("the age window", () => {
  it.each([
    [18, 18],
    [18, 99],
    [30, 30],
    [99, 99],
    [25, 40],
  ])("takes %i to %i", (min, max) => {
    expect(AgeWindow.parse({ min, max })).toEqual({ min, max });
  });

  it("is bounded by 18 and 99", () => {
    expect([AGE_MIN, AGE_MAX]).toEqual([18, 99]);
  });

  it.each([
    ["a minimum under 18", { min: 17, max: 30 }, "too_small", "min"],
    ["a maximum over 99", { min: 30, max: 100 }, "too_big", "max"],
    ["a fractional minimum", { min: 18.5, max: 30 }, "invalid_type", "min"],
    ["a minimum as a string", { min: "18", max: 30 }, "invalid_type", "min"],
  ])("refuses %s", (_, window, code, path) => {
    expect(issues(AgeWindow, window).map((i) => [i.code, i.path])).toEqual([[code, path]]);
  });

  it("refuses a minimum above the maximum, said at the maximum", () => {
    expect(issues(AgeWindow, { min: 41, max: 40 })).toEqual([
      { code: "custom", path: "max", message: "min is at most max" },
    ]);
  });

  it("says both what is out of bounds and what is inverted in one answer", () => {
    expect(issues(AgeWindow, { min: 18, max: 17 }).map((i) => [i.code, i.path])).toEqual([
      ["too_small", "max"],
      ["custom", "max"],
    ]);
  });

  it("refuses an extra key", () => {
    expect(codes(AgeWindow, { min: 20, max: 30, step: 1 })).toEqual(["unrecognized_keys"]);
  });
});

describe("the preferences update", () => {
  it.each([
    ["whom one seeks alone", { seeks: ["woman"] }],
    ["the age window alone", { ageWindow: { min: 20, max: 30 } }],
    ["both", { seeks: ["man", "non_binary"], ageWindow: { min: 30, max: 45 } }],
    ["every gender", { seeks: [...GENDERS] }],
  ])("takes %s", (_, update) => {
    expect(PreferencesUpdate.parse(update)).toEqual(update);
  });

  it("refuses neither, with the message that says what it needs", () => {
    expect(issues(PreferencesUpdate, {})).toEqual([
      { code: "custom", path: "", message: "whom one seeks, the age window or both" },
    ]);
  });

  it("refuses a gender twice", () => {
    expect(issues(PreferencesUpdate, { seeks: ["woman", "woman"] })).toEqual([
      { code: "custom", path: "seeks", message: "each gender at most once" },
    ]);
  });

  it.each([
    ["nobody", { seeks: [] }, "too_small"],
    ["four answers", { seeks: ["woman", "man", "non_binary", "woman"] }, "too_big"],
    ["a gender outside the list", { seeks: ["other"] }, "invalid_value"],
    ["an extra key", { seeks: ["man"], includeUnknown: true }, "unrecognized_keys"],
  ])("refuses %s", (_, update, code) => {
    expect(codes(PreferencesUpdate, update)).toContain(code);
  });

  it("refuses an inverted window inside the update", () => {
    expect(issues(PreferencesUpdate, { ageWindow: { min: 50, max: 20 } })).toEqual([
      { code: "custom", path: "ageWindow.max", message: "min is at most max" },
    ]);
  });

  it("reads back null for what was never answered", () => {
    expect(PreferencesResponse.parse({ seeks: null, ageWindow: null })).toEqual({
      seeks: null,
      ageWindow: null,
    });
    expect(codes(PreferencesResponse, { seeks: Array(4).fill("man"), ageWindow: null })).toEqual([
      "too_big",
    ]);
  });
});

describe("the gender", () => {
  it.each(GENDERS)("takes %s as self-declared", (gender) => {
    expect(GenderUpdate.parse({ gender })).toEqual({ gender });
  });

  it("refuses anything outside the list, nothing and an extra key", () => {
    expect(codes(GenderUpdate, { gender: "female" })).toEqual(["invalid_value"]);
    expect(codes(GenderUpdate, {})).toEqual(["invalid_value"]);
    expect(codes(GenderUpdate, { gender: "woman", legalSex: "F" })).toEqual(["unrecognized_keys"]);
  });
});

describe("the pond", () => {
  const pond = {
    id: uuid(1),
    slug: "helsinki",
    name: "Helsinki",
    nameInessive: "Helsingissä",
    parentId: null,
  };

  it("carries both case forms and the parent", () => {
    expect(PondSummary.parse(pond)).toEqual(pond);
    expect(PondSummary.parse({ ...pond, parentId: uuid(2) }).parentId).toBe(uuid(2));
  });

  it.each([
    ["an empty slug", { slug: "" }, "too_small"],
    ["a slug of 61 characters", { slug: "s".repeat(61) }, "too_big"],
    ["a name of 81 characters", { name: "n".repeat(81) }, "too_big"],
    ["no inessive", { nameInessive: "" }, "too_small"],
    ["a parent that is not a uuid", { parentId: "uusimaa" }, "invalid_format"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(PondSummary, { ...pond, ...change })).toEqual([code]);
  });
});

describe("the home postal code", () => {
  it.each(["00100", "00530", "83960", "99990", "12345"])("takes %s as five digits", (code) => {
    expect(PostalCode.parse(code)).toBe(code);
  });

  it.each([
    ["nothing", ""],
    ["four digits", "0010"],
    ["six digits", "001000"],
    ["a letter", "0010a"],
    ["a name", "Kallio"],
    ["a space before", " 00100"],
    ["a space after", "00100 "],
    ["a line after", "00100\n"],
    ["digits of another script", "٠٠١٠٠"],
  ])("refuses %s", (_, code) => {
    expect(codes(PostalCode, code)).toEqual(["invalid_format"]);
  });

  it.each([
    ["a number", 100],
    ["null", null],
    ["nothing at all", undefined],
  ])("refuses %s, which is no text", (_, code) => {
    expect(codes(PostalCode, code)).toEqual(["invalid_type"]);
  });

  it("is refused by the pattern and never quotes what was typed (ADR-061 §9)", () => {
    const answer = JSON.stringify(PostalCode.safeParse("1234x").error?.issues);
    expect(answer).not.toContain("1234x");
  });
});

describe("a place's name", () => {
  const place = { fi: "Helsinki", sv: "Helsingfors" };

  it("is Finnish and Swedish", () => {
    expect(PlaceName.parse(place)).toEqual(place);
  });

  it(`takes ${PLACE_NAME_MAX} characters and no more`, () => {
    const longest = "n".repeat(PLACE_NAME_MAX);
    expect(PlaceName.safeParse({ fi: longest, sv: longest }).success).toBe(true);
    expect(codes(PlaceName, { ...place, fi: `${longest}n` })).toEqual(["too_big"]);
    expect(codes(PlaceName, { ...place, sv: `${longest}n` })).toEqual(["too_big"]);
  });

  it.each([
    ["an empty Finnish name", { fi: "" }, "too_small"],
    ["an empty Swedish name", { sv: "" }, "too_small"],
    ["no Swedish name", { sv: undefined }, "invalid_type"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(PlaceName, { ...place, ...change })).toEqual([code]);
  });
});

describe("a home as its owner reads it", () => {
  const town = { fi: "Helsinki", sv: "Helsingfors" };
  const area = { fi: "Kallio", sv: "Berghäll" };

  it("names the town and the area, and says which the card shows", () => {
    const home = { town, area, showArea: true };
    expect(HomeSummary.parse(home)).toEqual(home);
  });

  it("has no area where a municipality is kept", () => {
    const home = { town, area: null, showArea: false };
    expect(HomeSummary.parse(home)).toEqual(home);
  });

  it("drops anything but names, a key or digits above all", () => {
    expect(HomeSummary.parse({ town, area, showArea: false, key: "00530" })).toEqual({
      town,
      area,
      showArea: false,
    });
  });

  it.each([
    ["no town", { town: null }, "invalid_type"],
    ["no word on the choice", { showArea: undefined }, "invalid_type"],
    ["a choice as text", { showArea: "yes" }, "invalid_type"],
    ["an area with no name", { area: { fi: "", sv: "x" } }, "too_small"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(HomeSummary, { town, area, showArea: false, ...change })).toEqual([code]);
  });
});

describe("the home update", () => {
  it.each([
    ["a code alone", { postalCode: "00530" }],
    ["the choice alone, which needs no code", { showArea: true }],
    ["the choice taken back", { showArea: false }],
    ["both", { postalCode: "00530", showArea: true }],
  ])("takes %s", (_, update) => {
    expect(HomeUpdate.parse(update)).toEqual(update);
  });

  it("refuses neither, with the message that says what it needs", () => {
    expect(issues(HomeUpdate, {})).toEqual([
      { code: "custom", path: "", message: "a postal code, what the card shows or both" },
    ]);
  });

  it.each([
    ["a code that is no code", { postalCode: "530" }, "invalid_format"],
    ["a code as a number", { postalCode: 530 }, "invalid_type"],
    ["a choice as text", { showArea: "true" }, "invalid_type"],
    ["a null code", { postalCode: null }, "invalid_type"],
    ["an extra key", { postalCode: "00530", town: "Helsinki" }, "unrecognized_keys"],
  ])("refuses %s", (_, update, code) => {
    expect(codes(HomeUpdate, update)).toContain(code);
  });
});

describe("the consents", () => {
  const request = { kind: "terms", version: "2026-09-01", locale: "fi" };

  it.each(CONSENT_KINDS)("take the kind %s", (kind) => {
    expect(ConsentRequest.parse({ ...request, kind }).kind).toBe(kind);
  });

  it("are withdrawn only for research and the special categories", () => {
    expect(WithdrawableConsentKind.options).toEqual(["research", "special_category"]);
    expect(codes(WithdrawableConsentKind, "terms")).toEqual(["invalid_value"]);
    expect(codes(WithdrawableConsentKind, "privacy")).toEqual(["invalid_value"]);
  });

  it.each([
    ["an empty version", { version: "" }, "too_small"],
    ["a version of 41 characters", { version: "v".repeat(41) }, "too_big"],
    ["a language outside the three", { locale: "de" }, "invalid_value"],
    ["an unknown kind", { kind: "marketing" }, "invalid_value"],
    ["an extra key", { givenAt: at }, "unrecognized_keys"],
  ])("refuse a request with %s", (_, change, code) => {
    expect(codes(ConsentRequest, { ...request, ...change })).toEqual([code]);
  });

  it("take a version of forty characters", () => {
    expect(ConsentRequest.safeParse({ ...request, version: "v".repeat(40) }).success).toBe(true);
  });

  it("read back each consent with its withdrawal, and the current wordings", () => {
    const record = { ...request, givenAt: at, withdrawnAt: null };
    const versions = { terms: "1", privacy: "1", research: "1", special_category: "1" };
    expect(ConsentRecord.parse(record)).toEqual(record);
    expect(ConsentsResponse.parse({ consents: [record], currentVersions: versions })).toEqual({
      consents: [record],
      currentVersions: versions,
    });
    expect(
      codes(ConsentsResponse, { consents: Array(101).fill(record), currentVersions: versions }),
    ).toEqual(["too_big"]);
    const { special_category: _, ...withoutSpecial } = versions;
    expect(codes(ConsentsResponse, { consents: [], currentVersions: withoutSpecial })).toEqual([
      "invalid_type",
    ]);
  });
});

describe("the onboarding steps", () => {
  it("activate on the four answers and the two consents, never research", () => {
    expect([...ACTIVATION_STEPS].sort()).toEqual(
      ["age_window", "gender", "home", "privacy", "seeks", "terms"].sort(),
    );
    for (const step of ACTIVATION_STEPS) expect(ONBOARDING_STEPS).toContain(step);
    expect(ONBOARDING_STEPS).not.toContain("research");
  });

  it("ask the home after the age window, where the pond was (ADR-061 §1)", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "terms",
      "privacy",
      "name",
      "gender",
      "seeks",
      "intent",
      "age_window",
      "home",
      "photos",
      "prompts_or_bio",
    ]);
    expect(ONBOARDING_STEPS).not.toContain("pond");
  });

  const status = {
    state: "registered",
    age: 18,
    gender: null,
    pond: null,
    home: null,
    preferences: { seeks: null, ageWindow: null },
    consents: { terms: null, privacy: null, specialCategory: null, research: null },
    currentVersions: { terms: "1", privacy: "1", research: "1", special_category: "1" },
    nextChange: { gender: null },
    missing: [...ONBOARDING_STEPS],
    complete: false,
  };

  it("say what is missing in the order the app asks", () => {
    expect(OnboardingStatus.parse(status).missing).toEqual([...ONBOARDING_STEPS]);
  });

  it("carry the home in names, or null, and must say which", () => {
    const home = { town: { fi: "Turku", sv: "Åbo" }, area: null, showArea: false };
    expect(OnboardingStatus.parse({ ...status, home }).home).toEqual(home);
    expect(OnboardingStatus.parse(status).home).toBeNull();
    expect(codes(OnboardingStatus, { ...status, home: undefined })).toEqual(["invalid_type"]);
  });

  it.each([
    [17, false],
    [18, true],
    [130, true],
    [131, false],
  ])("take an age of %i: %s", (age, ok) => {
    expect(OnboardingStatus.safeParse({ ...status, age }).success).toBe(ok);
  });

  it("refuse more steps than there are and a step outside the list", () => {
    expect(codes(OnboardingStatus, { ...status, missing: [...ONBOARDING_STEPS, "terms"] })).toEqual(
      ["too_big"],
    );
    expect(codes(OnboardingStatus, { ...status, missing: ["research"] })).toEqual([
      "invalid_value",
    ]);
  });

  it("carry the research opt-in with its version and time", () => {
    const enrolled = {
      ...status,
      consents: { ...status.consents, research: { version: "1", givenAt: at } },
    };
    expect(OnboardingStatus.parse(enrolled).consents.research).toEqual({
      version: "1",
      givenAt: at,
    });
  });
});
