import { expect } from "vitest";
import { attack } from "./attack.ts";
import { checkMessages } from "./check.ts";
import { reviewHash } from "./review-hash.ts";
import { type Messages, parseMessages } from "./schema.ts";

// Attacks on i18n:check and messages.yaml's own schema (#380): a text that
// breaks a rule of .claude/rules/i18n.md, in a form the check may not read.
// Each case is a file that breaks the rule, and the same file with nothing
// wrong in it, which the check has to pass.

type Message = Messages[string];

const ok = (fields: Partial<Message> = {}): Message => ({
  en: "Save",
  description: "A button.",
  fi: "Tallenna",
  machine: { fi: true },
  ...fields,
});

const errorsOf = (key: string, message: Message, release = false) =>
  checkMessages({ [key]: message }, { release }).errors;

/** The problems of a file as text, or none when it parses. */
function refusals(yaml: string): string[] {
  try {
    parseMessages(yaml);
    return [];
  } catch (error) {
    return (error as Error).message.split("\n");
  }
}

const silent = (seen: string[]) => expect(seen).toEqual([]);

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

// "Never inflect dynamic values": the English invites a case form, or the
// Finnish carries one.
const INFLECTED_EN: [string, string, string, string?][] = [
  // The check knows ten prepositions, and looks at the text right before the
  // value at its own level: another word, an article between, a tag around the
  // value or an ending after an apostrophe is not what it looks for.
  ["after the preposition near", "People near {pond}", "People nearby: {pond}", HOLE],
  ["after the preposition without", "A day without {name}", "Away today: {name}", HOLE],
  ["after a preposition and an article", "Matches in the {pond}", "Matches there: {pond}", HOLE],
  [
    "in a tag after a preposition",
    "New people in <b>{pond}</b>",
    "New people: <b>{pond}</b>",
    HOLE,
  ],
  ["with a possessive s", "{name}'s photos", "Photos: {name}", HOLE],
  // Forms the check has to read like the plain "in {pond}".
  ["after a preposition and a no-break space", "Live in\u00a0{pond}", "Live here:\u00a0{pond}"],
  ["after a preposition that opens the sentence", "In {pond}", "Here: {pond}"],
  [
    "after a preposition, inside a plural's branch",
    "{n, plural, one {# person in {pond}} other {# people in {pond}}}",
    "{n, plural, one {# person: {pond}} other {# people: {pond}}}",
  ],
];

// The Finnish is the plain sentence both times: it has the same value and tags, and no ending.
for (const [name, inflected, plain, open] of INFLECTED_EN) {
  attack(`i18n:check: an English value ${name} passes`, {
    attempt: () => errorsOf("demo.where", ok({ en: inflected, fi: plain })),
    control: () => errorsOf("demo.where", ok({ en: plain, fi: plain })),
    succeeds: silent,
    open,
  });
}

const INFLECTED_FI: [string, string, string?][] = [
  // An ending counts when a letter, or a colon and a letter, follows the value.
  ["with an ending after an apostrophe", "{pond}’ssa", HOLE],
  ["with an ending after a colon", "{pond}:ssa"],
];

for (const [name, fi, open] of INFLECTED_FI) {
  attack(`i18n:check: a Finnish value ${name} passes`, {
    attempt: () => errorsOf("demo.where", ok({ en: "Pond: {pond}", fi })),
    control: () => errorsOf("demo.where", ok({ en: "Pond: {pond}", fi: "Lampi: {pond}" })),
    succeeds: silent,
    open,
  });
}

// "A plural form the language needs or a select option of the English that is missing fails."
const LIKES = "{n, plural, one {# like} other {# likes}}";
const TYKKAYKSET = "{n, plural, one {# tykkäys} other {# tykkäystä}}";
const STATE = "{state, select, open {Open} closed {Closed} other {Waiting}}";
const TILA = "{state, select, open {Auki} closed {Kiinni} other {Odottaa}}";

