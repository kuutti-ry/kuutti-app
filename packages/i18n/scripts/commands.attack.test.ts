import { resolve } from "node:path";
import { beforeEach, describe, expect } from "vitest";
import { attack } from "./lib/attack.ts";
import { reviewHash } from "./lib/review-hash.ts";
import { parseMessages } from "./lib/schema.ts";
import { api, disk, MESSAGES, REPO, ROOT, run } from "./run-in-process.ts";

// Attacks on the review's and the translator's command lines (#380; #55,
// #235): a dry run asked for in a way that is not the flag, a language named
// twice, a batch whose record is lost. All of it in this process, with the
// file system and the Anthropic client the tests' stand-ins: an approval that
// got through is written nowhere, and nothing is sent or spent.

/** Machine text in both languages, and a key the translator has still to fill. */
const SOURCE = `demo.greeting:
  en: Hello
  description: Greeting.
  fi: Hei
  sv: Hej
  machine: { fi: true, sv: true }
demo.save:
  en: Save
  description: A button.
`;
const SHEET = resolve(REPO, "back.tsv");
const RECORD = resolve(ROOT, ".batches", "msgbatch_1.json");

beforeEach(() => {
  disk.files.clear();
  disk.written = new Map();
  disk.files.set(MESSAGES, SOURCE);
  // A reviewer's sheet that approves the greeting as it stands.
  disk.files.set(
    SHEET,
    `key\ten\tfi\tapprove\tfingerprint\ndemo.greeting\tHello\tHei\tx\t${reviewHash("Hello", "Hei")}\n`,
  );
  disk.files.set(resolve(ROOT, "glossary.yaml"), "Kuutti: never translated\n");
  disk.files.set(resolve(REPO, "docs", "i18n", "tone.md"), "Plain and warm.\n");
  api.clients = 0;
  api.submitted.length = 0;
  api.batch = { id: "msgbatch_1" };
  api.answer = (keys) => ({ translations: keys.map((key) => ({ key, text: "Tallenna" })) });
});

/** One command line. A refusal by the parser of the arguments is an outcome; any other failure is the test's. */
const ran = (script: "review.ts" | "translate.ts", args: readonly string[]) =>
  run(script, [...args]).then(
    () => undefined,
    (error: { code?: string }) => {
      if (!String(error.code).startsWith("ERR_PARSE_ARGS")) throw error;
    },
  );

// A dry run asked for in a way that is not the flag; each control is the same line without those words.
const NOT_THE_FLAG = [
  ["after a bare --", ["--", "--dry-run"]],
  ["with a long dash a pasted line carries", ["—dry-run"]],
  ["with =true after it", ["--dry-run=true"]],
  ["in capitals", ["--DRY-RUN"]],
] as const;

describe("pnpm i18n:review, asked for a dry run", () => {
  const wrote = async (args: readonly string[]) => {
    await ran("review.ts", args);
    return { wrote: disk.written.has(MESSAGES) };
  };
  for (const [what, line] of [
    ["an approval", ["--approve", "--locale", "fi", "demo.greeting"]],
    ["an import of a reviewer's sheet", ["--import", SHEET, "--locale", "fi"]],
  ] as const) {
    for (const [how, words] of NOT_THE_FLAG) {
      attack(`i18n:review: ${what} with a dry run asked for ${how} is written to messages.yaml`, {
        attempt: () => wrote([...line, ...words]),
        control: () => wrote(line),
        succeeds: (seen) => expect(seen.wrote).toBe(true),
      });
    }
  }

  const approvedSwedish = async (args: readonly string[]) => {
    await ran("review.ts", args);
    const written = parseMessages(disk.written.get(MESSAGES) ?? SOURCE);
    return { swedish: written["demo.greeting"]?.reviewed?.sv !== undefined };
  };
  attack("i18n:review: an approval that names Finnish and then Swedish approves the Swedish", {
    attempt: () =>
      approvedSwedish(["--approve", "--locale", "fi", "--locale", "sv", "demo.greeting"]),
    control: () => approvedSwedish(["--approve", "--locale", "sv", "demo.greeting"]),
    succeeds: (seen) => expect(seen.swedish).toBe(true),
  });
});

describe("pnpm i18n:translate, asked for a dry run", () => {
  const sent = async (args: readonly string[]) => {
    await ran("translate.ts", args);
    return { sent: api.clients > 0 };
  };
  for (const [how, words] of NOT_THE_FLAG) {
    attack(`i18n:translate: a dry run asked for ${how} sends the texts to the translator`, {
      attempt: () => sent(["--locale", "fi", ...words]),
      control: () => sent(["--locale", "fi"]),
      succeeds: (seen) => expect(seen.sent).toBe(true),
    });
  }
});

describe("pnpm i18n:translate, a batch", () => {
  /** A disk that takes every file but the batch's record. */
  class NoRecord extends Map<string, string> {
    override set(path: string, text: string): this {
      if (path === RECORD) throw new Error(`EACCES: permission denied, open '${path}'`);
      return super.set(path, text);
    }
  }
  const submitted = () => ({
    withoutItsRecord:
      api.submitted.length > 0 &&
      !disk.files.has(RECORD) &&
      ![...disk.files.keys()].some((path) => path.includes("/.pending-")),
  });

  attack(
    "i18n:translate: a batch is submitted where its record, by which alone it is collected, cannot be kept",
    {
      attempt: async () => {
        disk.written = new NoRecord();
        await expect(run("translate.ts", ["--mode", "batch", "--locale", "fi"])).rejects.toThrow(
          "EACCES",
        );
        return submitted();
      },
      // Planted: the batch submitted as it should be, and its record then taken away by hand.
      control: async () => {
        await ran("translate.ts", ["--mode", "batch", "--locale", "fi"]);
        expect(disk.files.has(RECORD)).toBe(true);
        disk.files.delete(RECORD);
        return submitted();
      },
      succeeds: (seen) => expect(seen.withoutItsRecord).toBe(true),
    },
  );
});
