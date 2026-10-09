import {
  AGE_MAX,
  AGE_MIN,
  BIO_PRESETS,
  type BioPreset,
  GENDERS,
  type Gender,
  HOBBIES,
  HOBBIES_MAX,
  LANGUAGES_MAX,
  POLITICS_OPTIONS,
  PROFILE_FIELDS,
  PROMPT_KEYS,
  PROMPTS_MAX,
  type ProfileFields,
  type PromptAnswer,
} from "@kuutti/schema";
import { ageFromYearMonth } from "@kuutti/tunnistus-oidc/hetu";
import { createRandom, type Random } from "./rng.ts";
import { BIOS, type Language, NAMES, OCCUPATION_TITLES, PROMPT_ANSWERS } from "./words.ts";

/**
 * The synthetic population (#73, ADR-014): a few hundred people who never
 * existed, made by a seeded generator so that the same command gives the same
 * pond on every machine. Never stored in the repository, never a copy of
 * anybody: the generator and its word lists are all there is.
 *
 * It is made to cross the product's thresholds, not only to fill screens:
 * the one pond is over the gate, over the majority share and, from enough
 * people up, shows the counter's split. The shares are exact counts, not
 * draws, so the thresholds are crossed by construction and not by luck; what
 * is drawn is who gets which age, name and words.
 *
 * Pure: no clock, no database. Every date derives from the epoch.
 */

/**
 * Every timestamp of the population derives from this instant, and none lies
 * after it. It is in the past, so nobody registered or agreed in the future.
 */
export const DEMO_EPOCH = new Date("2026-09-01T09:00:00Z");
export const DEMO_SEED = 73;
export const DEMO_SIZE = 300;
export const DEMO_SIZE_MAX = 5000;
/** A synthetic identity is known by its label; its hash is a hash of the label, never of a code. */
export const DEMO_LABEL_PREFIX = "demo-";

type GenderShares = Readonly<Record<Gender, number>>;

export type PondPlan = {
  slug: string;
  /** People in the pond whatever the size of the population, or a share of those left over. */
  people: { fixed: number } | { share: number };
  genders: GenderShares;
  why: string;
};

/**
 * Who lives where, and why: the data dictionary of docs/demo/population.md in
 * code. One pond for now, the capital region (#146, ADR-010 §11): it has to show everything at
 * once, so it is over the gate, has men over the majority share (the line the
 * admission rule draws) and, from enough people up, every counter cell at k.
 */
export const POND_PLANS: readonly PondPlan[] = [
  {
    slug: "paakaupunkiseutu",
    people: { share: 1 },
    genders: { woman: 0.32, man: 0.62, non_binary: 0.06 },
    why: "over gate_k (30); men are 62 %, over majority_share_max (0.6), so the admission rule holds them back; from 174 people up every gender cell is at ten or more, so the counter shows the split",
  },
];

/** Registered at the bank and gone before the first onboarding step: no gender, no pond. */
export const NEVER_ONBOARDED_SHARE = 0.08;

/** How old people are, in years at the epoch: a young pond with a long tail. */
const AGE_BUCKETS = {
  "18-22": 14,
  "23-27": 30,
  "28-32": 24,
  "33-39": 16,
  "40-49": 10,
  "50-64": 5,
  "65-80": 1,
} as const;

const LANGUAGE_WEIGHTS: Readonly<Record<Language, number>> = { fi: 70, sv: 8, en: 22 };

/** Whom people seek, by their own gender: mostly one, sometimes several. */
const SEEKS: Readonly<Record<Gender, Readonly<Record<string, number>>>> = {
  woman: { man: 78, woman: 8, "man,woman": 6, "man,woman,non_binary": 5, "woman,non_binary": 3 },
  man: { woman: 82, man: 7, "woman,man": 5, "woman,man,non_binary": 4, "man,non_binary": 2 },
  non_binary: {
    "woman,man,non_binary": 50,
    "woman,non_binary": 18,
    "man,non_binary": 14,
    non_binary: 10,
    "woman,man": 8,
  },
};

/**
 * Terms, privacy and the special-category consent that the seek answer
 * needs. No research consent: the product writes that consent and its
 * research_id mapping together, synthetic people emit no events, and events
 * of people who never were would muddy the first real numbers (#73, out of scope).
 */
export type SyntheticConsent = {
  /** The two of the welcome screen and the special-category consent of the seek screen (#146, ADR-019 §4). */
  kind: "terms" | "privacy" | "special_category";
  localeShown: Language;
  givenAt: Date;
};

