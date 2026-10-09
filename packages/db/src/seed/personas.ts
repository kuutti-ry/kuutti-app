import { checkCharacter } from "@kuutti/tunnistus-oidc/hetu";

/**
 * The people of the mock bank (#73, #140, ADR-014): twelve named persons the
 * local identity provider can log in as with one tap, so that a demo or a
 * test of the first ten minutes does not start with typing claims into a
 * form. The whole product path runs for them as for anybody: the OIDC
 * exchange, the parsing of the code, the HMAC, the age rule, the
 * re-registration rule. Nothing in the API or the app knows their names.
 *
 * The eight born on a fixed day carry the codes of the test persons of
 * Telia's pre-production bed (#140, docs/vendors/telia.md 1.4): the mock bank
 * issues locally the very code a test bank returns on staging, so a persona
 * is one identity in each environment and a story given on staging is the
 * same person's. The bank's name for the person is in the claims, as the real
 * broker sends it, and is stored nowhere; what the app calls the persona is
 * the display name the story gives.
 *
 * Their codes are artificial: the individual number is in 900 to 999, which
 * the population register does not give to a person (rule 1 is about real
 * codes); the bed's are, by the same rule. `personaHetu` refuses any other
 * number.
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

/** The test bank of Telia's pre-production bed that returns the persona's code, and how to log in there. */
export type TestBank = {
  name: string;
  /** What is typed at the bank: a user name, or "prefilled" where the bank's test page needs nothing. */
  user: string;
  /** A bank that shares its test person with others, or a code card to choose. */
  note?: string;
};

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
  /** Where the same person is on Telia's bed; absent for the ages, who exist at the mock bank only. */
  bank?: TestBank;
};

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    key: "aino",
    given: "Aino",
    family: "Virtanen",
    born: { year: 1992, month: 12, day: 29 },
    individual: 918,
    group: "walkthrough",
    note: "The walkthrough: registers, onboards, fills in a profile, uploads photos.",
    bank: { name: "Nordea", user: "DEMOUSER2" },
  },
  {
    key: "mikael",
    given: "Mikael",
    family: "Lindqvist",
    born: { year: 1970, month: 1, day: 1 },
    individual: 960,
    group: "walkthrough",
    note: "A second newcomer, for the walkthrough in Swedish.",
    bank: {
      name: "Ålandsbanken",
      user: "12345678",
      note: "password 123456, code card 1234; S-Pankki returns the same person",
    },
  },
  {
    key: "sanna",
    given: "Sanna",
    family: "Korhonen",
    born: { year: 1977, month: 6, day: 17 },
    individual: 924,
    group: "history",
    note: "Onboarded, with a complete profile: five photos once the release of pictures is loaded.",
    bank: { name: "Nordea", user: "DEMOUSER4" },
  },
  {
    key: "onni",
    given: "Onni",
    family: "Korhonen",
    born: { year: 2000, month: 2, day: 1 },
    individual: 961,
    group: "history",
    note: "Registered and never onboarded: the app starts at the first step.",
    bank: { name: "Nordea", user: "DEMOUSER1" },
  },
  {
    key: "noa",
    given: "Noa",
    family: "Salmi",
    born: { year: 1983, month: 8, day: 3 },
    individual: 925,
    group: "history",
    note: "Onboarded, with a profile; two photos and the four pictures the check refuses, so the profile says what is missing and the queue has work.",
    bank: { name: "Nordea", user: "DEMOUSER3" },
  },
  {
    key: "kerttu",
    given: "Kerttu",
    family: "Åkerlund",
    born: { year: 1980, month: 2, day: 1 },
    individual: 952,
    group: "history",
    note: "Accepted an older wording of the terms: the app asks again.",
    bank: {
      name: "Säästöpankki",
      user: "22222222",
      note: "password 123456; POP, OmaSP and Handelsbanken return the same person",
    },
  },
  {
    key: "tapio",
    given: "Tapio",
    family: "Heikkinen",
    born: { year: 1970, month: 7, day: 7 },
    individual: 905,
    group: "history",
    note: "A banned identity: the login is refused.",
    bank: { name: "OP", user: "prefilled" },
  },
  {
    key: "ilona",
    given: "Ilona",
    family: "Öhman",
    born: { year: 1970, month: 1, day: 1 },
    individual: 999,
    group: "history",
    note: "Deleted her account: refused until the waiting time is over.",
    bank: { name: "Aktia", user: "prefilled", note: "or 12345678, password 123456, code 1234" },
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
    key: "siiri",
    given: "Siiri",
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
