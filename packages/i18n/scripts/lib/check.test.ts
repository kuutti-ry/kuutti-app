import { describe, expect, it } from "vitest";
import { checkMessages, isDraftLegal, stale, unreviewed } from "./check.ts";
import { reviewHash } from "./review-hash.ts";
import { isTranslatedLocale, type Messages, parseMessages } from "./schema.ts";

// The rules of i18n:check and messages.yaml's own schema (#13, #55), where the
// existing suite does not reach: the English itself broken, the release gate
// of legal text without a version, and the review lists.

const ok = (fields: Partial<Messages[string]> = {}): Messages[string] => ({
  en: "Save",
  description: "A button.",
  fi: "Tallenna",
  sv: "Spara",
  machine: { fi: true, sv: true },
  ...fields,
});

const errorsOf = (messages: Messages, release = false) =>
  checkMessages(messages, { release }).errors;

describe("the English source", () => {
  it("is refused when it is not ICU, and nothing else of the key is checked", () => {
    expect(errorsOf({ "demo.broken": ok({ en: "Hello {name", fi: "{" }) })).toEqual([
      expect.stringMatching(/^demo\.broken: en is not valid ICU \(/),
    ]);
  });

  it("is refused with an invisible or direction-changing character", () => {
    expect(errorsOf({ "demo.rtl": ok({ en: "Save\u202e", fi: "Tallenna" }) })).toEqual(
      expect.arrayContaining([
        "demo.rtl: en contains control, bidirectional or line-separator characters",
      ]),
    );
  });

  it("is held to its own max_length, counted in characters a reader sees", () => {
    expect(errorsOf({ "demo.save": ok({ max_length: 3 }) })).toEqual(
      expect.arrayContaining(["demo.save: en is over its max_length of 3"]),
    );
    // Four letters and an emoji of several code points: five characters.
    expect(
      errorsOf({ "demo.save": ok({ en: "Save👍🏽", fi: "Tall", sv: "Spar", max_length: 5 }) }),
    ).toEqual([]);
  });

  it("passes a plain key with every translation flagged", () => {
    expect(errorsOf({ "demo.save": ok() })).toEqual([]);
  });
});

describe("legal text at a release", () => {
  it("is judged by its wording when it carries no version", () => {
    const final: Messages = {
      "legal.terms.title": { en: "Terms", description: "d", fi: "Ehdot", sv: "Villkor" },
    };
    expect(isDraftLegal(final["legal.terms.title"] as Messages[string])).toBe(false);
    expect(errorsOf(final, true)).toEqual([]);
    const draft: Messages = {
      "legal.terms.title": { en: "Terms (DRAFT)", description: "d", fi: "Ehdot", sv: "Villkor" },
    };
    expect(errorsOf(draft, true)).toEqual([
      expect.stringMatching(/^legal\.terms\.title: legal text is still a draft/),
    ]);
  });

  it.each([
    ["the version", { consent_version: "2026-draft-2" }, true],
    ["the Swedish", { sv: "Villkor (utkast)" }, true],
    ["the Finnish", { fi: "Ehdot luonnos" }, true],
    ["a word that only contains the marker", { en: "Overdrafted terms" }, false],
    ["nothing", {}, false],
  ])("is a draft when %s says so: %s", (_, fields, draft) => {
    const message = {
      en: "Terms",
      description: "d",
      fi: "Ehdot",
      sv: "Villkor",
      consent_version: "1",
      ...fields,
    };
    expect(isDraftLegal(message)).toBe(draft);
  });
});

describe("the review lists", () => {
  const messages: Messages = {
    "demo.machine": ok(),
    "demo.current": ok({ machine: { sv: true }, reviewed: { fi: reviewHash("Save", "Tallenna") } }),
    "demo.moved": ok({ machine: { sv: true }, reviewed: { fi: reviewHash("Save!", "Tallenna") } }),
    "demo.untouched": {
      en: "Hi",
      description: "d",
      fi: "Hei",
      reviewed: { fi: reviewHash("Hi", "Hei") },
    },
  };

  it("name the machine text per locale", () => {
    expect(unreviewed(messages, "fi")).toEqual(["demo.machine"]);
    expect(unreviewed(messages, "sv")).toEqual(["demo.machine", "demo.current", "demo.moved"]);
  });

  it("name the reviews that no longer match their English or text", () => {
    expect(stale(messages, "fi")).toEqual(["demo.moved"]);
    expect(stale(messages, "sv")).toEqual([]);
  });
});

describe("messages.yaml's schema", () => {
  it.each([
    ["fi", true],
    ["sv", true],
    ["en", false],
    ["FI", false],
    ["", false],
    [undefined, false],
  ])("takes %o as a translated locale: %s", (value, expected) => {
    expect(isTranslatedLocale(value)).toBe(expected);
  });

  it("refuses a consent_version outside legal.*", () => {
    expect(() =>
      parseMessages('demo.save:\n  en: Save\n  description: d\n  consent_version: "1"\n'),
    ).toThrow(/demo\.save: consent_version belongs to legal\.\* keys only/);
  });

  it("refuses a review hash on legal text: its Finnish is the source, not a translation", () => {
    const hash = reviewHash("Terms", "Ehdot");
    expect(() =>
      parseMessages(
        `legal.terms.title:\n  en: Terms\n  description: d\n  fi: Ehdot\n  consent_version: "1"\n  reviewed: { fi: "${hash}" }\n`,
      ),
    ).toThrow(/legal text takes no review hash/);
  });

  it("refuses a file that is not a mapping of messages, with every problem at once", () => {
    expect(() => parseMessages("- a list\n- of things\n")).toThrow(/messages\.yaml is not valid/);
    expect(() =>
      parseMessages(
        "Save button:\n  en: Save\n  description: d\nother:\n  en: x\n  description: d\n",
      ),
    ).toThrow(/Save button: keys are dotted[\s\S]*other: keys are dotted/);
  });

  it("refuses an empty file, and reads an empty mapping as no messages", () => {
    expect(() => parseMessages("")).toThrow(/not valid/);
    expect(parseMessages("{}")).toEqual({});
  });
});
