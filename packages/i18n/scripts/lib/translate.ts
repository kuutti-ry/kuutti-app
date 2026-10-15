import { isMap, parseDocument, Scalar, YAMLMap } from "yaml";
import { argumentsOf, branchProblems, inflectionProblems, tagsOf } from "./icu.ts";
import { isStale } from "./review-hash.ts";
import { isAdminKey, isLegalKey, type Messages, type TranslatedLocale } from "./schema.ts";

/**
 * One message as the translator sees it: the key, the English source, its
 * description, and the room it has where that is fixed.
 */
export type TranslationItem = {
  key: string;
  en: string;
  description: string;
  max_length?: number;
};

/** An approved translation from the same part of the app, shown to the translator as an example. */
export type TranslationExample = { en: string; text: string };

/**
 * What a translator is given besides the messages: the glossary, the tone
 * guide and approved examples. Message text only: no user data ever goes to a
 * translation provider (CLAUDE.md, Security defaults).
 */
export type TranslationContext = {
  glossary: string;
  tone: string;
  examples?: TranslationExample[];
};

/**
 * Whatever turns English messages into `locale`. The CLI wires the Anthropic
 * API in (anthropic-translator.ts); tests hand in a function.
 */
export type Translator = (
  locale: TranslatedLocale,
  items: TranslationItem[],
  context: TranslationContext,
) => Promise<Record<string, string>>;

/**
 * Which texts go to the translator (#55):
 * - missing: keys with no text in the locale yet (the default);
 * - retranslate: machine text, never read by a reviewer, written again;
 * - stale: reviewed text whose English or translation changed since its review.
 * English-only (admin.*) and legal keys never go.
 */
type SelectionMode = "missing" | "retranslate" | "stale";

export type Selection = { mode: SelectionMode; keys?: readonly string[]; prefix?: string };

const toItem = (key: string, message: Messages[string]): TranslationItem => ({
  key,
  en: message.en,
  description: message.description,
  ...(message.max_length !== undefined ? { max_length: message.max_length } : {}),
});

/** The texts a translation run covers, in file order. */
export function selectForTranslation(
  messages: Messages,
  locale: TranslatedLocale,
  selection: Selection,
): TranslationItem[] {
  return Object.entries(messages)
    .filter(([key]) => !isAdminKey(key) && !isLegalKey(key))
    .filter(([key]) => !selection.prefix || key.startsWith(selection.prefix))
    .filter(([key]) => !selection.keys || selection.keys.includes(key))
    .filter(([, message]) => {
      const text = message[locale];
      if (selection.mode === "missing") return text === undefined;
      if (selection.mode === "retranslate") {
        return text !== undefined && message.machine?.[locale] === true;
      }
      return isStale(message, locale);
    })
    .map(([key, message]) => toItem(key, message));
}

/** Keys that need a machine translation: no text yet, and not English-only or legal. */
export function missingTranslations(
  messages: Messages,
  locale: TranslatedLocale,
): TranslationItem[] {
  return selectForTranslation(messages, locale, { mode: "missing" });
}

/** A request's worth of keys, all from one namespace (the key's first segment). */
export type Chunk = { namespace: string; items: TranslationItem[] };

/**
 * Splits a selection into requests of at most `size` keys, one namespace at a
 * time and in evenly sized parts, so that each request stays small enough to
 * answer in full and its examples come from the part of the app it covers.
 */
export function planChunks(items: readonly TranslationItem[], size: number): Chunk[] {
  const byNamespace = new Map<string, TranslationItem[]>();
  for (const item of items) {
    const namespace = item.key.split(".")[0] ?? item.key;
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), item]);
  }
  const chunks: Chunk[] = [];
  for (const [namespace, group] of byNamespace) {
    const parts = Math.ceil(group.length / size);
    const per = Math.ceil(group.length / parts);
    for (let i = 0; i < group.length; i += per) {
      chunks.push({ namespace, items: group.slice(i, i + per) });
    }
  }
  return chunks;
}

/**
 * Approved translations from the same namespace, as examples of the wording a
 * reviewer accepted: reviewed and still current, never machine text.
 */
