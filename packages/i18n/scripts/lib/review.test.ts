import { describe, expect, it } from "vitest";
import { commandData } from "./annotate.ts";
import { checkMessages } from "./check.ts";
import {
  approve,
  decodeSheet,
  exportSheet,
  formatProgress,
  importSheet,
  newlyReviewed,
  parseTsvCell,
  progress,
  reflag,
  selectKeys,
  tsvCell,
} from "./review.ts";
import { reviewHash } from "./review-hash.ts";
import { parseMessages } from "./schema.ts";

const SOURCE = `# A comment that must survive.
demo.greeting:
  en: Hello
  description: Greeting on the first screen.
  fi: Hei
  sv: Hej
  machine: { fi: true, sv: true }

demo.likes:
  en: "{likes, plural, one {# like} other {# likes}}"
  description: Number of likes.
  fi: "{likes, plural, other {# tykkäystä}}"
  machine: { fi: true }

demo.bye:
  en: Goodbye
  description: Last screen.
  fi: Näkemiin
  reviewed: { fi: "${reviewHash("Goodbye", "Näkemiin")}" }

admin.title:
  en: Admin
  description: English only.

legal.privacy.title:
  en: Privacy
  description: Binding legal text.
  fi: Tietosuoja
  consent_version: "1"
`;

const messages = parseMessages(SOURCE);

/** A sheet as a reviewer returns it: rows edited by column name. */
function edited(sheet: string, edits: Record<string, { fi?: string; approve?: string }>): string {
  const [header = "", ...rows] = sheet.replace(/^﻿/, "").trimEnd().split("\n");
  const columns = header.split("\t");
  const at = (name: string): number => columns.indexOf(name);
  return [
    header,
    ...rows.map((row) => {
      const cells = row.split("\t");
      const edit = edits[cells[at("key")] ?? ""];
      if (edit?.fi !== undefined) cells[at("fi")] = edit.fi;
      if (edit?.approve !== undefined) cells[at("approve")] = edit.approve;
      return cells.join("\t");
    }),
  ].join("\n");
}

describe("i18n:review", () => {
  it("approves machine text: the flag goes, the hash of en and fi comes, the rest of the file stays", () => {
    const result = approve(SOURCE, messages, "fi", ["demo.greeting"]);
    expect(result.approved).toEqual(["demo.greeting"]);
    const after = parseMessages(result.yaml);
    expect(after["demo.greeting"]).toMatchObject({
      fi: "Hei",
      machine: { sv: true },
      reviewed: { fi: reviewHash("Hello", "Hei") },
    });
    expect(result.yaml.startsWith("# A comment that must survive.")).toBe(true);
    expect(result.yaml).toContain(`reviewed: { fi: "${reviewHash("Hello", "Hei")}" }`);
    expect(checkMessages(after, { release: false }).errors).toEqual([
      "demo.likes: fi {likes} lacks the fi plural forms one",
    ]);
  });

  it("refuses to approve text that breaks a rule, legal and admin text, and skips reviewed text", () => {
    const result = approve(SOURCE, messages, "fi", [
      "demo.likes",
      "legal.privacy.title",
      "admin.title",
      "demo.bye",
    ]);
    expect(result.approved).toEqual([]);
    expect(result.refused).toEqual({
      "demo.likes": "{likes} lacks the fi plural forms one",
      "legal.privacy.title":
        "legal text is written by people and versioned by consent_version, not reviewed here",
      "admin.title": "admin.* is English only",
    });
    expect(result.skipped).toEqual({ "demo.bye": "already reviewed" });
    expect(result.yaml).toBe(SOURCE);
  });

  it("selects keys by name or prefix, and reports a selector that names nothing", () => {
    expect(selectKeys(messages, ["demo.*", "nope.key"])).toEqual({
      keys: ["demo.greeting", "demo.likes", "demo.bye"],
      unknown: ["nope.key"],
    });
  });

  it("flags a reviewed text for review again when its English changed", () => {
    const changed = SOURCE.replace("  en: Goodbye", "  en: Goodbye for now");
    const before = parseMessages(changed);
    expect(checkMessages(before, { release: false }).errors).toContain(
      "demo.bye: fi changed since its native review (the English or the fi text); flag it for review again with pnpm i18n:review --reflag --locale fi demo.bye",
    );
    const result = reflag(changed, before, "fi", ["demo.bye", "demo.greeting"]);
    expect(result.flagged).toEqual(["demo.bye"]);
    expect(result.skipped).toEqual({ "demo.greeting": "machine, nothing to flag" });
    const after = parseMessages(result.yaml);
    expect(after["demo.bye"]).toMatchObject({ machine: { fi: true } });
    expect(after["demo.bye"]?.reviewed).toBeUndefined();
  });

  it("counts the review per namespace, for a terminal and for a CI summary", () => {
    const rows = progress(messages);
    expect(rows).toEqual([
      {
        namespace: "demo",
        fi: { reviewed: 1, machine: 2, stale: 0, missing: 0 },
        sv: { reviewed: 0, machine: 1, stale: 0, missing: 2 },
      },
    ]);
    expect(formatProgress(rows, true)).toContain("| demo | 1 | 2 | 0 | 0 | 1 | 0 |");
  });
});

