import { expect } from "vitest";
import { attack } from "./attack.ts";
import { checkMessages } from "./check.ts";
import { approve, exportSheet, importSheet, newlyReviewed } from "./review.ts";
import { reviewHash } from "./review-hash.ts";
import { type Messages, parseMessages } from "./schema.ts";

// Attacks on the native review's marks (#380): a `reviewed:` that lands on a
// text no reviewer approved, or one CI does not name (.claude/rules/i18n.md,
// the machine and reviewed bullet; the header of review.ts).

const FILE = `demo.hello:
  en: Hello
  description: d
  fi: Hei
  machine: { fi: true }

demo.where:
  en: "Pond: {pond}"
  description: d
  fi: "{pond}ssa"
  machine: { fi: true }

legal.terms.summary:
  en: The terms.
  description: d
  fi: Ehdot.
  consent_version: "1"
`;
const messages = parseMessages(FILE);

/** What is tried, a key whose Finnish must not be approved, and one that may be. */
const NOT_APPROVED: [string, string][] = [
  ["a legal text", "legal.terms.summary"],
  ["a text that puts an ending on a value", "demo.where"],
];

for (const [name, key] of NOT_APPROVED) {
  attack(`i18n:review --approve: ${name} is marked reviewed`, {
    attempt: () => approve(FILE, messages, "fi", [key]).approved,
    control: () => approve(FILE, messages, "fi", ["demo.hello"]).approved,
    succeeds: (seen) => expect(seen).toHaveLength(1),
  });
}

// The sheet a reviewer returns: one line per text, as exportSheet wrote it.
const HEADER = ["key", "where it shows", "en", "fi", "approve", "note", "fingerprint"];
const row = (fields: { text?: string; approve?: string; en?: string; fingerprint?: string }) =>
  [
    "demo.hello",
    "d",
    fields.en ?? "Hello",
    fields.text ?? "Hei",
    fields.approve ?? "x",
    "",
    fields.fingerprint ?? reviewHash("Hello", "Hei"),
  ].join("\t");
const imported = (...rows: string[]) =>
  importSheet(FILE, messages, "fi", [HEADER.join("\t"), ...rows].join("\n"));

/** What is tried, and the row a reviewer did not approve as it stands. */
const NOT_AN_APPROVAL: [string, string][] = [
  ["a row whose approve cell asks a question", row({ approve: "ok?" })],
  ["a row whose approve cell is a cross", row({ approve: "✗" })],
  ["a row whose approve cell says no in Finnish", row({ approve: "ei" })],
  ["a row with the fingerprint of another text", row({ fingerprint: reviewHash("Hello", "Moi") })],
  ["a row whose English cell is not the file's", row({ en: "Hello!" })],
];

for (const [name, line] of NOT_AN_APPROVAL) {
  attack(`i18n:review --import: ${name} is marked reviewed`, {
    attempt: () => imported(line).approved,
    control: () => imported(row({})).approved,
    succeeds: (seen) => expect(seen).toHaveLength(1),
  });
}

// One key on two rows: the first corrects the text and approves nothing, the
// second approves the text as it was. The file must not end up with the new
// text under a review that the check accepts.
const afterImport = (...rows: string[]) => {
  const after = parseMessages(imported(...rows).yaml);
  return {
    text: after["demo.hello"]?.fi,
    reviewed: after["demo.hello"]?.reviewed?.fi,
    errors: checkMessages(after, { release: false }).errors.filter((e) => /^demo\.hello: /.test(e)),
  };
};

attack("i18n:review --import: a corrected text takes over the review of the text it replaced", {
  attempt: () => afterImport(row({ text: "Moi", approve: "" }), row({})),
  control: () => afterImport(row({ text: "Moi" })),
  succeeds: (seen) => {
    expect(seen.text).toBe("Moi");
    expect(seen.reviewed).toBeDefined();
    expect(seen.errors).toEqual([]);
  },
});

// "CI names them on the pull request, so an approval nobody asked for shows."
const slang = (fields: Partial<Messages[string]>): Messages => ({
  "round.title": {
    en: "Save",
    description: "d",
    fi: "Tallenna",
    slangi: "Sae",
    machine: { fi: true, slangi: true },
    ...fields,
  },
});
const moved = (key: string): Messages => ({
  [key]: {
    en: "Save",
    description: "d",
    fi: "Tallenna",
    reviewed: { fi: reviewHash("Save", "Tallenna") },
  },
});

// What goes through today (#380): a hole, which its contract forbids.
const HOLE = "#380";

const UNNAMED: [string, Messages, Messages, string?][] = [
  // The comparison goes through Finnish and Swedish, the two languages the tool approves.
  [
    "a review of a slang text written by hand",
    slang({}),
    slang({ machine: { fi: true }, reviewed: { slangi: reviewHash("Save", "Sae") } }),
    HOLE,
  ],
  // A form the comparison has to read like a new hash on the same key.
  ["a review that arrives with its text under a new key", moved("demo.save"), moved("demo.store")],
];

for (const [name, before, after, open] of UNNAMED) {
  attack(`i18n:review --approved-since: ${name} is not named`, {
    attempt: () => newlyReviewed(before, after),
    control: () => newlyReviewed(before, before),
    succeeds: (seen) => expect(seen).toEqual({ fi: [], sv: [] }),
    open,
  });
}

// The sheet opens in a spreadsheet, which runs a cell that starts like a formula.
const cellOf = (text: string) => {
  const sheet = exportSheet(
    { "demo.sum": { en: "Total", description: "d", fi: text, machine: { fi: true } } },
    "fi",
    "tsv",
  );
  return (sheet.split("\n")[1] ?? "").split("\t")[3] ?? "";
};

for (const text of ["=1+1", "+1+1", "-1+1", "@SUM(1)"]) {
  attack(`i18n:review --export: the machine text ${JSON.stringify(text)} leaves as a formula`, {
    attempt: () => cellOf(text),
    // What a writer with no guard would put in the cell: the text as it is.
    control: () => text,
    succeeds: (seen) => expect(seen).toMatch(/^"?[=+\-@]/),
  });
}
