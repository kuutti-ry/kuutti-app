import { isMap, parseDocument, Scalar, YAMLMap } from "yaml";
import { checkMessages } from "./check.ts";
import { isStale, reviewHash } from "./review-hash.ts";
import {
  isAdminKey,
  isLegalKey,
  type Message,
  type Messages,
  TRANSLATED_LOCALES,
  type TranslatedLocale,
} from "./schema.ts";
import { flagMachine, rejectionReason, writeText } from "./translate.ts";

/**
 * The native review of machine text (#55, TD-17): what is left to review,
 * approving it, and the review sheet a reviewer fills in without git. A review
 * writes `reviewed: { <locale>: <hash> }` in place of the machine flag; the
 * hash covers the English and the approved text, so an edit to either shows
 * again as a text nobody has reviewed (check.ts). legal.* is written by people
 * and versioned, admin.* is English only: neither passes through here.
 */

type ReviewState = "reviewed" | "machine" | "stale" | "missing";

/** Where one text stands, or undefined for keys that are never reviewed here. */
function stateOf(key: string, message: Message, locale: TranslatedLocale): ReviewState | undefined {
  if (isLegalKey(key) || isAdminKey(key)) return undefined;
  if (message[locale] === undefined) return "missing";
  // A text with neither mark fails the check; here it waits for a reviewer like machine text.
  if (message.machine?.[locale] || !message.reviewed?.[locale]) return "machine";
  if (isStale(message, locale)) return "stale";
  return "reviewed";
}

/** A key's message, never one inherited from Object.prototype ("__proto__" in a sheet). */
const own = (messages: Messages, key: string): Message | undefined =>
  Object.hasOwn(messages, key) ? messages[key] : undefined;

