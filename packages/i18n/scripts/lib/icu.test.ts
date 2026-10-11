import { describe, expect, it } from "vitest";
import {
  argumentsOf,
  branchesOf,
  branchProblems,
  inflectionProblems,
  pseudoLocalise,
  tagsOf,
} from "./icu.ts";

// The ICU analysis behind i18n:check, the translator's apply and the review
// (#13, #55): arguments and their types, tags, plural and select branches in
// each of the three languages, inflected values, and the pseudo-locale.

describe("the arguments of a message", () => {
  it.each([
    ["Hello", {}],
    ["Hi {name}", { name: "string" }],
    ["{n, number} likes", { n: "number" }],
    ["On {day, date, short}", { day: "date" }],
    ["At {at, time, short}", { at: "date" }],
    ["{n, plural, one {# like} other {# likes}}", { n: "number" }],
    ["{n, selectordinal, one {#st} other {#th}}", { n: "number" }],
    ["{g, select, woman {She} other {They}}", { g: "string" }],
  ])("types %s by its format", (message, expected) => {
    expect(argumentsOf(message)).toEqual(expected);
  });

  it("finds arguments inside plural, select and tag branches", () => {
    expect(
      argumentsOf(
        "{g, select, woman {<b>{name}</b> has {n, plural, one {# like} other {# likes}}} other {{name}}}",
      ),
    ).toEqual({ g: "string", name: "string", n: "number" });
  });

  it("types a value used plainly and as a number as a number, whichever comes first", () => {
    expect(argumentsOf("{n} or {n, number}")).toEqual({ n: "number" });
    expect(argumentsOf("{n, number} or {n}")).toEqual({ n: "number" });
  });

  it("throws on text that is not ICU", () => {
    expect(() => argumentsOf("{unclosed")).toThrow();
    expect(() => tagsOf("<b>unclosed")).toThrow();
    expect(() => branchesOf("{n, plural, one {x}")).toThrow();
  });
});

describe("the tags of a message", () => {
  it("names every tag, nested ones and ones inside branches", () => {
    expect([...tagsOf("Plain")]).toEqual([]);
    expect([...tagsOf("<b>bold <i>both</i></b>")].sort()).toEqual(["b", "i"]);
    expect([...tagsOf("{n, plural, one {<b>#</b>} other {<link>#</link>}}")].sort()).toEqual([
      "b",
      "link",
    ]);
  });
});

describe("the branches of a message", () => {
  it("tell a plural, a selectordinal and a select apart, with their options", () => {
    const found = branchesOf(
      "{n, plural, =0 {none} one {#} other {#}} {o, selectordinal, other {#.}} {g, select, a {A} other {O}}",
    );
    expect(found.n?.kind).toBe("plural");
    expect([...(found.n?.options ?? [])]).toEqual(["=0", "one", "other"]);
    expect(found.o?.kind).toBe("selectordinal");
    expect(found.g?.kind).toBe("select");
  });

  it("finds a branch nested in another and inside a tag", () => {
    const found = branchesOf("<b>{g, select, a {{n, plural, one {#} other {#}}} other {x}}</b>");
    expect(Object.keys(found).sort()).toEqual(["g", "n"]);
  });
});

const PLURAL = "{n, plural, one {# like} other {# likes}}";

