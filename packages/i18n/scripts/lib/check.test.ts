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

// Stadin slangi (#521): never required, and never where a joke could hurt.
describe("a slangi text", () => {
  const slang = (fields: Partial<Messages[string]> = {}): Messages[string] =>
    ok({ slangi: "Tallentsaa", machine: { fi: true, sv: true, slangi: true }, ...fields });
  const REFUSED = "slangi stands only where a joke is harmless (isSlangKey)";

  it("is never missing, by an error or a warning", () => {
    expect(checkMessages({ "round.title": ok() }, { release: false })).toEqual({
      errors: [],
      warnings: [],
    });
    expect(checkMessages({ "round.title": ok() }, { release: true }).warnings).toEqual([]);
  });

  it.each([
    ["round.title"],
    ["round.match.title"],
    ["round.empty"],
    ["home.title"],
    ["profile.section.work"],
    ["settings.title"],
  ])("stands on %s", (key) => {
    expect(errorsOf({ [key]: slang() })).toEqual([]);
  });

  it.each([
    // Outside the four namespaces.
    ["legal.terms.title"],
    ["legal.research.summary"],
    ["errors.rate_limited"],
    ["safety.block.title"],
    ["notices.suspended"],
    ["account.delete.title"],
    ["account.break.title"],
    ["onboarding.consents.explain"],
    ["signIn.title"],
    ["push.round"],
    ["mail.code.subject"],
    ["support.mieli.name"],
    ["admin.title"],
    ["nothing.of.ours"],
    // A namespace is the whole first word.
    ["homework.title"],
    ["safety.home.title"],
    // Inside them: a failure.
    ["round.failed"],
    ["round.decision.failed"],
    ["home.gate.failed"],
    ["profile.error.save"],
    ["settings.invite.loadFailed"],
    ["settings.contacts.invalid"],
    ["settings.contacts.phoneInvalid"],
    // Consent and a person's data.
    ["settings.research.title"],
    ["settings.sensitive.title"],
    ["settings.export.label"],
    // The way out of danger or of a session.
    ["settings.support.label"],
    ["round.report.open"],
    ["round.block.open"],
    ["settings.lock.label"],
    ["settings.session.label"],
    ["settings.logoutAll.confirm.title"],
    // An answer that says who somebody is.
    ["profile.option.gender.woman"],
  ])("is refused on %s", (key) => {
    expect(errorsOf({ [key]: slang() })).toEqual([`${key}: ${REFUSED}`]);
  });

  it("is held to the arguments, the tags, the room and the characters of any text", () => {
    expect(errorsOf({ "round.title": slang({ slangi: "Moi {name}" }) })).toEqual([
      "round.title: slangi does not use the same arguments as en",
    ]);
    expect(
      errorsOf({
        "round.title": slang({ en: "<b>Save</b>", fi: "<b>Tallenna</b>", sv: "<b>Spara</b>" }),
      }),
    ).toEqual(["round.title: slangi does not keep the tags of en"]);
    expect(errorsOf({ "round.title": slang({ slangi: "{" }) })).toEqual([
      expect.stringMatching(/^round\.title: slangi is not valid ICU \(/),
    ]);
    expect(errorsOf({ "round.title": slang({ slangi: "Tallentsaa", max_length: 8 }) })).toEqual([
      "round.title: slangi is over its max_length of 8",
    ]);
    expect(errorsOf({ "round.title": slang({ slangi: "Sae‮" }) })).toEqual([
      "round.title: slangi contains control, bidirectional or line-separator characters",
    ]);
  });

  it("takes Finnish's plural forms, which Intl knows it by", () => {
    const en = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    const fi = "{n, selectordinal, other {#.}}";
    expect(
      errorsOf({
        "round.title": slang({
          en,
          fi,
          sv: "{n, selectordinal, one {#:a} other {#:e}}",
          slangi: fi,
        }),
      }),
    ).toEqual([]);
  });

  it("carries a machine flag like any text nobody native has read", () => {
    expect(errorsOf({ "round.title": slang({ machine: { fi: true, sv: true } }) })).toEqual([
      expect.stringContaining("round.title: slangi carries neither machine: nor reviewed:"),
    ]);
  });

  it("keeps a release going as machine text, since no release speaks it", () => {
    const released = ok({
      slangi: "Tallentsaa",
      machine: { sv: true, slangi: true },
      reviewed: { fi: reviewHash("Save", "Tallenna") },
    });
    expect(errorsOf({ "round.title": released }, true)).toEqual([]);
  });
});

describe("messages.yaml's schema", () => {
  it.each([
    ["fi", true],
    ["sv", true],
    ["en", false],
    // So neither the translator nor the review sheet takes it.
    ["slangi", false],
    ["FI", false],
    ["", false],
    [undefined, false],
  ])("takes %o as a translated locale: %s", (value, expected) => {
    expect(isTranslatedLocale(value)).toBe(expected);
  });

  it("refuses a machine flag or a review hash on slangi with no slangi text", () => {
    expect(() =>
      parseMessages("demo.save:\n  en: Save\n  description: d\n  machine: { slangi: true }\n"),
    ).toThrow(/demo\.save: machine\.slangi is set but there is no slangi text/);
    const hash = reviewHash("Save", "Sae");
    expect(() =>
      parseMessages(
        `demo.save:\n  en: Save\n  description: d\n  reviewed: { slangi: "${hash}" }\n`,
      ),
    ).toThrow(/demo\.save: reviewed\.slangi is set but there is no slangi text/);
  });

  it("refuses an empty slangi text", () => {
    expect(() => parseMessages('demo.save:\n  en: Save\n  description: d\n  slangi: ""\n')).toThrow(
      /demo\.save\.slangi/,
    );
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