/** A report entry that holds even for a key named like an Object.prototype member. */
function note(record: Record<string, string>, key: string, reason: string): void {
  Object.defineProperty(record, key, {
    value: reason,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** A text waits for a reviewer when it is machine text or its review went stale. */
const pending = (state: ReviewState | undefined): boolean =>
  state === "machine" || state === "stale";

/**
 * Keys named by selectors: an exact key, or `prefix.*` for every key under a
 * prefix. A selector that names nothing is reported, never silently skipped.
 */
export function selectKeys(
  messages: Messages,
  selectors: readonly string[],
): { keys: string[]; unknown: string[] } {
  const keys = new Set<string>();
  const unknown: string[] = [];
  for (const selector of selectors) {
    const matches = selector.endsWith(".*")
      ? Object.keys(messages).filter((key) => key.startsWith(selector.slice(0, -1)))
      : Object.hasOwn(messages, selector)
        ? [selector]
        : [];
    if (matches.length === 0) unknown.push(selector);
    for (const key of matches) keys.add(key);
  }
  return { keys: [...keys], unknown };
}

export type ProgressRow = { namespace: string } & Record<
  TranslatedLocale,
  Record<ReviewState, number>
>;

const emptyCounts = (): Record<ReviewState, number> => ({
  reviewed: 0,
  machine: 0,
  stale: 0,
  missing: 0,
});

/** How far the review has come, per namespace (the key's first segment) and locale. */
export function progress(messages: Messages): ProgressRow[] {
  const rows = new Map<string, ProgressRow>();
  for (const [key, message] of Object.entries(messages)) {
    const namespace = key.split(".")[0] ?? key;
    for (const locale of TRANSLATED_LOCALES) {
      const state = stateOf(key, message, locale);
      if (!state) continue;
      const row = rows.get(namespace) ?? { namespace, fi: emptyCounts(), sv: emptyCounts() };
      row[locale][state] += 1;
      rows.set(namespace, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/** The progress as a table: plain text for a terminal, Markdown for a CI job summary. */
export function formatProgress(rows: ProgressRow[], markdown: boolean): string {
  const total: ProgressRow = { namespace: "total", fi: emptyCounts(), sv: emptyCounts() };
  for (const row of rows)
    for (const locale of TRANSLATED_LOCALES)
      for (const state of Object.keys(emptyCounts()) as ReviewState[])
        total[locale][state] += row[locale][state];
  const cells = (row: ProgressRow): string[] => [
    row.namespace,
    ...TRANSLATED_LOCALES.flatMap((locale) => [
      `${row[locale].reviewed}`,
      `${row[locale].machine}`,
      `${row[locale].stale}`,
    ]),
  ];
  const header = [
    "namespace",
    "fi reviewed",
    "fi machine",
    "fi stale",
    "sv reviewed",
    "sv machine",
    "sv stale",
  ];
  const body = [...rows, total].map(cells);
  if (markdown) {
    return [
      "### Native review of machine text (`pnpm i18n:review`)",
      "",
      `| ${header.join(" | ")} |`,
      `| ${header.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
      "",
    ].join("\n");
  }
  const widths = header.map((title, i) =>
    Math.max(title.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("  ");
  return [line(header), ...body.map(line)].join("\n");
}

/** Why a key never passes through the review, or undefined for a translation that does. */
function notReviewedHere(key: string): string | undefined {
  if (isLegalKey(key)) {
    return "legal text is written by people and versioned by consent_version, not reviewed here";
  }
  if (isAdminKey(key)) return "admin.* is English only";
  return undefined;
}

/**
 * Why `text` cannot be the approved `locale` text of `key`, or undefined when
 * it can. The caller has refused legal.* and admin.* keys (notReviewedHere).
 */
function approvalProblem(
  key: string,
  message: Message,
  locale: TranslatedLocale,
  text: string,
): string | undefined {
  const reason = rejectionReason(message.en, text, locale, message.max_length);
  if (reason) return reason;
  // The file's own rules over the approved text: arguments, plural and select
  // branches, inflection, max_length.
  const machine = { ...message.machine };
  delete machine[locale];
  const candidate: Message = {
    ...message,
    [locale]: text,
    machine,
    reviewed: { ...message.reviewed, [locale]: reviewHash(message.en, text) },
  };
  const errors = checkMessages({ [key]: candidate }, { release: false }).errors.filter((e) =>
    e.startsWith(`${key}: ${locale} `),
  );
  return errors[0]?.slice(key.length + 2);
}

/** Writes an approval: the flag goes, the hash of en and the text comes in its place. */
function markReviewed(entry: YAMLMap, locale: TranslatedLocale, en: string, text: string): void {
  const machine = entry.get("machine");
  if (isMap(machine)) {
    machine.delete(locale);
    if (machine.items.length === 0) entry.delete("machine");
  }
  const hash = new Scalar(reviewHash(en, text));
  hash.type = "QUOTE_DOUBLE";
  const reviewed = entry.get("reviewed");
  if (isMap(reviewed)) {
    reviewed.set(locale, hash);
  } else {
    const hashes = new YAMLMap();
    hashes.flow = true;
    hashes.set(locale, hash);
    entry.set("reviewed", hashes);
  }
}

function entryOf(document: ReturnType<typeof parseDocument>, key: string): YAMLMap {
  const entry = document.get(key);
  if (!isMap(entry)) throw new Error(`${key} is not a mapping in messages.yaml`);
  return entry;
}

export type ApproveResult = {
  yaml: string;
  approved: string[];
  skipped: Record<string, string>;
  refused: Record<string, string>;
};

/**
 * `--approve`: the native reviewer has read these texts and they stand as they
 * are. Only machine or stale text is approved; a text that breaks a rule is
 * refused with the reason, and nothing else in the file changes.
 */
export function approve(
  yamlText: string,
  messages: Messages,
  locale: TranslatedLocale,
  keys: readonly string[],
): ApproveResult {
  const document = parseDocument(yamlText);
  const result: ApproveResult = { yaml: yamlText, approved: [], skipped: {}, refused: {} };
  for (const key of keys) {
    const message = own(messages, key);
    if (!message) continue;
    const state = stateOf(key, message, locale);
    const text = message[locale];
    const outside = notReviewedHere(key);
    if (outside) {
      note(result.refused, key, outside);
      continue;
    }
    if (state === "reviewed") {
      note(result.skipped, key, "already reviewed");
      continue;
    }
    if (state === "missing" || text === undefined) {
      note(result.refused, key, `no ${locale} text to approve`);
      continue;
    }
    const problem = approvalProblem(key, message, locale, text);
    if (problem) {
      note(result.refused, key, problem);
      continue;
    }
    markReviewed(entryOf(document, key), locale, message.en, text);
    result.approved.push(key);
  }
  result.yaml = document.toString({ lineWidth: 0 });
  return result;
}

export type ReflagResult = { yaml: string; flagged: string[]; skipped: Record<string, string> };

/**
 * `--reflag`: a reviewed text goes back to machine text, because its English
 * or its translation changed and a reviewer has to read it again. Anyone may
 * do this, an agent included: it only ever asks for more review.
 */
export function reflag(
  yamlText: string,
  messages: Messages,
  locale: TranslatedLocale,
  keys: readonly string[],
): ReflagResult {
  const document = parseDocument(yamlText);
  const result: ReflagResult = { yaml: yamlText, flagged: [], skipped: {} };
  for (const key of keys) {
    const message = own(messages, key);
    if (!message) continue;
    const state = stateOf(key, message, locale);
    if (state !== "reviewed" && state !== "stale") {
      note(result.skipped, key, state ? `${state}, nothing to flag` : "never reviewed here");
      continue;
    }
    flagMachine(entryOf(document, key), locale);
    result.flagged.push(key);
  }
  result.yaml = document.toString({ lineWidth: 0 });
  return result;
}

// The review sheet: tab-separated text that Google Sheets, Excel and Numbers
// open and save. The reviewer edits the translation and the approve column; the
// fingerprint is the review hash of the text as it was exported, so an import
// refuses a row whose English or translation changed in the meantime.
const BOM = "﻿";
const APPROVE = /^(x|yes|y|ok|✓|✔|1|true|kyllä|k|ja|j)$/i;
const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

// A spreadsheet runs a cell that starts with one of these as a formula, quoted
// or not. Machine text is data from outside, so such a cell is written with a
// space in front, which makes it text; the import trims it away again.
const FORMULA_START = /^[=+\-@]/;

/** One cell of a tab-separated line, quoted the way spreadsheets quote. */
export function tsvCell(text: string): string {
  if (/[\t\r\n]/.test(text))
    throw new Error(`a sheet cell cannot hold a tab or a line break: ${JSON.stringify(text)}`);
  const safe = FORMULA_START.test(text) ? ` ${text}` : text;
  return safe !== text || /^"|"$/.test(text) || text.includes('"')
    ? `"${safe.replace(/"/g, '""')}"`
    : text;
}

export function parseTsvCell(cell: string): string {
  const trimmed = cell.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"').trim()
    : trimmed;
}

/**
 * The bytes of a returned sheet as text, or an error a reviewer can act on.
 * Strict on purpose: a lenient decoder turns the bytes of a sheet saved in a
 * legacy code page (Excel's default for tab-delimited text) into U+FFFD, and
 * "N\uFFFDkemiin" would then be imported, even approved, as if it were Finnish.
 */
export function decodeSheet(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("the sheet is not UTF-8 text; save it as tab-separated values (UTF-8)");
  }
}

const sheetColumns = (locale: TranslatedLocale): string[] => [
  "key",
  "where it shows",
  "en",
  locale,
  "approve",
  "note",
  "fingerprint",
];

function noteFor(message: Message, locale: TranslatedLocale, state: ReviewState): string {
  const notes: string[] = [];
  if (state === "stale") notes.push("changed since its last review");
  if (message.max_length !== undefined) notes.push(`at most ${message.max_length} characters`);
  const text = message[locale] ?? "";
  if (message.en.length <= 20 && text.length > message.en.length * 1.8) {
    notes.push(`${(text.length / message.en.length).toFixed(1)}× the English: check it fits`);
  }
  return notes.join("; ");
}

export type SheetOptions = { prefix?: string; all?: boolean };

/** The texts a sheet or a list covers: machine or stale by default, every translation with `all`. */
export function sheetKeys(
  messages: Messages,
  locale: TranslatedLocale,
  options: SheetOptions,
): string[] {
  return Object.entries(messages)
    .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
    .filter(([key, message]) => {
      const state = stateOf(key, message, locale);
      return options.all ? state !== undefined && state !== "missing" : pending(state);
    })
    .map(([key]) => key);
}

/** `--export tsv|md`: a sheet for the reviewer (tsv), or a table to read in a pull request (md). */
export function exportSheet(
  messages: Messages,
  locale: TranslatedLocale,
  format: "tsv" | "md",
  options: SheetOptions = {},
): string {
  const keys = sheetKeys(messages, locale, options);
  const rows = keys.map((key) => {
    const message = own(messages, key) as Message;
    const text = message[locale] ?? "";
    const state = stateOf(key, message, locale) ?? "machine";
    return {
      key,
      where: flatten(message.description),
      en: flatten(message.en),
      text,
      note: noteFor(message, locale, state),
      fingerprint: reviewHash(message.en, text),
    };
  });
  if (format === "md") {
    // Backslashes first: Markdown reads one before punctuation as an escape
    // and drops it. Then the pipes, whose escape must stay single.
    const md = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
    return [
      `| key | where it shows | en | ${locale} | note |`,
      "| --- | --- | --- | --- | --- |",
      ...rows.map(
        (r) => `| \`${r.key}\` | ${md(r.where)} | ${md(r.en)} | ${md(r.text)} | ${md(r.note)} |`,
      ),
      "",
    ].join("\n");
  }
  const lines = [
    sheetColumns(locale),
    ...rows.map((r) => [r.key, r.where, r.en, r.text, "", r.note, r.fingerprint]),
  ].map((cells) => cells.map(tsvCell).join("\t"));
  return `${BOM}${lines.join("\n")}\n`;
}

export type ImportResult = {
  yaml: string;
  approved: string[];
  corrected: string[];
  unchanged: string[];
  refused: Record<string, string>;
};

/**
 * `--import`: applies a sheet the reviewer returned. A row marked approved is
 * written with its (possibly corrected) text and a review hash; a corrected row
 * without the mark keeps its text as machine text; a row whose fingerprint no
 * longer matches the file is refused, since the reviewer read another text.
 */
export function importSheet(
  yamlText: string,
  messages: Messages,
  locale: TranslatedLocale,
  sheet: string,
): ImportResult {
  if (sheet.includes("\u0000")) {
    throw new Error("the sheet is not UTF-8 text; save it as tab-separated values (UTF-8)");
  }
  const lines = sheet
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const header = (lines.shift() ?? "").split("\t").map((cell) => parseTsvCell(cell).toLowerCase());
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`the sheet has no "${name}" column; export a new one`);
    return index;
  };
  const at = {
    key: column("key"),
    en: column("en"),
    text: column(locale),
    approve: column("approve"),
    fingerprint: column("fingerprint"),
  };

  const document = parseDocument(yamlText);
  const result: ImportResult = {
    yaml: yamlText,
    approved: [],
    corrected: [],
    unchanged: [],
    refused: {},
  };
  for (const line of lines) {
    const cells = line.split("\t").map(parseTsvCell);
    const key = cells[at.key] ?? "";
    if (!key) continue;
    const message = own(messages, key);
    if (!message) {
      note(result.refused, key, "not in messages.yaml");
      continue;
    }
    const current = message[locale];
    const outside = notReviewedHere(key);
    if (outside || current === undefined) {
      note(result.refused, key, outside ?? `no ${locale} text in messages.yaml`);
      continue;
    }
    if ((cells[at.fingerprint] ?? "") !== reviewHash(message.en, current)) {
      note(
        result.refused,
        key,
        "changed in the repository since the sheet was exported; export it again",
      );
      continue;
    }
    // The fingerprint says the file has not moved; this says the reviewer read
    // the file's English and not an edited cell.
    if ((cells[at.en] ?? "") !== flatten(message.en)) {
      note(
        result.refused,
        key,
        "the English in the sheet is not the English in the repository; export it again",
      );
      continue;
    }
    const text = cells[at.text] ?? "";
    const approved = APPROVE.test(cells[at.approve] ?? "");
    const changed = text !== current.trim();
    if (!text) {
      note(result.refused, key, `the ${locale} cell is empty`);
      continue;
    }
    if (approved) {
      const problem = approvalProblem(key, message, locale, text);
      if (problem) {
        note(result.refused, key, problem);
        continue;
      }
      const entry = entryOf(document, key);
      if (changed) writeText(entry, locale, text);
      markReviewed(entry, locale, message.en, text);
      result.approved.push(key);
    } else if (changed) {
      const problem = rejectionReason(message.en, text, locale, message.max_length);
      if (problem) {
        note(result.refused, key, problem);
        continue;
      }
      const entry = entryOf(document, key);
      writeText(entry, locale, text);
      flagMachine(entry, locale);
      result.corrected.push(key);
    } else {
      result.unchanged.push(key);
    }
  }
  result.yaml = document.toString({ lineWidth: 0 });
  return result;
}

/**
 * Keys whose review is new since `before` (another version of messages.yaml):
 * CI names them on the pull request, so an approval nobody asked for shows.
 */
export function newlyReviewed(
  before: Messages,
  after: Messages,
): Record<TranslatedLocale, string[]> {
  const found: Record<TranslatedLocale, string[]> = { fi: [], sv: [] };
  for (const [key, message] of Object.entries(after)) {
    const earlier = own(before, key);
    for (const locale of TRANSLATED_LOCALES) {
      const hash = message.reviewed?.[locale];
      // A new hash, or a reviewed text whose wording moved under an unchanged one.
      const moved =
        earlier?.reviewed?.[locale] !== hash ||
        earlier?.en !== message.en ||
        earlier?.[locale] !== message[locale];
      if (hash && moved) found[locale].push(key);
    }
  }
  return found;
}
