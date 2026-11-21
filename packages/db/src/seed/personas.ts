import { checkCharacter } from "@kuutti-ry/tunnistus-oidc/hetu";

/**
 * The people of the mock bank (#73, #140, #560, ADR-014): thirty named persons the
 * local identity provider can log in as with one tap, so that a demo or a
 * test of the first ten minutes does not start with typing claims into a
 * form. The whole product path runs for them as for anybody: the OIDC
 * exchange, the parsing of the code, the HMAC, the age rule, the
 * re-registration rule. Nothing in the API or the app knows their names.
 *
 * Nine born on a fixed day carry the codes of the test persons of
 * Telia's pre-production bed (#140, docs/vendors/telia.md 1.4): the mock bank
 * issues locally the very code a test bank returns on staging, so a persona
 * is one identity in each environment and a story given on staging is the
 * same person's. The bank's name for the person is in the claims, as the real
 * broker sends it, and is stored nowhere; what the app calls the persona is
 * the display name the story gives.
 *
 * Whoever a person can reach through the bed is a member with a whole profile
 * (#560, the maintainer, 21/11/2026): a store's reviewer, a tester or a guest
 * of a demo types any working test user and finds photos, people to go
 * through, likes and a conversation. Sanna, Noa and Kerttu are that and the
 * flows' people too (`history`); Aino, Onni, Tapio, Ilona and Helmi are that
 * and nothing else (`members`), so no flow signs in as them and what somebody
 * leaves in their accounts breaks no run. The states a flow needs and a
 * person exploring does not (never onboarded, banned, deleted, without
 * photos, a newcomer whose account goes) belong to people of the mock bank
 * alone: Otto, Reijo, Marjatta, Aune and Sofia.
 *
 * Seventeen more are born on a fixed day and exist at the mock bank only: those
 * five; Antti
 * and Ville, the pair of the chat's flows (#348, #101), Elina and Jussi, the
 * pair of the contact share's flow (#103), and Laura and Emmi, the pair of
 * the report's flow (#351), each pair with a conversation of its own so that
 * no flow changes what another reads; and the queue's cast (#379): Iida, as
 * whom the queue's flow signs in, and the four people of her queue, Henna,
 * Katja, Minna and Riikka, who are cards and nothing more: no demo signs in as them,
 * and of the flows only `short-pool`, as Riikka; and Ritva, What you seek's (#542), whose answers that
 * flow changes and puts back, which no other flow reads. Every test user of the bed whose code the
 * product's parser accepts is a persona already (docs/vendors/telia.md 1.4),
 * so nobody signs in as these on staging (the maintainer's choices of
 * 17/10/2026 and 18/10/2026, ADR-014 §4); the stories of those who have one are given there as
 * anywhere.
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
type RelativeBirth = { yearsAgo: number; monthsAgo: number };

/** The test bank of Telia's pre-production bed that returns the persona's code, and how to log in there. */
type TestBank = {
  name: string;
  /** What is typed at the bank: a user name, or "prefilled" where the bank's test page needs nothing. */
  user: string;
  /** A bank that shares its test person with others, or a code card to choose. */
  note?: string;
};