const BRANCHES: [string, Message, Message, string?][] = [
  // The branches of one value are gathered from every place it stands, so a
  // whole plural or select answers for a second one that lacks a form; and
  // =1 is taken for the one form whatever offset the plural has.
  [
    "a second plural of the same number that lacks its one form",
    ok({ en: `${LIKES}, ${LIKES}`, fi: `${TYKKAYKSET}, {n, plural, other {# lisää}}` }),
    ok({ en: `${LIKES}, ${LIKES}`, fi: `${TYKKAYKSET}, ${TYKKAYKSET}` }),
    HOLE,
  ],
  [
    "a second select of the same value that lacks an option of the English",
    ok({ en: `${STATE} ${STATE}`, fi: `${TILA} {state, select, open {Auki} other {Odottaa}}` }),
    ok({ en: `${STATE} ${STATE}`, fi: `${TILA} ${TILA}` }),
    HOLE,
  ],
  [
    "a plural whose =1 stands in for one although an offset moves the count",
    ok({
      en: "{n, plural, offset:1 =1 {You} other {You and # others}}",
      fi: "{n, plural, offset:1 =1 {Sinä} other {Sinä ja # muuta}}",
    }),
    ok({
      en: "{n, plural, offset:1 =1 {You} one {You and # other} other {You and # others}}",
      fi: "{n, plural, offset:1 =1 {Sinä} one {Sinä ja # muu} other {Sinä ja # muuta}}",
    }),
    HOLE,
  ],
  // A form the check has to read like the plain one.
  [
    "a plural inside a tag that lacks its one form",
    ok({ en: `<b>${LIKES}</b>`, fi: "<b>{n, plural, other {# tykkäystä}}</b>" }),
    ok({ en: `<b>${LIKES}</b>`, fi: `<b>${TYKKAYKSET}</b>` }),
  ],
];

for (const [name, broken, whole, open] of BRANCHES) {
  attack(`i18n:check: ${name} passes`, {
    attempt: () => errorsOf("demo.likes", broken),
    control: () => errorsOf("demo.likes", whole),
    succeeds: silent,
    open,
  });
}

// Slang stands only "without failures, consent, a person's data, safety,
// sessions or the answers that say who somebody is".
const slang = ok({ slangi: "Tallentsaa", machine: { fi: true, slangi: true } });

const NEVER_SLANG: [string, string, string, string?][] = [
  // What stays plain is known by twelve runs of letters in the key: a failure,
  // a person's data, a consent or a way out named in other words carries none of them.
  [
    "a failure said once, under a number's field",
    "settings.contacts.phoneShort",
    "settings.title",
    HOLE,
  ],
  ["a like that was refused", "round.yourTurn.refused", "round.title", HOLE],
  ["a person's e-mail address", "settings.email.unconfirmed", "settings.title", HOLE],
  ["a person's gender", "profile.gender.title", "profile.title", HOLE],
  ["a consent", "settings.consent.title", "settings.title", HOLE],
  ["signing out", "settings.signOut.label", "settings.title", HOLE],
  // A form the check has to read like the plain one.
  ["a failure named in capitals", "round.loadFAILED", "round.title"],
];

for (const [name, key, harmless, open] of NEVER_SLANG) {
  attack(`i18n:check: slang on ${name} (${key}) passes`, {
    attempt: () => errorsOf(key, slang),
    control: () => errorsOf(harmless, slang),
    succeeds: silent,
    open,
  });
}

// "Never machine-translate the privacy policy, consent texts, terms, or the
// police-traceability line": outside legal.* a key that names one is refused,
// so that it cannot take a machine flag.
const entry = (key: string) =>
  `${key}:\n  en: I agree\n  description: d\n  fi: Hyväksyn\n  machine: { fi: true }\n`;

const BINDING: [string, string, string?][] = [
  // The schema knows the six words as whole parts of a key, between dots or
  // underscores: inside a camel-case part they are not seen.
  ["a privacy policy named in camel case", "onboarding.privacyPolicy.body", HOLE],
  ["terms named in camel case", "settings.termsOfUse", HOLE],
  ["a consent text named in camel case", "onboarding.consentText", HOLE],
  ["the police line named in camel case", "signIn.policeLine", HOLE],
  // Forms the schema has to read like the plain ones.
  ["a consent named with a capital", "onboarding.Consent.body"],
  ["a consent named in snake case", "onboarding.consent_body"],
];

for (const [name, key, open] of BINDING) {
  attack(`messages.yaml: ${name} (${key}) is taken for ordinary machine text`, {
    attempt: () => refusals(entry(key)),
    control: () => refusals(entry("onboarding.welcome.body")),
    succeeds: silent,
    open,
  });
}

// "Each key has en, a description, and fi", and what the translator's output
// is held to holds for every text in the file: an empty answer is refused there.
// The file's schema asks for one character of any kind, and the check for no more.
const BLANK: [string, Partial<Message>][] = [
  ["a Finnish text of one space", { fi: " " }],
  ["an English text of one space", { en: " " }],
  ["a Finnish text of one invisible letter", { fi: "\u3164" }],
];

for (const [name, fields] of BLANK) {
  attack(`i18n:check: ${name} passes`, {
    attempt: () => errorsOf("demo.save", ok(fields)),
    control: () => errorsOf("demo.save", ok()),
    succeeds: silent,
    open: HOLE,
  });
}