export function reviewedExamples(
  messages: Messages,
  locale: TranslatedLocale,
  namespace: string,
  limit = 20,
): TranslationExample[] {
  return Object.entries(messages)
    .filter(([key]) => key.startsWith(`${namespace}.`) && !isAdminKey(key) && !isLegalKey(key))
    .flatMap(([, message]) => {
      const text = message[locale];
      const reviewed = message.reviewed?.[locale] !== undefined && !isStale(message, locale);
      return text !== undefined && reviewed ? [{ en: message.en, text }] : [];
    })
    .slice(0, limit);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Characters as a reader counts them (an emoji or a letter with its accent is one), for max_length. */
export const graphemeLength = (text: string): number => [...graphemes.segment(text)].length;

const MARKUP = /<\/?[a-z][^>]*>/i;
// Invisible or direction-changing characters, and line or paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// What a decoder leaves where the bytes were not the encoding it was told (a
// sheet saved as Windows-1252 and read as UTF-8): never part of a real text.
const REPLACEMENT = "\uFFFD";
// Contact details a translation must not add: a web address, an e-mail address,
// a phone number. On a dating app they are how a scam starts. The model is
// contactDetailsIn in apps/api/src/profile/text.ts (the plain-text rule of
// #47): this package cannot import from an app (rules/layout.md), so the
// patterns are kept alike by hand. Like there, the text is compatibility-
// normalised first (full-width and other look-alike digits and letters), a
// top-level domain is letters of any script, and a phone number is digits of
// any script. A false refusal (a date written out as 2026-09-27, "Valmis.Jatka"
// without its space) costs a rephrase; a false pass costs a person.
const DOMAIN =
  /(?<=^|[^\p{L}\p{N}.@-])\p{L}[\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu;
const PHONE = /\+?\p{Nd}[\p{Nd} \u00a0-]{6,}\p{Nd}/gu;
const LINK = /[\p{L}][\p{L}\p{N}+.-]*:\/\/[^\s<>"']+/gu;
const ADDRESS = /[\p{L}\p{N}._%+-]*@[\p{L}\p{N}._-]*/gu;
// A spreadsheet reads a cell that starts with = as a formula (review.ts, the sheet).
const FORMULA = /^\s*=/;

const found = (pattern: RegExp, text: string, normalise: (match: string) => string): Set<string> =>
  new Set([...text.matchAll(pattern)].map((match) => normalise(match[0])));

/** True when `text` carries a match of `pattern` that `en` does not: one more, or another one. */
function adds(
  pattern: RegExp,
  en: string,
  text: string,
  normalise: (match: string) => string,
): boolean {
  const source = found(pattern, en, normalise);
  return [...found(pattern, text, normalise)].some((match) => !source.has(match));
}

const lower = (match: string): string => match.toLowerCase().replace(/[.,;:!?)]+$/, "");
const digits = (match: string): string => match.replace(/\P{Nd}/gu, "");

/**
 * What a text must not carry that its English lacks: invisible characters,
 * a link, markup, contact details, the start of a spreadsheet formula. Each
 * link, address and number of the translation must be one the English has:
 * "the English has one too" would let hello@kuutti.app become another
 * address. Checked on translator output, on a reviewer's sheet and on the
 * file itself (#13, #55).
 */
export function untrustedTextProblem(en: string, text: string): string | undefined {
  if (INVISIBLE.test(text)) return "contains control, bidirectional or line-separator characters";
  if (text.includes(REPLACEMENT)) {
    return "contains a replacement character: the text was not read as UTF-8";
  }
  const plain = text.normalize("NFKC");
  const source = en.normalize("NFKC");
  if (adds(LINK, source, plain, lower)) return "contains a link the English source does not have";
  if (MARKUP.test(plain) && !MARKUP.test(source)) {
    return "contains markup the English source does not have";
  }
  if (adds(ADDRESS, source, plain, lower) || adds(DOMAIN, source, plain, lower)) {
    return "contains a web or e-mail address the English source does not have";
  }
  if (adds(PHONE, source, plain, digits)) {
    return "contains a phone number the English source does not have";
  }
  if (FORMULA.test(plain) && !FORMULA.test(source)) {
    return "starts with =, which a spreadsheet reads as a formula";
  }
  return undefined;
}

/**
 * Why a text cannot be written as `locale`'s, or undefined when it can. With
 * `maxLength` (the message's max_length) the room is checked too, so that the
 * translator's apply, its --compare and a reviewer's corrected row all refuse
 * the same texts.
 */
export function rejectionReason(
  en: string,
  text: string,
  locale: TranslatedLocale,
  maxLength?: number,
): string | undefined {
  if (text.trim().length === 0) return "empty";
  // Machine output is data from outside, and so is a reviewer's sheet.
  const untrusted = untrustedTextProblem(en, text);
  if (untrusted) return untrusted;
  if (maxLength !== undefined && graphemeLength(text.trim()) > maxLength) {
    return `is over its max_length of ${maxLength}`;
  }
  try {
    const source = argumentsOf(en);
    const target = argumentsOf(text);
    const same =
      Object.keys(source).sort().join() === Object.keys(target).sort().join() &&
      Object.keys(source).every((name) => source[name] === target[name]);
    if (!same) return "does not keep the ICU arguments of the English source";
    if ([...tagsOf(text)].sort().join() !== [...tagsOf(en)].sort().join()) {
      return "does not keep the tags of the English source";
    }
    const [problem] = [...inflectionProblems(text, locale), ...branchProblems(en, text, locale)];
    return problem;
  } catch (error) {
    return `not valid ICU (${(error as Error).message})`;
  }
}

export type ApplyResult = { yaml: string; written: string[]; rejected: Record<string, string> };

// ICU braces, a colon or a hash would each change a plain YAML scalar's meaning:
// such a text is written double-quoted, like the hand-written entries.
const NEEDS_QUOTES = /[{}:#]/;

/** Sets `locale`'s text of one entry, keeping the file's quoting style. */
export function writeText(entry: YAMLMap, locale: TranslatedLocale, text: string): void {
  const node = new Scalar(text.trim());
  if (NEEDS_QUOTES.test(node.value)) node.type = "QUOTE_DOUBLE";
  entry.set(locale, node);
}

/** Marks `locale`'s text as machine text awaiting a native review: `machine: { <locale>: true }`. */
export function flagMachine(entry: YAMLMap, locale: TranslatedLocale): void {
  const reviewed = entry.get("reviewed");
  if (isMap(reviewed)) {
    reviewed.delete(locale);
    if (reviewed.items.length === 0) entry.delete("reviewed");
  }
  const machine = entry.get("machine");
  if (isMap(machine)) {
    machine.set(locale, true);
    return;
  }
  const flags = new YAMLMap();
  flags.flow = true;
  flags.set(locale, true);
  entry.set("machine", flags);
}

/**
 * Writes accepted translations of `items` into the YAML text with
 * `machine: { <locale>: true }` (a stale review's hash goes), keeping every
 * comment, the key order and the other values as they are. A translation that
 * breaks the rules is reported and not written; one for a key outside `items`
 * is ignored.
 */
export function applyTranslations(
  yamlText: string,
  messages: Messages,
  locale: TranslatedLocale,
  translations: Record<string, string>,
  items: readonly TranslationItem[] = missingTranslations(messages, locale),
): ApplyResult {
  const document = parseDocument(yamlText);
  const written: string[] = [];
  const rejected: Record<string, string> = {};

  for (const item of items) {
    const text = translations[item.key];
    if (text === undefined) {
      rejected[item.key] = "the translator returned nothing for this key";
      continue;
    }
    const reason = rejectionReason(item.en, text, locale, item.max_length);
    if (reason) {
      rejected[item.key] = reason;
      continue;
    }
    const entry = document.get(item.key);
    if (!isMap(entry)) continue;
    writeText(entry, locale, text);
    flagMachine(entry, locale);
    written.push(item.key);
  }
  return { yaml: document.toString({ lineWidth: 0 }), written, rejected };
}