export type DemoPersona = {
  /**
   * The persona's id: the name typed at the bank, the `sub` of the token, the
   * story's key and the folder of its pictures (`faces/<key>/`). Never renamed
   * and never reused: tests, the stories and the photos release find a persona
   * by it.
   */
  key: string;
  /** What the bank says the person is called. The product never stores it (rule 3). */
  given: string;
  family: string;
  born: FixedBirth | RelativeBirth;
  /** 900 to 999: artificial, not given to a person by the population register. */
  individual: number;
  /**
   * `members`: the bed's test users no flow signs in as, whole profiles for a person to explore (#560);
   * last on the page's list of names. `cards`: people a queue shows, whom a demo does not sign in
   * as (#379); off that list.
   */
  group: "walkthrough" | "history" | "members" | "ages" | "cards";
  /** What the persona is for, shown under the name. */
  note: string;
  /** Where the same person is on Telia's bed; absent for everybody who exists at the mock bank only. */
  bank?: TestBank;
};

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    key: "aino",
    given: "Aino",
    family: "Virtanen",
    born: { year: 1992, month: 12, day: 29 },
    individual: 918,
    group: "members",
    note: "A member to explore: a whole profile with five photos, people to go through, likes waiting and a conversation where the cast is written.",
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
  // The newcomer of the flows (#560): Aino's place, since Aino is a member now.
  {
    key: "sofia",
    given: "Sofia",
    family: "Heino",
    born: { year: 1993, month: 4, day: 18 },
    individual: 975,
    group: "walkthrough",
    note: "The walkthrough: registers, onboards, fills in a profile, uploads photos. The flows of Found someone and of deleting the account sign in as her.",
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
    group: "members",
    note: "A member to explore: a whole profile with four photos, people to go through, likes waiting and a conversation where the cast is written.",
    bank: { name: "Nordea", user: "DEMOUSER1" },
  },
  {
    key: "noa",
    given: "Noa",
    family: "Salmi",
    born: { year: 1983, month: 8, day: 3 },
    individual: 925,
    group: "history",
    note: "Onboarded, with a profile; two photos, the second still in review, and the four pictures the check refuses, so the profile says what is missing and the queue has work.",
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
      note: "password 123456; POP and OmaSP return the same person",
    },
  },
  {
    key: "tapio",
    given: "Tapio",
    family: "Heikkinen",
    born: { year: 1970, month: 7, day: 7 },
    individual: 905,
    group: "members",
    note: "A member to explore: a whole profile with three photos, and people to go through, likes waiting and a conversation where the cast is written.",
    bank: { name: "OP", user: "prefilled" },
  },
  {
    key: "ilona",
    given: "Ilona",
    family: "Öhman",
    born: { year: 1970, month: 1, day: 1 },
    individual: 999,
    group: "members",
    note: "A member to explore: a whole profile with three photos, people to go through, likes waiting and a conversation where the cast is written.",
    bank: { name: "Aktia", user: "prefilled", note: "or 12345678, password 123456, code 1234" },
  },
  {
    key: "helmi",
    given: "Helmi",
    family: "Mäkelä",
    born: { year: 1932, month: 1, day: 1 },
    individual: 998,
    group: "members",
    note: "A member to explore, onboarded and still without photos: the release of pictures has none of her yet, so her profile says what it lacks.",
    bank: { name: "Mobiilivarmenne emulator", user: "0401234567", note: "prefilled" },
  },
  // The states a flow needs and a person exploring does not (#560): people of the mock bank
  // alone, in the places Onni, Tapio, Ilona and Helmi held while they were the bed's.
  {
    key: "otto",
    given: "Otto",
    family: "Ahonen",
    // Onni's day, so the ages the onboarding offers are the ones its flow has always read.
    born: { year: 2000, month: 2, day: 1 },
    individual: 973,
    group: "history",
    note: "Registered and never onboarded: the app starts at the first step. The onboarding's flow signs in as him.",
  },
  {
    key: "reijo",
    given: "Reijo",
    family: "Salonen",
    born: { year: 1968, month: 9, day: 9 },
    individual: 976,
    group: "history",
    note: "A banned identity: the login is refused.",
  },
  {
    key: "marjatta",
    given: "Marjatta",
    family: "Lund",
    born: { year: 1969, month: 3, day: 23 },
    individual: 977,
    group: "history",
    note: "Deleted her account: refused until the waiting time is over.",
  },
  {
    key: "aune",
    given: "Aune",
    family: "Rinne",
    born: { year: 1940, month: 6, day: 6 },
    individual: 978,
    group: "history",
    note: "Onboarded without photos: the persona of the break's flow, who takes a break and comes back (#170).",
  },
  // The chat's pair (#348): no test user of the bed is left for them.
  {
    key: "antti",
    given: "Antti",
    family: "Nurmi",
    born: { year: 1979, month: 5, day: 14 },
    individual: 962,
    group: "history",
    note: "Onboarded without photos: a conversation with Ville, and a silent one with Sanna in the archive. The chat's flow writes as him (#348).",
  },
  {
    key: "ville",
    given: "Ville",
    family: "Rantanen",
    born: { year: 1976, month: 3, day: 8 },
    individual: 963,
    group: "history",
    note: "Onboarded without photos: a few days of messages with Antti, and the chat's flow reads as him (#348).",
  },
  // The contact share's pair (#103): a conversation of their own, apart from the chat's.
  {
    key: "elina",
    given: "Elina",
    family: "Järvinen",
    born: { year: 1989, month: 9, day: 21 },
    individual: 964,
    group: "history",
    note: "Onboarded without photos: a conversation with Jussi. The contact share's flow shares a contact as her (#103).",
  },
  {
    key: "jussi",
    given: "Jussi",
    family: "Lehtonen",
    born: { year: 1986, month: 11, day: 2 },
    individual: 965,
    group: "history",
    note: "Onboarded without photos: a conversation with Elina, and the contact share's flow sees her contact as him (#103).",
  },
  // The report's pair (#351): a conversation of their own, which their flow ends for good.
  {
    key: "laura",
    given: "Laura",
    family: "Saarinen",
    born: { year: 1997, month: 4, day: 12 },
    individual: 966,
    group: "history",
    note: "Onboarded without photos: a conversation with Emmi. The report's flow reports the photo Emmi sent her there, which blocks for good (#351, #476).",
  },
  {
    key: "emmi",
    given: "Emmi",
    family: "Kallio",
    born: { year: 1995, month: 10, day: 3 },
    individual: 967,
    group: "history",
    note: "Onboarded without photos: a conversation with Laura, ending with a photo she sent her, which the report's flow ends; she finds it ended and can still report it (#351, #476).",
  },
  {
    key: "iida",
    given: "Iida",
    family: "Mattila",
    born: { year: 1990, month: 3, day: 11 },
    individual: 968,
    group: "history",
    note: "Onboarded, with a complete profile: a queue for the day, four cards, the first of them Henna, who liked her. The queue's flow likes, passes, likes back and blocks as her (#379).",
  },
  {
    key: "henna",
    given: "Henna",
    family: "Laaksonen",
    born: { year: 1989, month: 5, day: 27 },
    individual: 969,
    group: "cards",
    note: "A card in Iida's queue: she liked Iida yesterday, so she comes first, and Iida's like back is a match.",
  },
  {
    key: "katja",
    given: "Katja",
    family: "Rautio",
    born: { year: 1989, month: 11, day: 19 },
    individual: 970,
    group: "cards",
    note: "A card in Iida's queue.",
  },
  {
    key: "minna",
    given: "Minna",
    family: "Peltonen",
    born: { year: 1990, month: 1, day: 8 },
    individual: 971,
    group: "cards",
    note: "A card in Iida's queue.",
  },
  {
    key: "riikka",
    given: "Riikka",
    family: "Kivelä",
    born: { year: 1989, month: 8, day: 30 },
    individual: 972,
    group: "cards",
    note: "A card in Iida's queue.",
  },
  // What you seek's (#542): in nobody's pool, so its flow changes what nothing else reads.
  {
    key: "ritva",
    given: "Ritva",
    family: "Lahtinen",
    born: { year: 1964, month: 5, day: 14 },
    individual: 974,
    group: "history",
    note: "Onboarded without photos, in nobody's pool: the flow of What you seek changes what she seeks and puts it back (#542).",
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

/**
 * Anybody else at the mock bank: the claims its form starts with, and the
 * flow check's login as somebody else. Under the names the Telia broker uses
 * for a Finnish user (docs/vendors/telia.md, guide 2.6.4), with an artificial
 * code (individual number 900 to 999), never a person's.
 */
export const SOMEBODY_CLAIMS = {
  "urn:oid:1.2.246.21": `010190-999${checkCharacter("010190", "999")}`,
  "urn:oid:1.3.6.1.5.5.7.9.1": "1990-01-01",
  "urn:oid:2.5.4.4": "Henkilö",
  "urn:oid:1.2.246.575.1.14": "Testi",
  "urn:oid:2.16.840.1.113730.3.1.241": "Testi Henkilö",
  acr: MOCK_BANK_ACR,
  amr: [MOCK_BANK_AMR],
};

const two = (n: number) => String(n).padStart(2, "0");

/** The day the persona was born, as seen on the UTC day of `at`. */
export function personaBirth(persona: DemoPersona, at: Date): FixedBirth {
  if ("year" in persona.born) return persona.born;
  // Months counted from year zero, so that January minus one is December of the year before.
  const months =
    (at.getUTCFullYear() - persona.born.yearsAgo) * 12 + at.getUTCMonth() - persona.born.monthsAgo;
  return { year: Math.floor(months / 12), month: (months % 12) + 1, day: 1 };
}

const ARTIFICIAL_MIN = 900;
const ARTIFICIAL_MAX = 999;

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
