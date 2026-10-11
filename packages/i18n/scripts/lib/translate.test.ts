import { describe, expect, it } from "vitest";
import { checkMessages } from "./check.ts";
import { reviewHash } from "./review-hash.ts";
import { parseMessages } from "./schema.ts";
import {
  applyTranslations,
  missingTranslations,
  planChunks,
  rejectionReason,
  reviewedExamples,
  selectForTranslation,
  type TranslationItem,
  type Translator,
  untrustedTextProblem,
} from "./translate.ts";

const SOURCE = `# A comment that must survive.
demo.greeting:
  en: Hello
  description: Greeting on the first screen.
  sv: Hej
  machine: { sv: true }

demo.count:
  en: "{likes, plural, one {# like} other {# likes}}"
  description: Number of likes.

demo.where:
  en: "Your pond: {pond}"
  description: Shows the member's pond.

admin.title:
  en: Admin
  description: English only.

legal.privacy:
  en: Privacy policy
  description: Binding legal text.
  consent_version: "1"
`;

// Deterministic stand-in for the provider: no network in tests (CLAUDE.md Testing).
const fake: Translator = async (_locale, items) =>
  Object.fromEntries(
    items.map((item) => [
      item.key,
      {
        "demo.greeting": "Hei",
        "demo.count": "{likes, plural, one {# tykkäys} other {# tykkäystä}}",
        "demo.where": "Lampesi: {pond}ssa",
      }[item.key] ?? "",
    ]),
  );

describe("i18n:translate", () => {
  it("asks only for keys without text, and never for admin or legal keys", () => {
    const messages = parseMessages(SOURCE);
    expect(missingTranslations(messages, "fi").map((i) => i.key)).toEqual([
      "demo.greeting",
      "demo.count",
      "demo.where",
    ]);
    expect(missingTranslations(messages, "sv").map((i) => i.key)).toEqual([
      "demo.count",
      "demo.where",
    ]);
  });

  it("writes a Finnish value flagged machine: true, and keeps the rest of the file as it was", async () => {
    const messages = parseMessages(SOURCE);
    const items = missingTranslations(messages, "fi");
    const result = applyTranslations(
      SOURCE,
      messages,
      "fi",
      await fake("fi", items, { glossary: "", tone: "" }),
    );

    expect(result.written).toEqual(["demo.greeting", "demo.count"]);
    const after = parseMessages(result.yaml);
    expect(after["demo.greeting"]).toMatchObject({ fi: "Hei", sv: "Hej", machine: { fi: true } });
    expect(after["demo.count"]?.fi).toBe("{likes, plural, one {# tykkäys} other {# tykkäystä}}");
    expect(result.yaml.startsWith("# A comment that must survive.")).toBe(true);
    expect(after["legal.privacy"]?.fi).toBeUndefined();
    expect(after["admin.title"]?.fi).toBeUndefined();
  });

  it("refuses a translation that inflects a dynamic value, and says why", async () => {
    const messages = parseMessages(SOURCE);
    const items = missingTranslations(messages, "fi");
    const result = applyTranslations(
      SOURCE,
      messages,
      "fi",
      await fake("fi", items, { glossary: "", tone: "" }),
    );
    expect(result.rejected["demo.where"]).toMatch(/suffix glued/);
    expect(parseMessages(result.yaml)["demo.where"]?.fi).toBeUndefined();
  });

  it("refuses a translation that changes the ICU arguments", () => {
    const messages = parseMessages(SOURCE);
    const result = applyTranslations(SOURCE, messages, "fi", {
      "demo.greeting": "Hei",
      "demo.count": "{määrä} tykkäystä",
      "demo.where": "Lampesi: {pond}",
    });
    expect(result.rejected).toEqual({
      "demo.count": "does not keep the ICU arguments of the English source",
    });
  });

  it("refuses machine output with invisible characters, or a link or markup the source lacks", () => {
    const messages = parseMessages(SOURCE);
    const result = applyTranslations(SOURCE, messages, "fi", {
      "demo.greeting": "Hei\u202E",
      "demo.count": "{likes, plural, one {# tykkäys} other {# tykkäystä}} https://example.com",
      "demo.where": "<b>Lampesi</b>: {pond}",
    });
    expect(result.written).toEqual([]);
    expect(Object.values(result.rejected)).toEqual([
      "contains control, bidirectional or line-separator characters",
      "contains a link the English source does not have",
      "contains markup the English source does not have",
    ]);
  });

  it("leaves a file whose machine-translated Finnish blocks a release until a reviewer clears it", async () => {
    const messages = parseMessages(SOURCE);
    const result = applyTranslations(SOURCE, messages, "fi", {
      "demo.greeting": "Hei",
      "demo.count": "{likes, plural, one {# tykkäys} other {# tykkäystä}}",
      "demo.where": "Lampesi: {pond}",
    });
    const after = parseMessages(result.yaml);
    // The one thing left is the legal text: the script never fills it, a person must.
    expect(checkMessages(after, { release: false }).errors).toEqual([
      "legal.privacy: no fi text (Finnish is required)",
    ]);
    const release = checkMessages(after, { release: true }).errors;
    expect(release.filter((e) => e.includes("still machine-translated"))).toHaveLength(3);
  });
});

