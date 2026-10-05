import { checkCharacter } from "../lib/hetu-format.ts";

/**
 * The people of the mock bank (#73, ADR-014): twelve named persons the local
 * identity provider can log in as with one tap, so that a demo or a test of
 * the first ten minutes does not start with typing claims into a form. They
 * exist at the mock bank only. The whole product path runs for them as for
 * anybody: the OIDC exchange, the parsing of the code, the HMAC, the age rule,
 * the re-registration rule. Nothing in the API or the app knows their names.
 *
 * Their codes are artificial: the individual number is in 900 to 999, which
 * the population register does not give to a person (rule 1 is about real
 * codes). `personaHetu` refuses any other number.
 *
 * Not exported from the package's index, on purpose: the API imports
 * `@kuutti/db`, and nothing of the personas belongs on its import graph. The
 * page generator, the flow check and the tests import this file by its path.
 */

/** Born on a fixed day: the same code, and so the same identity, for ever. */
export type FixedBirth = { year: number; month: number; day: number };

/**
 * Born relative to the day of the login: the first day of the month that lies
 * `months` before the current one, `years` before this year. The persona is
 * the same age whenever the demo runs, and a different identity as the months
 * pass, which is why none of these carries a history.
 */
export type RelativeBirth = { yearsAgo: number; monthsAgo: number };

export type DemoPersona = {
  /** The name typed at the bank, and the `sub` of the token. */
  key: string;
  /** What the bank says the person is called. The product never stores it (rule 3). */
  given: string;
  family: string;
  born: FixedBirth | RelativeBirth;
  /** 900 to 999: artificial, not given to a person by the population register. */
  individual: number;
  group: "walkthrough" | "history" | "ages";
  /** What the persona is for, shown under the name. */
  note: string;
};

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    key: "aino",
    given: "Aino",
    family: "Virtanen",
    born: { year: 1997, month: 3, day: 14 },
    individual: 901,
    group: "walkthrough",
    note: "The walkthrough: registers, onboards, fills in a profile, uploads photos.",
  },
  {
    key: "mikael",
    given: "Mikael",
    family: "Lindqvist",
    born: { year: 1992, month: 8, day: 2 },
    individual: 902,
    group: "walkthrough",
    note: "A second newcomer, for the walkthrough in Swedish.",
  },
  {
    key: "sanna",
    given: "Sanna",
    family: "Korhonen",
    born: { year: 1989, month: 11, day: 23 },
    individual: 903,
    group: "history",
    note: "Onboarded, with a profile that lacks only its photos until the photo loader has run.",
  },
  {
    key: "onni",
    given: "Onni",
    family: "Mäkelä",
    born: { year: 1995, month: 5, day: 30 },
    individual: 904,
    group: "history",
    note: "Registered and never onboarded: the app starts at the first step.",
  },
  {
    key: "noa",
    given: "Noa",
    family: "Salmi",
    born: { year: 1999, month: 1, day: 9 },
    individual: 905,
    group: "history",
    note: "Onboarded, with a profile; one photo only once the photo loader has run, so the profile says what is missing.",
  },
  {
    key: "kerttu",
    given: "Kerttu",
    family: "Åkerlund",
    born: { year: 1985, month: 6, day: 17 },
    individual: 906,
    group: "history",
    note: "Accepted an older wording of the terms: the app asks again.",
  },
  {
    key: "tapio",
    given: "Tapio",
    family: "Heikkinen",
    born: { year: 1978, month: 2, day: 5 },
    individual: 907,
    group: "history",
    note: "A banned identity: the login is refused.",
  },
  {
    key: "ilona",
    given: "Ilona",
    family: "Öhman",
    born: { year: 1993, month: 9, day: 27 },
    individual: 908,
    group: "history",
    note: "Deleted her account: refused until the waiting time is over.",
  },
  {
    key: "eetu",
    given: "Eetu",
    family: "Laine",
    born: { yearsAgo: 18, monthsAgo: 1 },
    individual: 909,
    group: "ages",
    note: "Turned 18 last month: the youngest who gets in.",
  },
  {
    key: "venla",
    given: "Venla",
    family: "Nieminen",
    born: { yearsAgo: 18, monthsAgo: 0 },
    individual: 910,
    group: "ages",
    note: "Turns 18 this month: refused until the last day of the month, since age is counted from the end of the birth month.",
  },
  {
    key: "lauri",
    given: "Lauri",
    family: "Hämäläinen",
    born: { yearsAgo: 17, monthsAgo: 1 },
    individual: 911,
    group: "ages",
    note: "17: refused.",
  },
  {
    key: "helmi",
    given: "Helmi",
    family: "Koskinen",
    born: { yearsAgo: 99, monthsAgo: 1 },
    individual: 912,
    group: "ages",
    note: "99: the upper end of the age window.",
  },
];