describe("the review sheet", () => {
  const sheet = exportSheet(messages, "fi", "tsv");

  it("lists the texts waiting for a reviewer, with where each shows and a fingerprint", () => {
    const [header, ...rows] = sheet.replace(/^﻿/, "").trimEnd().split("\n");
    expect(sheet.startsWith("﻿")).toBe(true); // so Excel reads it as UTF-8
    expect(header).toBe("key\twhere it shows\ten\tfi\tapprove\tnote\tfingerprint");
    expect(rows.map((row) => row.split("\t")[0])).toEqual(["demo.greeting", "demo.likes"]);
    expect(rows[0]?.split("\t")).toEqual([
      "demo.greeting",
      "Greeting on the first screen.",
      "Hello",
      "Hei",
      "",
      "",
      reviewHash("Hello", "Hei"),
    ]);
    expect(exportSheet(messages, "fi", "md")).toContain(
      "| `demo.greeting` | Greeting on the first screen. | Hello | Hei |  |",
    );
  });

  it("imports approvals, corrections with approval, and corrections that stay machine text", () => {
    const back = edited(sheet, {
      "demo.greeting": { fi: "Moi", approve: "x" },
      "demo.likes": { fi: "{likes, plural, one {# tykkäys} other {# tykkäystä}}" },
    });
    const result = importSheet(SOURCE, messages, "fi", back);
    expect(result).toMatchObject({
      approved: ["demo.greeting"],
      corrected: ["demo.likes"],
      refused: {},
    });
    const after = parseMessages(result.yaml);
    expect(after["demo.greeting"]).toMatchObject({
      fi: "Moi",
      reviewed: { fi: reviewHash("Hello", "Moi") },
    });
    expect(after["demo.likes"]).toMatchObject({
      fi: "{likes, plural, one {# tykkäys} other {# tykkäystä}}",
      machine: { fi: true },
    });
    expect(checkMessages(after, { release: false }).errors).toEqual([]);
  });

  it("changes nothing for a sheet returned as it was", () => {
    const result = importSheet(SOURCE, messages, "fi", sheet);
    expect(result).toMatchObject({
      approved: [],
      corrected: [],
      unchanged: ["demo.greeting", "demo.likes"],
    });
  });

  it("refuses a row whose text changed in the repository after the export, and one that breaks a rule", () => {
    const moved = SOURCE.replace("  fi: Hei\n", "  fi: Terve\n");
    const back = edited(sheet, {
      "demo.greeting": { approve: "yes" },
      "demo.likes": { approve: "x" },
    });
    const result = importSheet(moved, parseMessages(moved), "fi", back);
    expect(result.approved).toEqual([]);
    expect(result.refused).toEqual({
      "demo.greeting": "changed in the repository since the sheet was exported; export it again",
      "demo.likes": "{likes} lacks the fi plural forms one",
    });
    expect(result.yaml).toBe(moved);
  });

  it("reads cells a spreadsheet quoted, and refuses a sheet saved as UTF-16", () => {
    const quoted = edited(sheet, { "demo.greeting": { fi: '"Hei ""sinä"""', approve: "kyllä" } });
    const result = importSheet(SOURCE, messages, "fi", quoted);
    expect(parseMessages(result.yaml)["demo.greeting"]?.fi).toBe('Hei "sinä"');
    expect(() => importSheet(SOURCE, messages, "fi", "k\u0000e\u0000y\u0000")).toThrow(/UTF-8/);
  });

  it("names the texts newly approved since another version of the file, for the pull request", () => {
    const approved = parseMessages(approve(SOURCE, messages, "fi", ["demo.greeting"]).yaml);
    expect(newlyReviewed(messages, approved)).toEqual({ fi: ["demo.greeting"], sv: [] });
    expect(newlyReviewed(messages, messages)).toEqual({ fi: [], sv: [] });
    // A reviewed text whose wording moved under an unchanged hash is named too.
    const moved = parseMessages(SOURCE.replace("  fi: Näkemiin\n", "  fi: Näkemiin nyt\n"));
    expect(newlyReviewed(messages, moved)).toEqual({ fi: ["demo.bye"], sv: [] });
  });

  it("treats a text with neither mark as waiting for review, so a reviewer can approve it", () => {
    const unmarked = SOURCE.replace(
      "  sv: Hej\n  machine: { fi: true, sv: true }\n",
      "  sv: Hej\n  machine: { fi: true }\n",
    );
    const parsed = parseMessages(unmarked);
    expect(progress(parsed)[0]?.sv).toEqual({ reviewed: 0, machine: 1, stale: 0, missing: 2 });
    expect(approve(unmarked, parsed, "sv", ["demo.greeting"]).approved).toEqual(["demo.greeting"]);
  });

  it("reports a sheet row named like an Object.prototype member instead of losing it", () => {
    const back = `key\ten\tfi\tapprove\tfingerprint\n__proto__\tHello\tHei\tx\t0\n`;
    expect(importSheet(SOURCE, messages, "fi", back).refused).toEqual(
      Object.defineProperty({}, "__proto__", {
        value: "not in messages.yaml",
        enumerable: true,
        configurable: true,
        writable: true,
      }),
    );
  });
});