export type SyntheticProfile = {
  displayName: string;
  bio: string | null;
  bioPreset: BioPreset | null;
  fields: ProfileFields;
  prompts: PromptAnswer[];
  /** When the special-category consent was given, with the other consents; null for most. A politics or religion answer needs it (ADR-019 §4). */
  specialCategoryConsentedAt: Date | null;
};

export type SyntheticPerson = {
  /** `demo-0001`: what the identity is known by, and what the reset finds it by. */
  label: string;
  state: "registered" | "active";
  birthYear: number;
  birthMonth: number;
  registeredAt: Date;
  /** Null for somebody who never onboarded. */
  pond: string | null;
  gender: Gender | null;
  preferences: { seeks: Gender[]; ageWindow: { min: number; max: number } } | null;
  consents: SyntheticConsent[];
  profile: SyntheticProfile | null;
};

export type PopulationOptions = { size?: number; seed?: number; epoch?: Date };

/** Whole numbers in the proportions of the shares, summing to `total` (largest remainder). */
export function apportion<K extends string>(total: number, shares: Readonly<Record<K, number>>) {
  const keys = Object.keys(shares) as K[];
  const sum = keys.reduce((s, k) => s + shares[k], 0);
  const exact = keys.map((k) => (total * shares[k]) / sum);
  const counts = exact.map(Math.floor);
  let left = total - counts.reduce((s, n) => s + n, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, remainder: x - Math.floor(x) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left === 0) break;
    counts[i] = (counts[i] ?? 0) + 1;
    left -= 1;
  }
  return Object.fromEntries(keys.map((k, i) => [k, counts[i] ?? 0])) as Record<K, number>;
}