/** The FTN assurance level of Telia's pre-production and the bank as the broker names one (docs/vendors/telia.md). */
export const MOCK_BANK_ACR = "http://ftn.ficora.fi/2017/loatest2";
export const MOCK_BANK_AMR = "https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.mock.1";

const two = (n: number) => String(n).padStart(2, "0");

/** The day the persona was born, as seen on the UTC day of `at`. */
export function personaBirth(persona: DemoPersona, at: Date): FixedBirth {
  if ("year" in persona.born) return persona.born;
  // Months counted from year zero, so that January minus one is December of the year before.
  const months =
    (at.getUTCFullYear() - persona.born.yearsAgo) * 12 + at.getUTCMonth() - persona.born.monthsAgo;
  return { year: Math.floor(months / 12), month: (months % 12) + 1, day: 1 };
}

export const ARTIFICIAL_MIN = 900;
export const ARTIFICIAL_MAX = 999;

/** A persona whose code could be a person's is refused, wherever it comes from. */
export function assertArtificial(persona: DemoPersona): void {
  const n = persona.individual;
  if (!Number.isInteger(n) || n < ARTIFICIAL_MIN || n > ARTIFICIAL_MAX) {
    throw new Error(
      `persona ${persona.key}: individual number ${n} is outside ${ARTIFICIAL_MIN} to ${ARTIFICIAL_MAX}`,
    );
  }
}

/** The persona's artificial code on the day of `at`. */
export function personaHetu(persona: DemoPersona, at: Date): string {
  assertArtificial(persona);
  const born = personaBirth(persona, at);
  const sign = born.year < 1900 ? "+" : born.year < 2000 ? "-" : "A";
  const ddmmyy = `${two(born.day)}${two(born.month)}${two(born.year % 100)}`;
  const individual = String(persona.individual);
  return `${ddmmyy}${sign}${individual}${checkCharacter(ddmmyy, individual)}`;
}

/** Whether the persona's code, and with it the identity, is the same on every day. */
export const hasFixedIdentity = (persona: DemoPersona): boolean => "year" in persona.born;

/**
 * The claims the mock bank puts in the ID token for the persona: the names
 * and shapes the real broker uses (docs/vendors/telia.md, guide 2.6.4).
 */
export function personaClaims(persona: DemoPersona, at: Date): Record<string, unknown> {
  const born = personaBirth(persona, at);
  return {
    "urn:oid:1.2.246.21": personaHetu(persona, at),
    "urn:oid:1.3.6.1.5.5.7.9.1": `${born.year}-${two(born.month)}-${two(born.day)}`,
    "urn:oid:2.5.4.4": persona.family,
    "urn:oid:1.2.246.575.1.14": persona.given,
    "urn:oid:2.16.840.1.113730.3.1.241": `${persona.given} ${persona.family}`,
    acr: MOCK_BANK_ACR,
    amr: [MOCK_BANK_AMR],
  };
}