describe("CI annotations", () => {
  it("escape a line break, so text in messages.yaml cannot start a workflow command", () => {
    expect(commandData("a\n::add-mask::x 100%")).toBe("a%0A::add-mask::x 100%25");
  });
});

describe("the sheet, after the review of #74", () => {
  const yaml = `
smoke.formula:
  en: "+1 like"
  description: A count with a plus sign in front.
  fi: "+1 tykkäys"
  machine: { fi: true }
smoke.short:
  en: OK
  description: A button in a row.
  fi: Selvä
  machine: { fi: true }
  max_length: 5
`;

  it("writes a cell that a spreadsheet would run as a formula as text, and reads it back unchanged", () => {
    for (const text of ["=1+1", "+358 40", "-2", "@SUM(A1)"]) {
      const cell = tsvCell(text);
      expect(cell.startsWith('" ')).toBe(true);
      expect(parseTsvCell(cell)).toBe(text);
    }
    expect(tsvCell("Selvä")).toBe("Selvä");
    const messages = parseMessages(yaml);
    const sheet = exportSheet(messages, "fi", "tsv");
    expect(sheet).toContain('" +1 tykkäys"');
    // The round trip: approving the exported sheet as it is changes no text.
    const approved = sheet
      .split("\n")
      .map((line) => (line.startsWith("smoke.formula") ? line.replace("\t\t", "\tx\t") : line))
      .join("\n");
    const result = importSheet(yaml, messages, "fi", approved);
    expect(result.approved).toEqual(["smoke.formula"]);
    expect(parseMessages(result.yaml)["smoke.formula"]?.fi).toBe("+1 tykkäys");
  });

  it("refuses a sheet that is not UTF-8 instead of importing replacement characters", () => {
    // "Näkemiin" as Windows-1252 bytes: what Excel's tab-delimited save writes.
    const legacy = Uint8Array.from([0x4e, 0xe4, 0x6b, 0x65, 0x6d, 0x69, 0x69, 0x6e]);
    expect(() => decodeSheet(legacy)).toThrow(/not UTF-8/);
    expect(decodeSheet(new TextEncoder().encode("Näkemiin"))).toBe("Näkemiin");
    // UTF-16 with its byte order mark is refused the same way.
    expect(() => decodeSheet(Uint8Array.from([0xff, 0xfe, 0x4e, 0x00]))).toThrow(/not UTF-8/);
  });

  it("refuses a corrected row that does not fit its room, approved or not", () => {
    const messages = parseMessages(yaml);
    const sheet = exportSheet(messages, "fi", "tsv");
    const corrected = sheet.replace("\tSelvä\t", "\tSelvä juttu\t");
    expect(corrected).not.toBe(sheet);
    const result = importSheet(yaml, messages, "fi", corrected);
    expect(result.corrected).toEqual([]);
    expect(result.refused["smoke.short"]).toBe("is over its max_length of 5");
    expect(result.yaml).toContain("fi: Selvä\n");
  });
});

