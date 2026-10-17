/**
 * `pnpm i18n:review`: the native review of machine text (#55, TD-17).
 *
 *   pnpm i18n:review                                  progress per namespace
 *   pnpm i18n:review --list [--stale] [--prefix p.]   the texts waiting for a reviewer
 *   pnpm i18n:review --export tsv|md --locale fi [--prefix p.] [--all] [--out file]
 *   pnpm i18n:review --import sheet.tsv --locale fi [--dry-run]
 *   pnpm i18n:review --approve --locale fi <key | prefix.*>... [--dry-run]
 *   pnpm i18n:review --reflag --locale fi (<key | prefix.*>... | --stale) [--dry-run]
 *   pnpm i18n:review --approved-since <git ref>       CI: approvals new in a pull request
 *
 * --approve and --import record a native reviewer's decision: a person runs
 * them for the reviewer, an agent never does (rules/i18n.md). --reflag only
 * ever asks for more review. docs/i18n/translation-review-guide.md is the reviewer's guide.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandData } from "./lib/annotate.ts";
import { stale, unreviewed } from "./lib/check.ts";
import {
  approve,
  decodeSheet,
  exportSheet,
  formatProgress,
  importSheet,
  newlyReviewed,
  progress,
  reflag,
  selectKeys,
  sheetKeys,
} from "./lib/review.ts";
import {
  isTranslatedLocale,
  parseMessages,
  TRANSLATED_LOCALES,
  type TranslatedLocale,
} from "./lib/schema.ts";

const file = resolve(import.meta.dirname, "..", "messages.yaml");
const annotate = process.env.GITHUB_ACTIONS === "true";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    locale: { type: "string" },
    prefix: { type: "string" },
    list: { type: "boolean", default: false },
    stale: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    export: { type: "string" },
    out: { type: "string" },
    import: { type: "string" },
    approve: { type: "boolean", default: false },
    reflag: { type: "boolean", default: false },
    markdown: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "approved-since": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

// An empty value is no value: `--approved-since=` would otherwise pass the
// one-command check below and fall through to printing the table (#235).
for (const [name, value] of Object.entries(values)) {
  if (value === "") fail(`--${name} takes a value`);
}

function requireLocale(): TranslatedLocale {
  if (!isTranslatedLocale(values.locale)) fail(`--locale is ${TRANSLATED_LOCALES.join(" or ")}`);
  return values.locale;
}

// One thing at a time: `--approve --reflag` must never approve and quietly drop the rest.
const operations = (
  [
    ["--approved-since", values["approved-since"] !== undefined],
    ["--export", values.export !== undefined],
    ["--import", values.import !== undefined],
    ["--approve", values.approve],
    ["--reflag", values.reflag],
    ["--list", values.list],
  ] as const
)
  .filter(([, given]) => given)
  .map(([name]) => name);
if (operations.length > 1) fail(`${operations.join(" and ")} are different commands; give one`);

const yamlText = readFileSync(file, "utf8");
const messages = parseMessages(yamlText);
const dryRun = values["dry-run"];

function write(yaml: string, what: string): void {
  if (dryRun) {
    console.log(`(dry run: messages.yaml not written) ${what}`);
    return;
  }
  writeFileSync(file, yaml);
  console.log(`${what}. Now run \`pnpm i18n:build\` and commit messages.yaml with src/generated.`);
}

function report(title: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  console.log(`${title} (${keys.length}):`);
  for (const key of keys) console.log(`  ${key}`);
}

function reportReasons(title: string, reasons: Record<string, string>): void {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return;
  console.error(`${title} (${entries.length}):`);
  for (const [key, reason] of entries) console.error(`  ✖ ${key}: ${reason}`);
}

function selected(): string[] {
  const { keys, unknown } = selectKeys(messages, positionals);
  if (unknown.length > 0) fail(`no key matches ${unknown.join(", ")}`);
  if (keys.length === 0) fail("name the keys: a key, or prefix.* for a namespace");
  return keys;
}

/**
 * messages.yaml as it was at `ref`. No file at that ref means every review in
 * the file is new; any other failure (no git, a ref that does not resolve, a
 * file that does not parse) stops the command, because an empty "before" would
 * print the same "nothing newly approved" as a working comparison.
 */
