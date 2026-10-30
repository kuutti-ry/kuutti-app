import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Locales a message may carry. English is the source; en-XA is generated. */
export const TRANSLATED_LOCALES = ["fi", "sv"] as const;
export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];

/** A command-line value that names a translated locale. */
export const isTranslatedLocale = (value: string | undefined): value is TranslatedLocale =>
  (TRANSLATED_LOCALES as readonly string[]).includes(value ?? "");

/**
 * The field that holds Stadin slangi (fi-x-stadi, FICTIONAL_LOCALES, #521).
 * Optional on every key and no translated locale: a key without it is the
 * Finnish text, and the translator never fills it.
 */
export const SLANG = "slangi";

/** Every text a key may carry besides its English. */
export const TEXT_LOCALES = [...TRANSLATED_LOCALES, SLANG] as const;
export type TextLocale = (typeof TEXT_LOCALES)[number];

const KEY_PATTERN = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

const MachineFlags = z.strictObject({
  fi: z.boolean().optional(),
  sv: z.boolean().optional(),
  slangi: z.boolean().optional(),
});

// reviewHash(en, text): quoted in the file, since hex digits alone can read as a number.
const ReviewHash = z.string().regex(/^[0-9a-f]{16}$/, "a review hash is sixteen hex digits");
const ReviewHashes = z.strictObject({
  fi: ReviewHash.optional(),
  sv: ReviewHash.optional(),
  slangi: ReviewHash.optional(),
});

const Message = z.strictObject({
  en: z.string().min(1),
  description: z.string().min(1),
  fi: z.string().min(1).optional(),
  sv: z.string().min(1).optional(),
  slangi: z.string().min(1).optional(),
  /** Written by a machine or an agent; not yet read by a native speaker. */
  machine: MachineFlags.optional(),
  /** Approved by a native reviewer: the hash of en and this text at the time (#55). */
  reviewed: ReviewHashes.optional(),
  /** Characters the text may take where the room is fixed (a button in a row); no arguments. */
  max_length: z.int().positive().optional(),
  /** legal.* only: the consent version this wording belongs to (TD-17). */
  consent_version: z
    .string()
    .regex(/^[0-9A-Za-z._-]+$/, "a consent_version is letters, digits, dots and dashes")
    .optional(),
});
export type Message = z.infer<typeof Message>;
export type Messages = Record<string, Message>;

const File = z.record(z.string(), Message);

/** True for keys whose text is binding legal text: never machine-translated. */
export const isLegalKey = (key: string): boolean => key.startsWith("legal.");

// A backstop for the prefix rule: binding text filed under another name would
// be sent to the translator and could carry a machine flag.
const LEGAL_WORD = /(^|[._])(legal|consent|privacy|terms|police|traceability)([._]|$)/i;

/** True for keys of the English-only moderation panel (TD-17). */
export const isAdminKey = (key: string): boolean => key.startsWith("admin.");

// Where a joke is harmless (#521): the round, home, the profile editor, settings.
const SLANG_NAMESPACE = /^(round|home|profile|settings)\./;
// Inside them, what stays plain: what has to be understood the first time (a
// failure), consent and a person's data, their way out of danger or of a
// session, and the answers that say who somebody is.
const NEVER_SLANG =
  /failed|invalid|error|research|sensitive|export|support|session|logout|lock|report|option/i;

/** True for keys a `slangi:` text may stand on: i18n:check refuses one anywhere else. */
export const isSlangKey = (key: string): boolean =>
  SLANG_NAMESPACE.test(key) && !NEVER_SLANG.test(key);

/**
 * Parses and validates messages.yaml. Throws with every problem at once: a
 * file that does not validate never reaches the compiler.
 */
export function parseMessages(yamlText: string): Messages {
  const parsed = File.safeParse(parseYaml(yamlText));
  const problems: string[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

  for (const [key, message] of Object.entries(parsed.success ? parsed.data : {})) {
    if (!KEY_PATTERN.test(key)) {
      problems.push(`${key}: keys are dotted and semantic (profile.bio.required), never the text`);
    }
    if (!isLegalKey(key) && LEGAL_WORD.test(key)) {
      problems.push(
        `${key}: consent, privacy, terms and police-traceability texts live under legal.*`,
      );
    }
    if (isLegalKey(key)) {
      if (message.machine) problems.push(`${key}: legal text is never machine-translated`);
      // Its Finnish is the binding source, written by people, not a translation to approve.
      if (message.reviewed) problems.push(`${key}: legal text takes no review hash`);
      if (!message.consent_version) problems.push(`${key}: legal text needs a consent_version`);
    } else if (message.consent_version) {
      problems.push(`${key}: consent_version belongs to legal.* keys only`);
    }
    for (const locale of TEXT_LOCALES) {
      if (message.machine?.[locale] && !message[locale]) {
        problems.push(`${key}: machine.${locale} is set but there is no ${locale} text`);
      }
      if (message.reviewed?.[locale] && !message[locale]) {
        problems.push(`${key}: reviewed.${locale} is set but there is no ${locale} text`);
      }
      if (message.machine?.[locale] && message.reviewed?.[locale]) {
        problems.push(`${key}: ${locale} is both machine and reviewed; a review replaces the flag`);
      }
    }
  }

  if (problems.length > 0)
    throw new Error(`messages.yaml is not valid:\n  ${problems.join("\n  ")}`);
  if (!parsed.success) throw new Error("messages.yaml is not valid");
  return parsed.data;
}
