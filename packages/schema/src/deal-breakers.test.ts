import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  DEAL_BREAKERS_CAP,
  DealBreaker,
  DealBreakerField,
  DealBreakersResponse,
  DealBreakersUpdate,
  dealBreakerOptions,
  StoredDealBreaker,
} from "./deal-breakers.ts";
import { DISTANCE_FILTER_BANDS } from "./distance.ts";
import { DEAL_BREAKER_FIELDS, PROFILE_FIELD_KEYS, PROFILE_FIELDS } from "./profile-fields.ts";

// Deal-breakers (#149): a whitelisted field or the distance (ADR-061 §7), a
// bounded list of accepted answers, at most the contract's cap: one per field
// of the whitelist (#508) and the distance.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

const smoking = { field: "smoking", accept: ["never"], includeUnknown: false };

describe("a deal-breaker's field", () => {
  it("is exactly the registry's whitelist and the distance, last", () => {
    expect(DealBreakerField.options).toEqual([...DEAL_BREAKER_FIELDS, "distance"]);
  });

  it("is no field of the registry for the distance, nor for a home", () => {
    expect(Object.keys(PROFILE_FIELDS)).not.toContain("distance");
    expect(Object.keys(PROFILE_FIELDS)).not.toContain("home");
  });

  it("is refused on every field the registry does not whitelist, special categories included", () => {
    const others = PROFILE_FIELD_KEYS.filter((key) => !DEAL_BREAKER_FIELDS.includes(key));
    expect(others).toContain("religion");
    expect(others).toContain("politics");
    for (const field of others) {
      expect(PROFILE_FIELDS[field].preferenceAbout, field).not.toBe("deal_breaker");
      expect(codes(DealBreakerField, field), field).toEqual(["invalid_value"]);
    }
  });
});

describe("what a deal-breaker may accept", () => {
  it("is a list's options, never its other, which names no answer two people share (#616)", () => {
    expect(dealBreakerOptions("smoking")).toEqual(PROFILE_FIELDS.smoking.options);
    expect(PROFILE_FIELDS.languages.options).toContain("other");
    expect(dealBreakerOptions("languages")).toEqual(
      PROFILE_FIELDS.languages.options.filter((option) => option !== "other"),
    );
    // Finland's own languages are there to accept, as any other language (#616).
    expect(dealBreakerOptions("languages")).toEqual(
      expect.arrayContaining(["fse", "fss", "smn", "sms", "krl", "rmf"]),
    );
  });

  it("is a number's relations to the holder's own answer (#508)", () => {
    expect(dealBreakerOptions("height")).toEqual(["taller", "at_least_mine", "shorter"]);
  });

  it("is a band up to around on the distance, never far, which filters nobody", () => {
    expect(dealBreakerOptions("distance")).toEqual(["nearby", "close", "around"]);
    expect(dealBreakerOptions("distance")).toEqual(DISTANCE_FILTER_BANDS);
  });

  it("is something on every field of the whitelist and the distance, and nothing on a free text or a setting", () => {
    for (const field of DealBreakerField.options) {
      expect(dealBreakerOptions(field).length, field).toBeGreaterThan(0);
    }
    expect(dealBreakerOptions("occupationTitle")).toEqual([]);
    expect(dealBreakerOptions("hideFromField")).toEqual([]);
  });
});

describe("a deal-breaker", () => {
  it("names a field, the accepted answers and whether the unanswered pass", () => {
    expect(DealBreaker.parse(smoking)).toEqual(smoking);
    expect(DealBreaker.parse({ ...smoking, includeUnknown: true }).includeUnknown).toBe(true);
  });

  it("takes the distance, with the bands it accepts and the unanswered stored as passing", () => {
    const distance = { field: "distance", accept: ["nearby", "close"], includeUnknown: true };
    expect(DealBreaker.parse(distance)).toEqual(distance);
  });

  it("takes sixty accepted answers of forty characters and no more", () => {
    const sixty = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(40, "x"));
    expect(DealBreaker.safeParse({ ...smoking, accept: sixty }).success).toBe(true);
    expect(codes(DealBreaker, { ...smoking, accept: [...sixty, "one"] })).toEqual(["too_big"]);
    expect(codes(DealBreaker, { ...smoking, accept: ["x".repeat(41)] })).toEqual(["too_big"]);
  });

  it.each([
    ["no accepted answer", { accept: [] }, "too_small"],
    ["an empty answer", { accept: [""] }, "too_small"],
    ["an answer that is not a string", { accept: [3] }, "invalid_type"],
    ["includeUnknown as a string", { includeUnknown: "yes" }, "invalid_type"],
    ["includeUnknown left out", { includeUnknown: undefined }, "invalid_type"],
    ["a field outside the whitelist", { field: "zodiac" }, "invalid_value"],
    ["an extra key", { paused: true }, "unrecognized_keys"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(DealBreaker, { ...smoking, ...change })).toEqual([code]);
  });
});

describe("the deal-breakers update", () => {
  it("takes none, and up to one per field of the whitelist and the distance", () => {
    expect(DEAL_BREAKERS_CAP).toBe(DEAL_BREAKER_FIELDS.length + 1);
    expect(DealBreakersUpdate.parse({ dealBreakers: [] })).toEqual({ dealBreakers: [] });
    const all = Array(DEAL_BREAKERS_CAP).fill(smoking);
    expect(DealBreakersUpdate.parse({ dealBreakers: all }).dealBreakers).toHaveLength(7);
  });

  it("refuses one more, a missing list and an extra key", () => {
    expect(
      codes(DealBreakersUpdate, { dealBreakers: Array(DEAL_BREAKERS_CAP + 1).fill(smoking) }),
    ).toEqual(["too_big"]);
    expect(codes(DealBreakersUpdate, {})).toEqual(["invalid_type"]);
    expect(codes(DealBreakersUpdate, { dealBreakers: [], max: 2 })).toEqual(["unrecognized_keys"]);
  });
});

describe("the stored deal-breakers", () => {
  it("say of each whether it waits for the person's own answer", () => {
    expect(StoredDealBreaker.parse({ ...smoking, paused: true }).paused).toBe(true);
    expect(codes(StoredDealBreaker, smoking)).toEqual(["invalid_type"]);
  });

  it.each([
    [0, true],
    [2, true],
    [7, true],
    [8, false],
    [-1, false],
    [1.5, false],
  ])("say how many a person may have: %d is %s", (max, ok) => {
    expect(DealBreakersResponse.safeParse({ dealBreakers: [], max }).success).toBe(ok);
  });

  it("hold at most the cap", () => {
    const stored = { ...smoking, paused: false };
    expect(
      DealBreakersResponse.safeParse({
        dealBreakers: Array(DEAL_BREAKERS_CAP + 1).fill(stored),
        max: DEAL_BREAKERS_CAP,
      }).success,
    ).toBe(false);
  });
});
