import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { readPreference, writePreference } from "@/lib/preferences";
import { consentLocale, giveConsent } from "./onboarding/client";

/**
 * What a person answered on the screens before the bank login (#418,
 * ADR-010 §15): the versions of the terms and the privacy summary they
 * accepted, the research wording's version on a yes, and the language the
 * texts were shown in. Before the exchange there is no account to bind a
 * row to, so the answers wait in this process's memory and become rows right
 * after it. Lost with the process (Android may end it while the browser is
 * open), they are asked again on onboarding's welcome step.
 */
export type Agreements = {
  terms: string;
  privacy: string;
  /** The research wording's version on a yes; null on a no, which records and withdraws nothing. */
  research: string | null;
  locale: "fi" | "sv" | "en";
};

/**
 * How long held answers wait for their exchange: a bank login attempt's ten
 * minutes, as the pending login mark (src/lib/session.ts), counted from the
 * attempt. Older, they may be somebody else's who walked away from the phone.
 */
const HELD_FOR_MS = 10 * 60 * 1000;

/**
 * The answers, when they were given or their attempt started, and the
 * attempt they belong to: the challenge of the bank login they were carried
 * into, null until the bank is opened. Only that attempt's exchange posts them.
 */
let held: { agreements: Agreements; at: number; attempt: string | null } | null = null;

/** The held answers while they are fresh; stale ones are dropped. */
function fresh(): Agreements | null {
  if (held === null) return null;
  const age = Date.now() - held.at;
  if (age < 0 || age > HELD_FOR_MS) held = null;
  return held?.agreements ?? null;
}

/** The answers as this app's own wordings name them: the versions built in are what the person read (ADR-010 §4). */
export function agreementsOf(locale: string, research: boolean): Agreements {
  return {
    terms: CONSENT_VERSIONS.terms ?? "",
    privacy: CONSENT_VERSIONS.privacy ?? "",
    research: research ? (CONSENT_VERSIONS.research ?? "") : null,
    locale: consentLocale(locale),
  };
}

export function holdAgreements(agreements: Agreements): void {
  held = { agreements, at: Date.now(), attempt: null };
}

export function heldAgreements(): Agreements | null {
  return fresh();
}

/**
 * The answers go with the bank attempt about to start (its challenge), timed
 * from now. Answers already carried into another attempt are dropped and
 * false is answered: a second attempt is asked again, since the person at the
 * phone may not be the one who answered (#418).
 */
export function bindAgreements(attempt: string, at = Date.now()): boolean {
  const agreements = fresh();
  if (agreements === null || held === null) return false;
  if (held.attempt !== null && held.attempt !== attempt) {
    held = null;
    return false;
  }
  held = { agreements, at, attempt };
  return true;
}

/** The held answers, once, for the attempt they were carried into and no other. */
export function takeAgreements(attempt: string): Agreements | null {
  const agreements = fresh();
  const bound = held?.attempt ?? null;
  held = null;
  return bound === attempt ? agreements : null;
}

/** Answers not yet carried into a bank attempt end when the app leaves the screen: whoever comes back answers again. */
export function dropUnboundAgreements(): boolean {
  if (held === null || held.attempt !== null) return false;
  held = null;
  return true;
}

/**
 * A refused sign-in ends what was held for it: the next attempt asks again,
 * so whoever signs in next on this phone never inherits answers somebody
 * else gave (#418).
 */
export function dropAgreements(): void {
  held = null;
}

/**
 * Whether this phone has recorded the terms and the privacy summary as this
 * app words them, after an earlier bank login: then the screens before the
 * bank are not shown again (#418, the maintainer's proposal 2). A person on a
 * new phone, or after an update that changed a wording, sees them again.
 */
export async function agreedOnThisPhone(): Promise<boolean> {
  const stored = await readPreference("agreedVersions");
  if (stored === null) return false;
  try {
    const versions = JSON.parse(stored) as { terms?: unknown; privacy?: unknown } | null;
    return (
      versions?.terms === CONSENT_VERSIONS.terms && versions?.privacy === CONSENT_VERSIONS.privacy
    );
  } catch {
    return false;
  }
}

/** Remembered once the rows are there: answers that never landed are asked again, here or on the welcome step. */
export function rememberAgreed(): Promise<void> {
  return writePreference(
    "agreedVersions",
    JSON.stringify({ terms: CONSENT_VERSIONS.terms, privacy: CONSENT_VERSIONS.privacy }),
  );
}

/**
 * The answers become rows right after the exchange, through the same route
 * the welcome step uses: the API records a consent it already has once, and
 * a no posts nothing, so an account that says yes to research keeps it
 * (#418, proposal 3). A refusal (an app older than the API's wording, the
 * day's cap, no network) is left to the welcome step, which asks for the
 * terms and the privacy summary again; a research yes that did not land is
 * Settings' switch to give.
 */
export async function recordAgreements(agreements: Agreements): Promise<void> {
  try {
    await giveConsent("terms", agreements.terms, agreements.locale);
    await giveConsent("privacy", agreements.privacy, agreements.locale);
    await rememberAgreed();
  } catch {
    // The welcome step asks again.
  }
  if (agreements.research !== null) {
    await giveConsent("research", agreements.research, agreements.locale).catch(() => undefined);
  }
}