// "Every fi and sv text carries either machine: or reviewed:", and a review
// stands only for the English and the text it was given for.
const REVIEWED = reviewHash("Save", "Tallenna");
const reviewed = (fields: Partial<Message>): Message => ({
  en: "Save",
  description: "A button.",
  fi: "Tallenna",
  reviewed: { fi: REVIEWED },
  ...fields,
});
const withSwedish = { sv: "Spara", machine: { sv: true } };

const MARKS: [string, Message, Message][] = [
  ["a machine flag switched to false", ok({ machine: { fi: false } }), ok()],
  [
    "a review of the Swedish text filed under the Finnish",
    reviewed({ ...withSwedish, reviewed: { fi: reviewHash("Save", "Spara") } }),
    reviewed(withSwedish),
  ],
  [
    "a review kept while the English changed only in its capitals",
    reviewed({ en: "SAVE" }),
    reviewed({}),
  ],
  [
    "a review kept while the room for the text shrank under it",
    reviewed({ max_length: 4 }),
    reviewed({ max_length: 8 }),
  ],
];

for (const [name, broken, whole] of MARKS) {
  attack(`i18n:check: ${name} passes`, {
    attempt: () => errorsOf("demo.save", broken),
    control: () => errorsOf("demo.save", whole),
    succeeds: silent,
  });
}

// "--release also fails on ... draft legal text."
const terms = (fields: Partial<Message>): Message => ({
  en: "Terms",
  description: "d",
  fi: "Ehdot",
  sv: "Villkor",
  consent_version: "2026-10-1",
  ...fields,
});

const DRAFTS: [string, Partial<Message>, string?][] = [
  // A version is searched for the English word alone, a wording for the three
  // words as whole words: a version in Finnish and an inflected word are neither.
  ["a version that says draft in Finnish", { consent_version: "2026-10-luonnos-1" }, HOLE],
  ["a Swedish wording headed The draft", { sv: "Utkastet: villkor" }, QUESTION],
  // Forms the check has to read like the plain marker.
  ["a wording marked draft in square brackets", { en: "[draft] Terms" }],
  ["a wording marked draft before a no-break space", { fi: "Luonnos\u00a0ehdoista" }],
];

for (const [name, fields, open] of DRAFTS) {
  attack(`i18n:check --release: ${name} passes`, {
    attempt: () => errorsOf("legal.terms.title", terms(fields), true),
    control: () => errorsOf("legal.terms.title", terms({}), true),
    succeeds: silent,
    open,
  });
}

// "admin.* is English only": the check reads that as needing no Finnish, and
// holds a Finnish text there to what it holds any other.
attack("i18n:check: a Finnish text on an admin.* key passes", {
  attempt: () => errorsOf("admin.queue.title", ok()),
  control: () => errorsOf("admin.queue.title", { en: "Save", description: "A button." }),
  succeeds: silent,
  open: QUESTION,
});

// "max_length holds where it is set": the room is counted in the characters a
// reader sees, and a tag is markup the app renders, not one of them. The count
// is of the text as it is written, tags and all.
attack("i18n:check: a text that fits its room is refused for the letters of its tags", {
  attempt: () => errorsOf("demo.save", ok({ en: "<b>Save</b>", fi: "<b>Tall</b>", max_length: 4 })),
  control: () => errorsOf("demo.save", ok({ en: "Save", fi: "Tallenna", max_length: 4 })),
  succeeds: (seen) => expect(seen).not.toEqual([]),
  open: HOLE,
});

// The file's own form: what YAML offers for writing a key twice or elsewhere.
const pair = (key: string, en: string) => `${key}:\n  en: ${en}\n  description: d\n`;

const YAML_FORMS: [string, string, string][] = [
  ["a key written twice", pair("demo.a", "One") + pair("demo.a", "Two"), pair("demo.a", "One")],
  [
    "a field written twice",
    "demo.a:\n  en: One\n  en: Two\n  description: d\n",
    "demo.a:\n  en: One\n  description: d\n",
  ],
  [
    "a second document after the first",
    `${pair("demo.a", "One")}---\n${pair("legal.terms", "Two")}`,
    pair("demo.a", "One"),
  ],
  [
    "a review hash left unquoted that reads as a number",
    `${pair("demo.a", "One")}  fi: Yksi\n  reviewed: { fi: 1234567890123456 }\n`,
    `${pair("demo.a", "One")}  fi: Yksi\n  reviewed: { fi: "1234567890123456" }\n`,
  ],
];

for (const [name, broken, whole] of YAML_FORMS) {
  attack(`messages.yaml: ${name} is read without a word`, {
    attempt: () => refusals(broken),
    control: () => refusals(whole),
    succeeds: silent,
  });
}