function messagesAt(ref: string): ReturnType<typeof parseMessages> {
  let text: string;
  try {
    // --end-of-options: a ref that starts with a dash is a ref, never an option.
    text = execFileSync("git", ["show", "--end-of-options", `${ref}:packages/i18n/messages.yaml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
    if (/exists on disk, but not in|does not exist in|path .* does not exist/i.test(stderr)) {
      return {};
    }
    fail(`could not read messages.yaml at ${JSON.stringify(ref)}: ${stderr.trim()}`);
  }
  return parseMessages(text);
}

if (values["approved-since"]) {
  const before = messagesAt(values["approved-since"]);
  const found = newlyReviewed(before, messages);
  // One warning on each approved key's line: it shows in the pull request's
  // diff, where whoever approves the pull request sees what it approves.
  const lines = yamlText.split("\n");
  for (const locale of TRANSLATED_LOCALES) {
    for (const key of found[locale]) {
      const text = `${locale} text approved as a native review: ${key}. The approval of this pull request is its record; it must be the reviewer's.`;
      const line = lines.indexOf(`${key}:`) + 1;
      console.log(
        annotate
          ? `::warning file=packages/i18n/messages.yaml,line=${line}::${commandData(text)}`
          : `${text} (line ${line})`,
      );
    }
  }
  if (found.fi.length + found.sv.length === 0) console.log("No text newly approved.");
} else if (values.export) {
  const locale = requireLocale();
  if (values.export !== "tsv" && values.export !== "md") fail("--export is tsv or md");
  const sheet = exportSheet(messages, locale, values.export, {
    prefix: values.prefix,
    all: values.all,
  });
  if (values.out) {
    writeFileSync(values.out, sheet);
    const count = sheetKeys(messages, locale, { prefix: values.prefix, all: values.all }).length;
    console.log(`Wrote ${count} ${locale} texts to ${values.out}.`);
  } else {
    process.stdout.write(sheet);
  }
} else if (values.import) {
  const locale = requireLocale();
  let sheet: string;
  try {
    sheet = decodeSheet(readFileSync(values.import));
  } catch (error) {
    fail((error as Error).message);
  }
  const result = importSheet(yamlText, messages, locale, sheet);
  report("Approved", result.approved);
  report("Corrected, still waiting for approval", result.corrected);
  reportReasons("Refused", result.refused);
  console.log(`${result.unchanged.length} rows unchanged.`);
  if (result.approved.length + result.corrected.length > 0) {
    write(
      result.yaml,
      `Imported ${result.approved.length} approvals and ${result.corrected.length} corrections`,
    );
  }
  if (Object.keys(result.refused).length > 0) process.exitCode = 1;
} else if (values.approve) {
  const locale = requireLocale();
  const result = approve(yamlText, messages, locale, selected());
  report("Approved", result.approved);
  for (const [key, reason] of Object.entries(result.skipped)) console.log(`  · ${key}: ${reason}`);
  reportReasons("Refused", result.refused);
  if (result.approved.length > 0)
    write(result.yaml, `Approved ${result.approved.length} ${locale} texts`);
  if (Object.keys(result.refused).length > 0) process.exitCode = 1;
} else if (values.reflag) {
  const locale = requireLocale();
  // The keys or --stale, as the usage says: given both, or --prefix (--list's), what
  // narrowed it was dropped and every stale text flagged (#250).
  if (values.prefix) fail("--reflag takes the keys or prefix.*, not --prefix");
  if (values.stale && positionals.length > 0) fail("--reflag takes --stale or the keys, not both");
  const keys = values.stale ? stale(messages, locale) : selected();
  const result = reflag(yamlText, messages, locale, keys);
  report("Flagged for review again", result.flagged);
  for (const [key, reason] of Object.entries(result.skipped)) console.log(`  · ${key}: ${reason}`);
  if (result.flagged.length > 0)
    write(result.yaml, `Flagged ${result.flagged.length} ${locale} texts`);
} else if (values.list) {
  const locales = values.locale ? [requireLocale()] : [...TRANSLATED_LOCALES];
  for (const locale of locales) {
    const keys = (values.stale ? stale(messages, locale) : sheetKeys(messages, locale, {})).filter(
      (key) => !values.prefix || key.startsWith(values.prefix),
    );
    console.log(`${locale}: ${keys.length} texts waiting for a native review`);
    for (const key of keys) {
      console.log(
        `  ${key}\n    en: ${messages[key]?.en}\n    ${locale}: ${messages[key]?.[locale]}`,
      );
    }
  }
} else {
  console.log(formatProgress(progress(messages), values.markdown));
  if (!values.markdown) {
    console.log(
      `\n${unreviewed(messages, "fi").length} fi and ${unreviewed(messages, "sv").length} sv texts are machine text. ` +
        "docs/i18n/translation-review-guide.md describes the review.",
    );
  }
}
