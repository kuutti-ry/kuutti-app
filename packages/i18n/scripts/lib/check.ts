import { RELEASED_LOCALES } from "../../src/locales.ts";
import {
  type ArgumentType,
  argumentsOf,
  branchProblems,
  inflectionProblems,
  tagsOf,
} from "./icu.ts";
import { isStale } from "./review-hash.ts";
import {
  isAdminKey,
  isLegalKey,
  isSlangKey,
  type Message,
  type Messages,
  SLANG,
  TEXT_LOCALES,
  TRANSLATED_LOCALES,
  type TranslatedLocale,
} from "./schema.ts";
import { graphemeLength, untrustedTextProblem } from "./translate.ts";

// i18next reads these from the same object as the ICU arguments: a message
// that declared one would let a caller's value choose the language, the
// namespace or the key variant instead of filling a gap in the text.
const RESERVED_ARGUMENTS = new Set([
  "lng",
  "lngs",
  "fallbackLng",
  "ns",
  "context",
  "count",
  "ordinal",
  "defaultValue",
  "replace",
  "interpolation",
  "keySeparator",
  "nsSeparator",
  "returnObjects",
  "returnDetails",
  "joinArrays",
  "postProcess",
]);

/** The translated locales a release ships: a store build and the production API offer only these. */
const RELEASED_TRANSLATIONS: readonly string[] = TRANSLATED_LOCALES.filter((locale) =>
  (RELEASED_LOCALES as readonly string[]).includes(locale),
);

// A wording the association's counsel has not yet replaced (#46, ADR-010).
const DRAFT_VERSION = /draft/i;
// Anywhere in the wording, as its own word, however it is capitalised.
const DRAFT_TEXT = /(?<![\p{L}])(DRAFT|LUONNOS|UTKAST)(?![\p{L}])/iu;

export type CheckResult = { errors: string[]; warnings: string[] };

function sameArguments(a: Record<string, ArgumentType>, b: Record<string, ArgumentType>): boolean {
  const names = Object.keys(a).sort();
  return (
    names.join() === Object.keys(b).sort().join() && names.every((name) => a[name] === b[name])
  );
}

/** True for legal text still in draft: its version or its wording says so. */
export function isDraftLegal(message: Message): boolean {
  return (
    DRAFT_VERSION.test(message.consent_version ?? "") ||
    [message.en, message.fi, message.sv].some((text) => text !== undefined && DRAFT_TEXT.test(text))
  );
}

/**
 * The rules of rules/i18n.md over a validated file: Finnish is required
 * (missing fi fails, missing sv warns; admin.* is English only), every locale
 * is valid ICU with the arguments and the plural and select branches it needs,
 * no dynamic value is inflected, and every translation is either flagged as
 * machine text or carries a native review that still matches it (#55). Slang
 * is never missing and stands only where a joke is harmless (#521). On a
 * release, no text in a released locale is machine text, and no legal text is
 * a draft.
 */