describe("untrusted text (#55)", () => {
  it("refuses contact details, line separators and tags the English does not have", () => {
    const cases: [string, string, string][] = [
      ["Contact us", "Ota yhteyttä: kuutti-tuki.fi", "a web or e-mail address"],
      ["Hello", "Hei tuki@evil.fi", "a web or e-mail address"],
      ["Call us", "Soita +358 40 1234567", "a phone number"],
      ["Hello", "Hei maailma", "line-separator characters"],
      ["<b>Hello</b>", "<a>Hei</a>", "does not keep the tags"],
    ];
    for (const [en, text, reason] of cases) {
      expect(rejectionReason(en, text, "fi"), text).toContain(reason);
    }
    // What the English has, the translation may keep; a time or a count is no phone number.
    expect(
      rejectionReason("Write to hello@kuutti.app", "Kirjoita: hello@kuutti.app", "fi"),
    ).toBeUndefined();
    expect(rejectionReason("<b>Hello</b>", "<b>Hei</b>", "fi")).toBeUndefined();
    expect(rejectionReason("Opens at 12.30", "Aukeaa klo 12.30", "fi")).toBeUndefined();
  });
});

describe("what a translation run covers (#55)", () => {
  const FILE = `demo.hello:
  en: Hello
  description: d
  fi: Hei
  machine: { fi: true }

demo.bye:
  en: Goodbye for now
  description: d
  fi: Näkemiin
  reviewed: { fi: "${reviewHash("Goodbye", "Näkemiin")}" }

demo.thanks:
  en: Thanks
  description: d
  fi: Kiitos
  reviewed: { fi: "${reviewHash("Thanks", "Kiitos")}" }

demo.save:
  en: Save
  description: a button
  max_length: 12

other.title:
  en: Title
  description: d
  fi: Otsikko
  machine: { fi: true }

legal.terms.title:
  en: Terms
  description: d
  fi: Käyttöehdot
  consent_version: "1"
`;
  const messages = parseMessages(FILE);
  const keys = (items: TranslationItem[]): string[] => items.map((item) => item.key);

  it("selects missing text, machine text to write again, or reviews gone stale, never legal text", () => {
    expect(keys(selectForTranslation(messages, "fi", { mode: "missing" }))).toEqual(["demo.save"]);
    expect(keys(selectForTranslation(messages, "fi", { mode: "retranslate" }))).toEqual([
      "demo.hello",
      "other.title",
    ]);
    // demo.bye's English changed after its review; demo.thanks is still current.
    expect(keys(selectForTranslation(messages, "fi", { mode: "stale" }))).toEqual(["demo.bye"]);
    expect(
      keys(selectForTranslation(messages, "fi", { mode: "retranslate", prefix: "other." })),
    ).toEqual(["other.title"]);
    expect(
      keys(selectForTranslation(messages, "fi", { mode: "retranslate", keys: ["demo.hello"] })),
    ).toEqual(["demo.hello"]);
    // The room a text has goes to the translator with it.
    expect(selectForTranslation(messages, "fi", { mode: "missing" })[0]?.max_length).toBe(12);
  });

  it("sends only current reviews as examples, from the same namespace", () => {
    expect(reviewedExamples(messages, "fi", "demo")).toEqual([{ en: "Thanks", text: "Kiitos" }]);
    expect(reviewedExamples(messages, "fi", "other")).toEqual([]);
  });

  it("splits a selection per namespace into evenly sized requests", () => {
    const items = (prefix: string, n: number): TranslationItem[] =>
      Array.from({ length: n }, (_, i) => ({ key: `${prefix}.k${i}`, en: "x", description: "d" }));
    const plan = planChunks([...items("profile", 90), ...items("smoke", 3)], 40);
    expect(plan.map((chunk) => [chunk.namespace, chunk.items.length])).toEqual([
      ["profile", 30],
      ["profile", 30],
      ["profile", 30],
      ["smoke", 3],
    ]);
  });

  it("writes a stale text again as machine text, dropping its old review", () => {
    const items = selectForTranslation(messages, "fi", { mode: "stale" });
    const result = applyTranslations(FILE, messages, "fi", { "demo.bye": "Näkemiin nyt" }, items);
    expect(result.written).toEqual(["demo.bye"]);
    const after = parseMessages(result.yaml)["demo.bye"];
    expect(after).toMatchObject({ fi: "Näkemiin nyt", machine: { fi: true } });
    expect(after?.reviewed).toBeUndefined();
  });

  it("refuses an answer over its max_length before it is written", () => {
    const items = selectForTranslation(messages, "fi", { mode: "missing" });
    const result = applyTranslations(
      FILE,
      messages,
      "fi",
      { "demo.save": "Tallenna muutokset" },
      items,
    );
    expect(result.rejected).toEqual({ "demo.save": "is over its max_length of 12" });
    expect(result.written).toEqual([]);
  });

  it("ignores an answer for a key the run did not select", () => {
    const items = selectForTranslation(messages, "fi", { mode: "missing" });
    const result = applyTranslations(
      FILE,
      messages,
      "fi",
      { "demo.thanks": "Kiitti", "demo.save": "Tallenna" },
      items,
    );
    expect(result.written).toEqual(["demo.save"]);
    expect(parseMessages(result.yaml)["demo.thanks"]?.fi).toBe("Kiitos");
  });
});