describe("the sheet's English", () => {
  it("refuses a row whose English is not the repository's, whatever the fingerprint says", () => {
    const yaml = `
smoke.hello:
  en: Hello
  description: A greeting.
  fi: Hei
  machine: { fi: true }
`;
    const messages = parseMessages(yaml);
    const sheet = exportSheet(messages, "fi", "tsv");
    const edited = sheet.replace("\tHello\t", "\tGoodbye\t").replace("\tHei\t\t", "\tHei\tx\t");
    const result = importSheet(yaml, messages, "fi", edited);
    expect(result.approved).toEqual([]);
    expect(result.refused["smoke.hello"]).toMatch(/English in the sheet is not the English/);
    const asExported = sheet.replace("\tHei\t\t", "\tHei\tx\t");
    expect(importSheet(yaml, messages, "fi", asExported).approved).toEqual(["smoke.hello"]);
  });
});

describe("the review's commands at their edges", () => {
  it("selects an exact key once, however often it is named, and never an inherited one", () => {
    expect(selectKeys(messages, ["demo.bye", "demo.bye", "demo.*"])).toEqual({
      keys: ["demo.bye", "demo.greeting", "demo.likes"],
      unknown: [],
    });
    expect(selectKeys(messages, ["__proto__", "toString", "nope.*"])).toEqual({
      keys: [],
      unknown: ["__proto__", "toString", "nope.*"],
    });
  });

  it("counts several namespaces in order, and lines a terminal table up by column", () => {
    const yaml = `${SOURCE}
alpha.one:
  en: One
  description: d.
  fi: Yksi
  sv: En
  machine: { fi: true, sv: true }
`;
    const rows = progress(parseMessages(yaml));
    expect(rows.map((row) => row.namespace)).toEqual(["alpha", "demo"]);
    expect(formatProgress(rows, false).split("\n")).toEqual([
      "namespace  fi reviewed  fi machine  fi stale  sv reviewed  sv machine  sv stale",
      "alpha                0           1         0            0           1         0",
      "demo                 1           2         0            0           1         0",
      "total                1           3         0            0           2         0",
    ]);
    expect(formatProgress([], false).split("\n")).toHaveLength(2);
  });

  it("approves a review gone stale: the old hash is replaced, no machine flag is added", () => {
    const changed = SOURCE.replace("  en: Goodbye", "  en: Goodbye for now");
    const before = parseMessages(changed);
    const result = approve(changed, before, "fi", ["demo.bye"]);
    expect(result.approved).toEqual(["demo.bye"]);
    const after = parseMessages(result.yaml)["demo.bye"];
    expect(after?.reviewed).toEqual({ fi: reviewHash("Goodbye for now", "Näkemiin") });
    expect(after?.machine).toBeUndefined();
  });

  it("refuses to approve a text that does not exist, and passes over a key that does not", () => {
    const result = approve(SOURCE, messages, "sv", ["demo.likes", "demo.ghost", "__proto__"]);
    expect(result.approved).toEqual([]);
    expect(result.refused).toEqual({ "demo.likes": "no sv text to approve" });
    expect(result.skipped).toEqual({});
    expect(result.yaml).toBe(SOURCE);
  });

  it("judges an approval on the translation, never on a fault of the English that i18n:check reports", () => {
    const yaml = `demo.where:
  en: Matches in {pond}
  description: d.
  fi: "Täsmää: {pond}"
  machine: { fi: true }
`;
    const parsed = parseMessages(yaml);
    expect(checkMessages(parsed, { release: false }).errors).toEqual([
      'demo.where: en "in {pond}" puts a dynamic value where other languages inflect it',
    ]);
    expect(approve(yaml, parsed, "fi", ["demo.where"]).approved).toEqual(["demo.where"]);
  });

  it("refuses an approval the file's own check would fail, untrimmed room included", () => {
    const yaml = `demo.ok:
  en: OK
  description: A button.
  fi: "Selvä  "
  machine: { fi: true }
  max_length: 5
`;
    expect(approve(yaml, parseMessages(yaml), "fi", ["demo.ok"]).refused).toEqual({
      "demo.ok": "fi is over its max_length of 5",
    });
  });

  it("stops when the file it would write into is not the file the messages came from", () => {
    const flat = "demo.greeting: Hello\n";
    expect(() => approve(flat, messages, "fi", ["demo.greeting"])).toThrow(
      "demo.greeting is not a mapping in messages.yaml",
    );
    expect(() => reflag(flat, messages, "fi", ["demo.bye"])).toThrow(/not a mapping/);
  });

  it("flags nothing that was never reviewed, and says why for each", () => {
    const result = reflag(SOURCE, messages, "sv", [
      "demo.likes",
      "legal.privacy.title",
      "admin.title",
      "demo.ghost",
    ]);
    expect(result.flagged).toEqual([]);
    expect(result.skipped).toEqual({
      "demo.likes": "missing, nothing to flag",
      "legal.privacy.title": "never reviewed here",
      "admin.title": "never reviewed here",
    });
    expect(result.yaml).toBe(SOURCE);
  });

  it("flags one language again and keeps the other language's review", () => {
    const both = `demo.ok:
  en: OK
  description: d.
  fi: Selvä
  sv: Okej
  reviewed: { fi: "${reviewHash("OK", "Selvä")}", sv: "${reviewHash("OK", "Okej")}" }
`;
    const after = parseMessages(reflag(both, parseMessages(both), "fi", ["demo.ok"]).yaml)[
      "demo.ok"
    ];
    expect(after?.machine).toEqual({ fi: true });
    expect(after?.reviewed).toEqual({ sv: reviewHash("OK", "Okej") });
  });

  it("flags a current review again when asked, keeping a machine flag of the other language", () => {
    const result = reflag(SOURCE, messages, "fi", ["demo.bye"]);
    expect(result.flagged).toEqual(["demo.bye"]);
    expect(parseMessages(result.yaml)["demo.bye"]).toMatchObject({ machine: { fi: true } });
  });
});