/** How many people each pond gets, and how many never onboarded. */
export function planSizes(size: number): { ponds: Record<string, number>; neverOnboarded: number } {
  if (!Number.isInteger(size) || size < 1 || size > DEMO_SIZE_MAX) {
    throw new Error(`a population is 1 to ${DEMO_SIZE_MAX} people, not ${size}`);
  }
  const neverOnboarded = Math.round(size * NEVER_ONBOARDED_SHARE);
  let left = size - neverOnboarded;
  const ponds: Record<string, number> = {};
  for (const plan of POND_PLANS) {
    if ("fixed" in plan.people) {
      ponds[plan.slug] = Math.min(plan.people.fixed, left);
      left -= ponds[plan.slug] ?? 0;
    }
  }
  const shares = Object.fromEntries(
    POND_PLANS.flatMap((plan) =>
      "share" in plan.people ? [[plan.slug, plan.people.share] as const] : [],
    ),
  );
  Object.assign(ponds, apportion(left, shares));
  return { ponds, neverOnboarded };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A person agrees to the terms at most this long after registering. */
const CONSENT_DELAY_MAX_MINUTES = 9;
/**
 * Nobody registered later than this before the epoch, so that what follows a
 * registration (the consents) is before the epoch too.
 */
const REGISTERED_BEFORE_EPOCH_MS = (CONSENT_DELAY_MAX_MINUTES + 1) * 60_000;

function bornFor(age: number, random: Random, epoch: Date): { year: number; month: number } {
  const month = random.int(1, 12);
  // The product counts a birthday on the last day of the birth month (TD-14):
  // a month that has not ended by the epoch makes the person a year younger,
  // so the year moves back and the age at the epoch is the age that was drawn.
  let year = epoch.getUTCFullYear() - age;
  if (ageFromYearMonth(year, month, epoch) < age) year -= 1;
  return { year, month };
}

function drawAge(random: Random): number {
  const [from, to] = random.weighted(AGE_BUCKETS).split("-").map(Number) as [number, number];
  return random.int(from, to);
}

/** How many of those with a profile answered each field; docs/demo/population.md says the same in words. */
const SPECIAL_CATEGORY_CONSENT_SHARE = 0.35;

function drawFields(random: Random, language: Language, consented: boolean): ProfileFields {
  const fields: ProfileFields = {};
  // Intent is an onboarding step (#146): everybody with a profile has one.
  fields.intent = random.weighted({ long_term: 55, casual: 20, open_to_either: 25 });
  if (random.chance(0.5)) fields.monogamy = random.weighted({ monogamous: 85, non_monogamous: 15 });
  if (random.chance(0.6)) {
    fields.hasKids = random.weighted({ no: 70, yes_with_me: 18, yes_not_with_me: 12 });
  }
  if (random.chance(0.55)) fields.wantsKids = random.pick(PROFILE_FIELDS.wantsKids.options);
  if (random.chance(0.65)) {
    fields.smoking = random.weighted({ never: 60, sometimes: 20, regularly: 12, quitting: 8 });
  }
  const others = PROFILE_FIELDS.languages.options.filter((l) => l !== language && l !== "other");
  if (random.chance(0.85)) {
    const more = random.sample(others, random.int(0, Math.min(2, LANGUAGES_MAX - 1)));
    fields.languages = [language, ...more];
  }
  if (random.chance(0.65)) fields.education = random.pick(PROFILE_FIELDS.education.options);
  if (random.chance(0.65)) {
    fields.drinking = random.weighted({ never: 15, rarely: 30, socially: 45, often: 10 });
  }
  if (random.chance(0.4)) fields.drugsAttitude = random.pick(PROFILE_FIELDS.drugsAttitude.options);
  if (random.chance(0.7)) fields.hobbies = random.sample(HOBBIES, random.int(1, HOBBIES_MAX));
  if (random.chance(0.55)) fields.height = random.int(152, 198);
  if (random.chance(0.55)) fields.exercise = random.pick(PROFILE_FIELDS.exercise.options);
  if (random.chance(0.5)) {
    fields.pets = random
      .weighted({ none: 35, dog: 25, cat: 25, "dog,cat": 8, other: 4, allergic: 3 })
      .split(",") as ProfileFields["pets"];
  }
  if (random.chance(0.45)) {
    fields.field = random.pick(PROFILE_FIELDS.field.options);
    if (random.chance(0.15)) fields.hideFromField = true;
  }
  if (random.chance(0.5)) fields.occupation = random.pick(PROFILE_FIELDS.occupation.options);
  if (random.chance(0.3)) fields.occupationTitle = random.pick(OCCUPATION_TITLES[language]);
  // Article 9 answers only behind the consent (ADR-019 §4), as the API would have it.
  if (consented) {
    if (random.chance(0.7)) fields.politics = random.sample(POLITICS_OPTIONS, random.int(1, 3));
    if (random.chance(0.6)) fields.religion = random.pick(PROFILE_FIELDS.religion.options);
  }
  if (random.chance(0.45)) fields.zodiac = random.pick(PROFILE_FIELDS.zodiac.options);
  return fields;
}

function drawProfile(
  random: Random,
  gender: Gender,
  language: Language,
  agreedAt: Date,
): SyntheticProfile {
  const consentedAt = random.chance(SPECIAL_CATEGORY_CONSENT_SHARE) ? agreedAt : null;
  const kind = random.weighted({ bio: 65, preset: 12, none: 23 });
  const answered = Number(random.weighted({ "0": 25, "1": 20, "2": 35, "3": 20 }));
  const prompts = random
    .sample(PROMPT_KEYS, Math.min(answered, PROMPTS_MAX))
    .map((key) => ({ key, answer: random.pick(PROMPT_ANSWERS[key]?.[language] ?? []) }));
  return {
    displayName: random.pick(NAMES[gender]),
    bio: kind === "bio" ? random.pick(BIOS[language]) : null,
    bioPreset: kind === "preset" ? random.pick(BIO_PRESETS) : null,
    fields: drawFields(random, language, consentedAt !== null),
    prompts,
    specialCategoryConsentedAt: consentedAt,
  };
}

function onboarded(
  random: Random,
  label: string,
  pond: string,
  gender: Gender,
  epoch: Date,
): SyntheticPerson {
  const age = drawAge(random);
  const born = bornFor(age, random, epoch);
  const registeredAt = new Date(
    epoch.getTime() -
      REGISTERED_BEFORE_EPOCH_MS -
      random.int(0, 60) * DAY_MS -
      random.int(0, 1439) * 60_000,
  );
  const language = random.weighted(LANGUAGE_WEIGHTS);
  const seeks = random.weighted(SEEKS[gender]).split(",") as Gender[];
  const ageWindow = {
    min: Math.max(AGE_MIN, age - random.int(2, 8)),
    max: Math.min(AGE_MAX, age + random.int(2, 10)),
  };
  const agreedAt = new Date(
    registeredAt.getTime() + random.int(1, CONSENT_DELAY_MAX_MINUTES) * 60_000,
  );
  const consents: SyntheticConsent[] = [
    { kind: "terms", localeShown: language, givenAt: agreedAt },
    { kind: "privacy", localeShown: language, givenAt: agreedAt },
    { kind: "special_category", localeShown: language, givenAt: agreedAt },
  ];
  return {
    label,
    state: "active",
    birthYear: born.year,
    birthMonth: born.month,
    registeredAt,
    pond,
    gender,
    preferences: { seeks, ageWindow },
    consents,
    profile: random.chance(0.88) ? drawProfile(random, gender, language, agreedAt) : null,
  };
}

/** The same people for the same size, seed and epoch, on every machine. */
export function generatePopulation(options: PopulationOptions = {}): SyntheticPerson[] {
  const size = options.size ?? DEMO_SIZE;
  const epoch = options.epoch ?? DEMO_EPOCH;
  const random = createRandom(options.seed ?? DEMO_SEED);
  const sizes = planSizes(size);
  const width = String(DEMO_SIZE_MAX).length;
  const people: SyntheticPerson[] = [];
  const label = () => `${DEMO_LABEL_PREFIX}${String(people.length + 1).padStart(width, "0")}`;

  for (const plan of POND_PLANS) {
    const counts = apportion(sizes.ponds[plan.slug] ?? 0, plan.genders);
    for (const gender of GENDERS) {
      for (let i = 0; i < counts[gender]; i += 1) {
        people.push(onboarded(random, label(), plan.slug, gender, epoch));
      }
    }
  }
  for (let i = 0; i < sizes.neverOnboarded; i += 1) {
    const born = bornFor(drawAge(random), random, epoch);
    people.push({
      label: label(),
      state: "registered",
      birthYear: born.year,
      birthMonth: born.month,
      registeredAt: new Date(
        epoch.getTime() -
          REGISTERED_BEFORE_EPOCH_MS -
          random.int(0, 20) * DAY_MS -
          random.int(0, 1439) * 60_000,
      ),
      pond: null,
      gender: null,
      preferences: null,
      consents: [],
      profile: null,
    });
  }
  return people;
}

export type PondSummary = Record<Gender, number> & { people: number; largestShare: number };

/** The same counts as `summarise(generatePopulation({ size }))`, without drawing anybody. */
export function plannedPonds(size: number): Record<string, PondSummary> {
  const sizes = planSizes(size);
  const ponds: Record<string, PondSummary> = {};
  for (const plan of POND_PLANS) {
    const people = sizes.ponds[plan.slug] ?? 0;
    if (people === 0) continue;
    const counts = apportion(people, plan.genders);
    ponds[plan.slug] = {
      ...counts,
      people,
      largestShare: Math.max(counts.woman, counts.man, counts.non_binary) / people,
    };
  }
  return ponds;
}

export type Thresholds = { gateK: number; majorityShareMax: number; counterK: number };

/**
 * What a population of this size does not show, in words; empty when it shows
 * everything it is there for. The shares cross the thresholds by construction
 * only when the pond is large enough, which it is from 174 people up.
 */
export function uncrossed(ponds: Record<string, PondSummary>, t: Thresholds): string[] {
  const missing: string[] = [];
  const pond = ponds.paakaupunkiseutu;
  if (!pond || pond.people < t.gateK) missing.push("the pond is under the gate");
  if (!pond || pond.largestShare <= t.majorityShareMax) {
    missing.push("the pond is not over the majority share");
  }
  if (!pond || [pond.woman, pond.man, pond.non_binary].some((n) => n < t.counterK)) {
    missing.push("the pond has a cell under the counter's k, so it shows no split");
  }
  return missing;
}

/** People per pond and gender: what the thresholds are checked against. */
export function summarise(people: readonly SyntheticPerson[]): Record<string, PondSummary> {
  const ponds: Record<string, PondSummary> = {};
  for (const person of people) {
    if (person.pond === null || person.gender === null) continue;
    const pond = ponds[person.pond] ?? {
      woman: 0,
      man: 0,
      non_binary: 0,
      people: 0,
      largestShare: 0,
    };
    ponds[person.pond] = pond;
    pond[person.gender] += 1;
    pond.people += 1;
  }
  for (const pond of Object.values(ponds)) {
    pond.largestShare = Math.max(pond.woman, pond.man, pond.non_binary) / pond.people;
  }
  return ponds;
}
