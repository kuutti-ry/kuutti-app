import { CONSENT_VERSIONS, createI18n } from "@kuutti/i18n";
import {
  HOBBY_GROUP_KEYS,
  PARTY_OPTIONS,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
} from "@kuutti/schema";
import { describe, expect, it } from "vitest";

// The registry of packages/schema names fields, options and hobby groups by
// key; their texts are messages.yaml entries with the same key (ADR-019 §3).
// Here, where both packages are dependencies: a field or an option without a
// text in every catalogue would reach a card as its key.

describe("the texts of the profile registry", () => {
  const i18n = createI18n({ locale: "en" });
  const has = (locale: string, key: string) =>
    i18n.getResource(locale, "translation", key) !== undefined;

  it("exist in English, Finnish and Swedish for every field, option and hobby group", () => {
    const keys = [
      ...PROFILE_FIELD_KEYS.map((field) => `profile.field.${field}`),
      ...PROFILE_FIELD_KEYS.flatMap((field) => {
        const spec = PROFILE_FIELDS[field];
        return spec.kind === "single" || spec.kind === "multi"
          ? spec.options.map((option) => `profile.option.${field}.${option}`)
          : [];
      }),
      ...HOBBY_GROUP_KEYS.map((group) => `profile.hobbyGroup.${group}`),
    ];
    expect(keys.length).toBeGreaterThan(200);
    const missing = ["en", "fi", "sv"].flatMap((locale) =>
      keys.filter((key) => !has(locale, key)).map((key) => `${locale}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  it("bind the special-category answers to a wording with a version of its own", () => {
    expect(CONSENT_VERSIONS.special_category).toMatch(/^\d{4}-\d{2}-/);
    expect(has("en", "legal.special_category.summary")).toBe(true);
    expect(has("fi", "legal.special_category.summary")).toBe(true);
  });

  it("lists the parties in the order of their Finnish names, the two that are no party last", () => {
    // People know the parties by name and logo (#213); the order is the Finnish names' (ADR-019 §3).
    const finnish = (option: string) =>
      String(i18n.getResource("fi", "translation", `profile.option.politics.${option}`));
    const collator = new Intl.Collator("fi");
    expect([...PARTY_OPTIONS]).toEqual(
      [...PARTY_OPTIONS].sort((a, b) => collator.compare(finnish(a), finnish(b))),
    );
    expect(PROFILE_FIELDS.politics.options.slice(PARTY_OPTIONS.length)).toEqual([
      "none_of_them",
      "kahvipuolue",
    ]);
  });
});