describe("a translation's branches against the English", () => {
  it.each(["en", "fi", "sv"])("passes a plural with one and other in %s", (locale) => {
    expect(branchProblems(PLURAL, "{n, plural, one {# x} other {# y}}", locale)).toEqual([]);
  });

  it.each(["fi", "sv"])("lets =1 answer for one in %s", (locale) => {
    expect(branchProblems(PLURAL, "{n, plural, =1 {yksi} other {# monta}}", locale)).toEqual([]);
  });

  it.each(["en", "fi", "sv"])("names the form %s lacks", (locale) => {
    expect(branchProblems(PLURAL, "{n, plural, other {# x}}", locale)).toEqual([
      `{n} lacks the ${locale} plural forms one`,
    ]);
  });

  it("checks the English against its own plural forms", () => {
    const flat = "{n, plural, other {# likes}}";
    expect(branchProblems(flat, flat, "en")).toEqual(["{n} lacks the en plural forms one"]);
  });

  it("keeps the exact cases of the English", () => {
    const en = "{n, plural, =0 {No likes} one {# like} other {# likes}}";
    expect(branchProblems(en, "{n, plural, one {# x} other {# y}}", "fi")).toEqual([
      "{n} lacks the exact cases =0 of en",
    ]);
    expect(branchProblems(en, "{n, plural, =0 {Ei} one {# x} other {# y}}", "fi")).toEqual([]);
  });

  it("needs the ordinal forms of the translation's own language", () => {
    const en = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    // Finnish has one ordinal form, Swedish two.
    expect(branchProblems(en, "{n, selectordinal, other {#.}}", "fi")).toEqual([]);
    expect(branchProblems(en, "{n, selectordinal, other {#:e}}", "sv")).toEqual([
      "{n} lacks the sv plural forms one",
    ]);
    expect(branchProblems(en, "{n, selectordinal, one {#:a} other {#:e}}", "sv")).toEqual([]);
    expect(branchProblems(en, "{n, selectordinal, other {#th}}", "en")).toEqual([
      "{n} lacks the en plural forms few, one, two",
    ]);
  });

  it("refuses a plural flattened into a plain number", () => {
    expect(branchProblems(PLURAL, "{n, number} tykkäystä", "fi")).toEqual([
      "{n} is a plural in en and is not one here",
    ]);
  });

  it("refuses a plural turned into a select or an ordinal", () => {
    expect(branchProblems(PLURAL, "{n, select, one {x} other {y}}", "fi")).toEqual([
      "{n} is a plural in en and a select here",
    ]);
    expect(branchProblems(PLURAL, "{n, selectordinal, other {#.}}", "fi")).toEqual([
      "{n} is a plural in en and a selectordinal here",
    ]);
  });

  it("refuses a branch the English does not have on an argument it does have", () => {
    expect(branchProblems("{n, number} likes", "{n, plural, one {#} other {#}}", "fi")).toEqual([
      "{n} is a plural here and is not one in en",
    ]);
  });

  it("leaves an argument one side lacks to the argument check", () => {
    expect(branchProblems(PLURAL, "Tykkäyksiä", "fi")).toEqual([]);
    expect(branchProblems("Likes", "{n, plural, one {#} other {#}}", "fi")).toEqual([]);
  });

  const SELECT = "{state, select, open {Open} closed {Closed} other {Waiting}}";

  it("keeps exactly the select options of the English", () => {
    expect(
      branchProblems(SELECT, "{state, select, open {Auki} closed {Kiinni} other {Odottaa}}", "fi"),
    ).toEqual([]);
  });

  it.each([
    [
      "missing one",
      "{state, select, open {Auki} other {Odottaa}}",
      "{state} does not have the select options of en (missing closed)",
    ],
    [
      "with an extra one",
      "{state, select, open {Auki} closed {Kiinni} paused {Tauolla} other {Odottaa}}",
      "{state} does not have the select options of en (extra paused)",
    ],
    [
      "missing one and with an extra one",
      "{state, select, open {Auki} paused {Tauolla} other {Odottaa}}",
      "{state} does not have the select options of en (missing closed; extra paused)",
    ],
  ])("refuses a select %s", (_, text, problem) => {
    expect(branchProblems(SELECT, text, "sv")).toEqual([problem]);
  });

  it("checks a plural nested inside a select", () => {
    const en = "{g, select, woman {{n, plural, one {# like} other {# likes}}} other {x}}";
    expect(
      branchProblems(en, "{g, select, woman {{n, plural, other {#}}} other {x}}", "fi"),
    ).toEqual(["{n} lacks the fi plural forms one"]);
  });
});

describe("an inflected dynamic value", () => {
  it.each(["in", "at", "to", "from", "of", "on", "into", "with", "for", "by", "IN"])(
    "is refused after the English preposition %s",
    (preposition) => {
      expect(inflectionProblems(`Matches ${preposition} {pond}`, "en")).toEqual([
        `"${preposition} {pond}" puts a dynamic value where other languages inflect it`,
      ]);
    },
  );

  it("is found inside a tag and inside a branch", () => {
    expect(inflectionProblems("<b>Live in {pond}</b>", "en")).toHaveLength(1);
    expect(
      inflectionProblems("{n, plural, one {# person in {pond}} other {# people}}", "en"),
    ).toHaveLength(1);
  });

  it.each([
    ["fi", "{pond}ssa"],
    ["fi", "{pond}:ssa"],
    ["sv", "{name}s profil"],
    ["en", "{name}s"],
  ])("is refused in %s with a suffix glued on: %s", (locale, message) => {
    expect(inflectionProblems(message, locale)).toEqual([
      `{${message.slice(1, message.indexOf("}"))}} has a suffix glued to it: a dynamic value is never inflected`,
    ]);
  });

  it.each([
    ["en", "Pond: {pond}"],
    ["en", "{pond}: 3 people"],
    ["en", "in {n, number} days"],
    ["en", "in {n, plural, one {# day} other {# days}}"],
    ["fi", "in {pond}"],
    ["en", "Welcome, {name}"],
    ["en", "{name} - {pond}"],
  ])("passes in %s where nothing is inflected: %s", (locale, message) => {
    expect(inflectionProblems(message, locale)).toEqual([]);
  });

  it("reports both a preposition and a glued suffix on one value", () => {
    expect(inflectionProblems("from {pond}s", "en")).toHaveLength(2);
  });
});

describe("the pseudo-locale", () => {
  it("accents and doubles every vowel, upper and lower case, and brackets the text", () => {
    expect(pseudoLocalise("Yes Anna")).toBe("［ÝÝééš ÁÁññáá］");
  });

  it("leaves arguments, tags and branch names alone and changes the text inside them", () => {
    expect(pseudoLocalise("<b>Hi</b> {name}")).toBe("［<b>Híí</b> {name}］");
    expect(pseudoLocalise("{g, select, a {Yo} other {No}}")).toBe(
      "［{g,select,a{ÝÝóó} other{Ñóó}}］",
    );
    expect(pseudoLocalise("{n, plural, one {# day} other {# days}}")).toBe(
      "［{n,plural,one{# dááýý} other{# dááýýš}}］",
    );
  });
});