describe("what the review of #74 tightened", () => {
  it("sees contact details written in look-alike characters, any script of digit, any script of domain", () => {
    const en = "Call the support line.";
    // Full-width digits: NFKC makes them ordinary ones.
    expect(untrustedTextProblem(en, "Soita ０４０ １２３ ４５６７")).toMatch(/phone number/);
    // Arabic-Indic digits are digits too.
    expect(untrustedTextProblem(en, "Soita ٠٤٠١٢٣٤٥٦٧")).toMatch(/phone number/);
    // An internationalised top-level domain.
    expect(untrustedTextProblem(en, "Katso evil.рф")).toMatch(/web or e-mail address/);
    expect(untrustedTextProblem(en, "Katso ｅｖｉｌ．ｃｏｍ")).toMatch(/web or e-mail address/);
    // What the English has, the translation may keep.
    expect(untrustedTextProblem("See kuutti.app", "Katso kuutti.app")).toBeUndefined();
    expect(untrustedTextProblem(en, "Soita tukeen.")).toBeUndefined();
  });

  it("refuses a text that was not read as UTF-8, and the start of a spreadsheet formula", () => {
    expect(untrustedTextProblem("Goodbye", "N\uFFFDkemiin")).toMatch(/not read as UTF-8/);
    expect(untrustedTextProblem("Total", "=cmd|'/c calc'!A0")).toMatch(/formula/);
    expect(untrustedTextProblem("=1+1 is two", "=1+1 on kaksi")).toBeUndefined();
  });

  it("holds a text to its room wherever it is judged", () => {
    expect(rejectionReason("OK", "Selvä", "fi", 5)).toBeUndefined();
    expect(rejectionReason("OK", "Selvä juttu", "fi", 5)).toBe("is over its max_length of 5");
    expect(rejectionReason("OK", "Selvä juttu", "fi")).toBeUndefined();
  });
});

describe("what the translation may not swap", () => {
  it("keeps the English's own link, address and number, and takes no other", () => {
    const en = "Write to hello@kuutti.app, see https://kuutti.app/help or call +358 40 123 4567.";
    const kept =
      "Kirjoita osoitteeseen hello@kuutti.app, katso https://kuutti.app/help tai soita +358 40 123 4567.";
    expect(untrustedTextProblem(en, kept)).toBeUndefined();
    expect(untrustedTextProblem(en, kept.replace("hello@kuutti.app", "scam@evil.fi"))).toMatch(
      /web or e-mail address/,
    );
    expect(
      untrustedTextProblem(en, kept.replace("https://kuutti.app/help", "https://evil.example/x")),
    ).toMatch(/link/);
    expect(untrustedTextProblem(en, kept.replace("123 4567", "765 4321"))).toMatch(/phone number/);
    // Another spelling of the same number is the same number.
    expect(untrustedTextProblem(en, kept.replace("+358 40 123 4567", "+358-40-123-4567"))).toBe(
      undefined,
    );
  });
});