describe("the sheet's cells", () => {
  it.each(["a\tb", "a\nb", "a\r\nb"])("refuse %o, which would break the row", (text) => {
    expect(() => tsvCell(text)).toThrow(/cannot hold a tab or a line break/);
  });

  it.each([
    ["plain", "plain"],
    ['"quoted"', '"""quoted"""'],
    ['ends with a quote"', '"ends with a quote"""'],
    ['say "hi"', '"say ""hi"""'],
  ])("quote %s as a spreadsheet does, and read it back", (text, cell) => {
    expect(tsvCell(text)).toBe(cell);
    expect(parseTsvCell(cell)).toBe(text);
  });

  it("read a lone quote and padding as they are", () => {
    expect(parseTsvCell('"')).toBe('"');
    expect(parseTsvCell("  Hei  ")).toBe("Hei");
  });
});

describe("the sheet's rows", () => {
  const yaml = `demo.save:
  en: Save
  description: A button
    in a row.
  fi: Tallennaa nyt heti
  machine: { fi: true }
  max_length: 20
demo.bye:
  en: Goodbye
  description: Last screen.
  fi: Näkemiin
  reviewed: { fi: "${reviewHash("Goodbye!", "Näkemiin")}" }
demo.hi:
  en: Hi
  description: d.
  fi: Hei
  reviewed: { fi: "${reviewHash("Hi", "Hei")}" }
other.thing:
  en: Thing
  description: d.
  fi: Asia
  machine: { fi: true }
`;
  const parsed = parseMessages(yaml);

  it("note a stale review, the room and a text much longer than its English", () => {
    const rows = exportSheet(parsed, "fi", "tsv").trimEnd().split("\n").slice(1);
    const note = (key: string) => rows.find((row) => row.startsWith(key))?.split("\t")[5];
    expect(note("demo.save")).toBe("at most 20 characters; 4.5× the English: check it fits");
    expect(note("demo.bye")).toBe("changed since its last review");
    expect(note("other.thing")).toBe("");
    // The description is flattened onto one line.
    expect(rows[0]?.split("\t")[1]).toBe("A button in a row.");
  });

  it("cover a prefix, or every translation with --all", () => {
    expect(exportSheet(parsed, "fi", "md", { prefix: "demo." })).not.toContain("other.thing");
    const all = exportSheet(parsed, "fi", "tsv", { all: true });
    expect(all).toContain("demo.hi\t");
    expect(exportSheet(parsed, "fi", "tsv")).not.toContain("demo.hi\t");
    expect(exportSheet(parsed, "sv", "tsv", { all: true }).trimEnd().split("\n")).toHaveLength(1);
  });

  it("escape a pipe in the Markdown table", () => {
    const piped = parseMessages(
      'demo.or:\n  en: "A | B"\n  description: d.\n  fi: "A | B"\n  machine: { fi: true }\n',
    );
    expect(exportSheet(piped, "fi", "md")).toContain("| A \\| B | A \\| B |");
  });
});