export function checkMessages(messages: Messages, options: { release: boolean }): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [key, message] of Object.entries(messages)) {
    let source: Record<string, ArgumentType>;
    try {
      source = argumentsOf(message.en);
    } catch (error) {
      errors.push(`${key}: en is not valid ICU (${(error as Error).message})`);
      continue;
    }
    for (const problem of inflectionProblems(message.en, "en"))
      errors.push(`${key}: en ${problem}`);
    const invisible = untrustedTextProblem(message.en, message.en);
    if (invisible) errors.push(`${key}: en ${invisible}`);
    for (const problem of branchProblems(message.en, message.en, "en"))
      errors.push(`${key}: en ${problem}`);
    for (const name of Object.keys(source)) {
      if (RESERVED_ARGUMENTS.has(name)) {
        errors.push(
          `${key}: {${name}} is an i18next option name; name the argument after what it counts or holds ({likes}, {seconds})`,
        );
      }
    }
    if (message.max_length !== undefined && Object.keys(source).length > 0) {
      errors.push(`${key}: max_length fits a text without arguments only`);
    } else if (
      message.max_length !== undefined &&
      graphemeLength(message.en) > message.max_length
    ) {
      errors.push(`${key}: en is over its max_length of ${message.max_length}`);
    }

    for (const locale of TEXT_LOCALES) {
      const text = message[locale];
      if (text === undefined) {
        if (locale === SLANG || isAdminKey(key)) continue;
        if (locale === "fi") errors.push(`${key}: no fi text (Finnish is required)`);
        else if (options.release && RELEASED_TRANSLATIONS.includes(locale)) {
          errors.push(`${key}: no ${locale} text, and ${locale} is a released language`);
        } else if (isLegalKey(key)) {
          warnings.push(
            `${key}: no ${locale} text (legal text is written by a person, never by the translator)`,
          );
        } else warnings.push(`${key}: no ${locale} text`);
        continue;
      }
      if (locale === SLANG && !isSlangKey(key)) {
        errors.push(`${key}: slangi stands only where a joke is harmless (isSlangKey)`);
      }
      try {
        if (!sameArguments(source, argumentsOf(text))) {
          errors.push(`${key}: ${locale} does not use the same arguments as en`);
        }
        // The tags are markup the app renders: a translation keeps exactly the English's.
        if ([...tagsOf(text)].sort().join() !== [...tagsOf(message.en)].sort().join()) {
          errors.push(`${key}: ${locale} does not keep the tags of en`);
        }
        for (const problem of inflectionProblems(text, locale)) {
          errors.push(`${key}: ${locale} ${problem}`);
        }
        // Slang's plurals are Finnish's; Intl has never heard of it.
        for (const problem of branchProblems(message.en, text, locale === SLANG ? "fi" : locale)) {
          errors.push(`${key}: ${locale} ${problem}`);
        }
      } catch (error) {
        errors.push(`${key}: ${locale} is not valid ICU (${(error as Error).message})`);
      }
      if (message.max_length !== undefined && graphemeLength(text) > message.max_length) {
        errors.push(`${key}: ${locale} is over its max_length of ${message.max_length}`);
      }
      // What the translator's output is held to holds for every text in the file.
      const untrusted = untrustedTextProblem(message.en, text);
      if (untrusted) errors.push(`${key}: ${locale} ${untrusted}`);

      // legal.* Finnish is the binding source, versioned by consent_version instead.
      if (isLegalKey(key)) continue;
      if (!message.machine?.[locale] && !message.reviewed?.[locale]) {
        errors.push(
          `${key}: ${locale} carries neither machine: nor reviewed:; new text carries machine: { ${locale}: true } until a native reviewer approves it (pnpm i18n:review)`,
        );
      } else if (isStale(message, locale)) {
        errors.push(
          `${key}: ${locale} changed since its native review (the English or the ${locale} text); flag it for review again with pnpm i18n:review --reflag --locale ${locale} ${key}`,
        );
      }
      if (options.release && RELEASED_TRANSLATIONS.includes(locale) && message.machine?.[locale]) {
        errors.push(
          `${key}: ${locale} is still machine-translated; a release needs a native review`,
        );
      }
    }

    if (options.release && isLegalKey(key) && isDraftLegal(message)) {
      errors.push(
        `${key}: legal text is still a draft (${message.consent_version}); a release needs the final wording`,
      );
    }
  }
  return { errors, warnings };
}

/** Keys whose text in `locale` a native reviewer has not cleared yet. */
export function unreviewed(messages: Messages, locale: TranslatedLocale): string[] {
  return Object.entries(messages)
    .filter(([, message]) => message.machine?.[locale])
    .map(([key]) => key);
}

/** Keys whose review in `locale` no longer matches the text: they need reviewing again. */
export function stale(messages: Messages, locale: TranslatedLocale): string[] {
  return Object.entries(messages)
    .filter(([, message]) => isStale(message, locale))
    .map(([key]) => key);
}