describe("an answer that cannot be written", () => {
  it.each(["", "   ", "\t"])("is refused when it is empty: %o", (text) => {
    expect(rejectionReason("Hello", text, "fi")).toBe("empty");
  });

  it("is refused when it is not ICU, with the parser's reason", () => {
    expect(rejectionReason("{n, number} likes", "{n, number tykkäystä", "fi")).toMatch(
      /^not valid ICU \(/,
    );
  });

  it("is refused when it drops a tag of the English", () => {
    expect(rejectionReason("<b>New</b> match", "Uusi pari", "fi")).toBe(
      "does not keep the tags of the English source",
    );
  });

  it("is refused when it keeps a name but changes its type", () => {
    expect(rejectionReason("{n, number} likes", "{n} tykkäystä", "fi")).toBe(
      "does not keep the ICU arguments of the English source",
    );
  });

  it("is written when nothing is wrong", () => {
    expect(rejectionReason("{n, number} likes", "{n, number} tykkäystä", "fi")).toBeUndefined();
  });
});

describe("writing a run's answers", () => {
  const messages = parseMessages(SOURCE);

  it("reports a key the translator left unanswered and writes the rest", () => {
    const result = applyTranslations(SOURCE, messages, "fi", { "demo.greeting": "Hei" });
    expect(result.written).toEqual(["demo.greeting"]);
    expect(result.rejected).toEqual({
      "demo.count": "the translator returned nothing for this key",
      "demo.where": "the translator returned nothing for this key",
    });
  });

  it("writes nothing for an item the file has no entry for", () => {
    const ghost: TranslationItem = { key: "demo.ghost", en: "Ghost", description: "d" };
    const result = applyTranslations(SOURCE, messages, "fi", { "demo.ghost": "Haamu" }, [ghost]);
    expect(result).toEqual({ yaml: SOURCE, written: [], rejected: {} });
  });

  it("quotes a text with ICU braces, a colon or a hash, and leaves a plain one plain", () => {
    const result = applyTranslations(SOURCE, messages, "fi", {
      "demo.greeting": "  Hei  ",
      "demo.count": "{likes, plural, one {# tykkäys} other {# tykkäystä}}",
      "demo.where": "Lampesi: {pond}",
    });
    expect(result.yaml).toContain("  fi: Hei\n");
    expect(result.yaml).toContain('  fi: "{likes, plural, one {# tykkäys} other {# tykkäystä}}"\n');
    expect(result.yaml).toContain('  fi: "Lampesi: {pond}"\n');
    // A machine map of the other language gains this one; an entry without one gets a new map.
    expect(parseMessages(result.yaml)["demo.greeting"]?.machine).toEqual({ sv: true, fi: true });
    expect(parseMessages(result.yaml)["demo.count"]?.machine).toEqual({ fi: true });
  });
});

describe("a run's selection", () => {
  const messages = parseMessages(SOURCE);

  it("narrows to named keys and to a prefix, both at once", () => {
    expect(
      selectForTranslation(messages, "fi", {
        mode: "missing",
        keys: ["demo.count", "demo.where", "admin.title"],
        prefix: "demo.c",
      }).map((item) => item.key),
    ).toEqual(["demo.count"]);
  });

  it("keeps a message's room on its item, and only when it has one", () => {
    const sized = parseMessages(
      `${SOURCE}demo.ok:\n  en: OK\n  description: d.\n  max_length: 4\n`,
    );
    const items = missingTranslations(sized, "fi");
    expect(items.find((item) => item.key === "demo.ok")).toEqual({
      key: "demo.ok",
      en: "OK",
      description: "d.",
      max_length: 4,
    });
    expect(items.find((item) => item.key === "demo.where")).not.toHaveProperty("max_length");
  });

  it("splits one namespace into parts of at most the size, and a size of one into single keys", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      key: `demo.k${i}`,
      en: "x",
      description: "d",
    }));
    expect(planChunks(items, 2).map((chunk) => chunk.items.length)).toEqual([2, 2, 1]);
    expect(planChunks(items, 1)).toHaveLength(5);
    expect(planChunks([], 40)).toEqual([]);
  });

  it("gives at most the asked number of examples", () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `demo.k${i}`,
        {
          en: `E${i}`,
          description: "d",
          fi: `F${i}`,
          reviewed: { fi: reviewHash(`E${i}`, `F${i}`) },
        },
      ]),
    );
    expect(reviewedExamples(many, "fi", "demo")).toHaveLength(20);
    expect(reviewedExamples(many, "fi", "demo", 3)).toEqual([
      { en: "E0", text: "F0" },
      { en: "E1", text: "F1" },
      { en: "E2", text: "F2" },
    ]);
    expect(reviewedExamples(many, "sv", "demo")).toEqual([]);
  });
});