describe("an imported sheet", () => {
  const sheet = exportSheet(messages, "fi", "tsv");
  const header = "key\twhere it shows\ten\tfi\tapprove\tnote\tfingerprint";

  it.each([
    ["an empty sheet", "", "key"],
    ["a sheet without the key column", "name\ten\tfi\tapprove\tfingerprint\n", "key"],
    ["a sheet of the other language", header.replace("\tfi\t", "\tsv\t"), "fi"],
    ["a sheet without fingerprints", "key\ten\tfi\tapprove\n", "fingerprint"],
  ])("is refused as %s, naming the column", (_, text, column) => {
    expect(() => importSheet(SOURCE, messages, "fi", text)).toThrow(
      `the sheet has no "${column}" column; export a new one`,
    );
  });

  it("reads quoted headers in any case, and skips blank lines and rows without a key", () => {
    const loud = sheet.replace("key\twhere it shows", '"KEY"\tWhere It Shows');
    const result = importSheet(SOURCE, messages, "fi", `${loud}\n\n\t\t\t\t\t\t\n`);
    expect(result.unchanged).toEqual(["demo.greeting", "demo.likes"]);
    expect(result.refused).toEqual({});
  });

  it("refuses a row cut short, legal and admin rows, and a row for a text the file lacks", () => {
    const back = [
      header,
      "demo.greeting",
      `legal.privacy.title\t\tPrivacy\tTietosuoja\tx\t\t${reviewHash("Privacy", "Tietosuoja")}`,
      "admin.title\t\tAdmin\tHallinta\tx\t\t0",
    ].join("\n");
    expect(importSheet(SOURCE, messages, "fi", back).refused).toEqual({
      "demo.greeting": "changed in the repository since the sheet was exported; export it again",
      "legal.privacy.title":
        "legal text is written by people and versioned by consent_version, not reviewed here",
      "admin.title": "admin.* is English only",
    });
    const sv = `${header.replace("\tfi\t", "\tsv\t")}\ndemo.likes\t\tx\tx\tx\t\t0\n`;
    expect(importSheet(SOURCE, messages, "sv", sv).refused).toEqual({
      "demo.likes": "no sv text in messages.yaml",
    });
  });

  it("refuses a row whose English cell is missing, and one whose translation was emptied", () => {
    const fingerprint = reviewHash("Hello", "Hei");
    const back = [
      "key\tfi\tapprove\tfingerprint\ten",
      `demo.greeting\tHei\tx\t${fingerprint}`,
    ].join("\n");
    expect(importSheet(SOURCE, messages, "fi", back).refused["demo.greeting"]).toMatch(
      /English in the sheet is not the English/,
    );
    const emptied = edited(sheet, { "demo.greeting": { fi: "", approve: "x" } });
    expect(importSheet(SOURCE, messages, "fi", emptied).refused).toEqual({
      "demo.greeting": "the fi cell is empty",
    });
    const cut = `${header}\ndemo.greeting\t\tHello\n`;
    expect(importSheet(SOURCE, messages, "fi", cut).refused["demo.greeting"]).toMatch(
      /changed in the repository/,
    );
  });

  it("skips a row without a key, wherever the key column stands", () => {
    const back = [
      "en\tfi\tapprove\tfingerprint\tkey",
      `Hello\tMoi\tx\t${reviewHash("Hello", "Hei")}\t`,
      "Hello",
    ].join("\n");
    expect(importSheet(SOURCE, messages, "fi", back)).toMatchObject({
      approved: [],
      unchanged: [],
      refused: {},
    });
  });

  it("reads a row cut off before its translation as an empty one", () => {
    const back = [
      "key\ten\tfingerprint\tapprove\tfi",
      `demo.greeting\tHello\t${reviewHash("Hello", "Hei")}`,
    ].join("\n");
    expect(importSheet(SOURCE, messages, "fi", back).refused).toEqual({
      "demo.greeting": "the fi cell is empty",
    });
  });

  it.each(["x", "X", "yes", "Y", "ok", "✓", "✔", "1", "true", "kyllä", "K", "ja", "j"])(
    "takes %s in the approve column as an approval",
    (mark) => {
      const back = edited(sheet, { "demo.greeting": { approve: mark } });
      expect(importSheet(SOURCE, messages, "fi", back).approved).toEqual(["demo.greeting"]);
    },
  );

  it.each(["no", "0", "maybe", "xx"])("takes %s in the approve column as no approval", (mark) => {
    const back = edited(sheet, { "demo.greeting": { approve: mark } });
    expect(importSheet(SOURCE, messages, "fi", back)).toMatchObject({
      approved: [],
      unchanged: ["demo.greeting", "demo.likes"],
    });
  });
});

describe("approvals new since another version", () => {
  it("name a reviewed key the earlier file did not have at all", () => {
    expect(newlyReviewed({}, messages)).toEqual({ fi: ["demo.bye"], sv: [] });
  });

  it("name a review whose English moved under the same hash", () => {
    const moved = parseMessages(SOURCE.replace("  en: Goodbye", "  en: Goodbye again"));
    expect(newlyReviewed(messages, moved)).toEqual({ fi: ["demo.bye"], sv: [] });
    expect(newlyReviewed(moved, messages)).toEqual({ fi: ["demo.bye"], sv: [] });
  });
});
