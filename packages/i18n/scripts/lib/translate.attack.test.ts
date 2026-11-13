import { expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { attack } from "./attack.ts";
import { reviewHash } from "./review-hash.ts";
import { parseMessages } from "./schema.ts";
import {
  applyTranslations,
  rejectionReason,
  reviewedExamples,
  selectForTranslation,
  untrustedTextProblem,
} from "./translate.ts";

// Attacks on what i18n:translate refuses of machine text and on what it never
// sends (#380): contact details and invisible characters a translation adds,
// in a form the patterns may not read, and the texts that never go to a
// translator (.claude/rules/i18n.md; the header of untrustedTextProblem).

const EN = "Call the support line.";

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

/** What is tried, a translation that adds it, the same sentence without it, and whether it goes through today. */
const ADDED: [string, string, string, string?][] = [
  // A phone number is digits joined by spaces or hyphens, a web address letters,
  // a dot and letters, an invisible character one of four kinds that are no
  // letter, a formula a text that starts with =: each row is the thing in another shape.
  ["a phone number written with dots", "Soita 040.123.4567", "Soita tukeen.", HOLE],
  [
    "a phone number written with dashes of another length",
    "Soita 040–123–4567",
    "Soita tukeen.",
    HOLE,
  ],
  ["a web address given as bare numbers", "Katso 185.199.108.153", "Katso tukea.", HOLE],
  ["a web address whose dot is the East Asian full stop", "Katso evil。fi", "Katso tukea.", HOLE],
  ["a messaging handle named without its @", "Telegram: evil_tuki", "Viestillä tukeen.", QUESTION],
  ["a letter nobody can see", "Soita tukeen\u3164.", "Soita tukeen.", HOLE],
  ["a formula that starts with a plus", "+SUM(1) tukeen", "Soita tukeen.", HOLE],
  // Forms the patterns have to read like the plain ones.
  [
    "a phone number in wide digits with narrow spaces",
    "Soita ０４０\u202f１２３\u202f４５６７",
    "Soita tukeen.",
  ],
  ["a web address whose dot is a look-alike", "Katso evil\u2024fi", "Katso tukea."],
  ["a link with a scheme of its own", "Katso hxxp://evil.fi", "Katso tukea."],
  ["a messaging handle with its @", "Kirjoita @evil_tuki", "Kirjoita tukeen."],
  ["a formula after a no-break space", "\u00a0=1+1", "Soita tukeen."],
];

for (const [name, added, plain, open] of ADDED) {
  attack(`i18n:translate: ${name}, which the English lacks, is accepted`, {
    attempt: () => untrustedTextProblem(EN, added),
    control: () => untrustedTextProblem(EN, plain),
    succeeds: (seen) => expect(seen).toBeUndefined(),
    open,
  });
}

// An answer is empty when nothing is left after trimming, and the filler is a letter.
attack("i18n:translate: an answer of one invisible letter is written as the translation", {
  attempt: () => rejectionReason("Hello", "\u3164", "fi"),
  control: () => rejectionReason("Hello", "Hei", "fi"),
  succeeds: (seen) => expect(seen).toBeUndefined(),
  open: HOLE,
});

const FILE = `demo.save:
  en: Save
  description: A button.

demo.thanks:
  en: Thanks
  description: d
  fi: Kiitos
  reviewed: { fi: "${reviewHash("Thanks", "Kiitos")}" }

legal.terms.title:
  en: Terms
  description: d
  consent_version: "1"

legal.terms.summary:
  en: The terms.
  description: d
  fi: Ehdot.
  consent_version: "1"

admin.title:
  en: Admin
  description: English only.
`;
const messages = parseMessages(FILE);

/** What is tried, a key that never goes to a translator, and one that does. */
const NEVER_SENT: [string, string, string][] = [
  ["a legal text named outright", "legal.terms.title", "demo.save"],
  ["a text of the English-only panel named outright", "admin.title", "demo.save"],
];

for (const [name, key, ordinary] of NEVER_SENT) {
  const sent = (named: string) =>
    selectForTranslation(messages, "fi", { mode: "missing", keys: [named] }).map((i) => i.key);
  attack(`i18n:translate: ${name} is sent to the translator`, {
    attempt: () => sent(key),
    control: () => sent(ordinary),
    succeeds: (seen) => expect(seen).toHaveLength(1),
  });
}

attack("i18n:translate: a legal text is shown to the translator as an approved example", {
  attempt: () => reviewedExamples(messages, "fi", "legal"),
  control: () => reviewedExamples(messages, "fi", "demo"),
  succeeds: (seen) => expect(seen).toHaveLength(1),
});

// A translation that YAML would read as something other than text has to come
// back out of the file as the text it was.
const read = (text: string): { written: string[]; back: unknown } => {
  const written = applyTranslations(FILE, messages, "fi", { "demo.save": text });
  return { written: written.written, back: parseMessages(written.yaml)["demo.save"]?.fi };
};

/** What comes back when the answer is put in the file as it is, with no quotes. */
const unquoted = (text: string): { written: string[]; back: unknown } => {
  try {
    return { written: ["demo.save"], back: (parseYaml(`fi: ${text}`) as { fi: unknown }).fi };
  } catch {
    return { written: ["demo.save"], back: undefined };
  }
};

for (const text of ["true", "123", "null", "- Tallenna", "*tallenna", "Tallenna #nyt", "~"]) {
  attack(
    `i18n:translate: the answer ${JSON.stringify(text)} comes back from the file as something else`,
    {
      attempt: () => read(text),
      control: () => unquoted(text),
      succeeds: (seen) => {
        expect(seen.written).toEqual(["demo.save"]);
        expect(seen.back).not.toBe(text);
      },
    },
  );
}
