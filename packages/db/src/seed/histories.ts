import type { Gender, ProfileUpdate } from "@kuutti/schema";
import { DEMO_PERSONAS, type DemoPersona } from "./personas.ts";

/**
 * What the six personas "with a history" have done before the demo begins
 * (#73, ADR-014 §12). Data only: `pnpm demo:reset` gives a persona its history
 * by logging it in at the mock bank and sending these answers through the
 * API's own routes, as the app would, so every rule that holds for a person
 * holds for a persona. What no route can do (an older wording of the terms, a
 * ban) is named in `afterwards` and done in the database.
 *
 * The two newcomers and the four ages have no history: they begin as people
 * Kuutti has never seen.
 */
export type PersonaHistory = {
  key: string;
  /** The language the consents were shown in. */
  locale: "fi" | "sv" | "en";
  /** Null: registered at the bank and gone before the first step. */
  onboarding: {
    gender: Gender;
    seeks: Gender[];
    ageWindow: { min: number; max: number };
    pond: string;
  } | null;
  profile: ProfileUpdate | null;
  /** How many photos the persona has once the photo loader has run; none before. */
  photos: number;
  afterwards: "nothing" | "older_terms" | "banned" | "deleted";
};

/** The version an older wording of the terms is given: none the catalogue has ever had. */
export const OLDER_TERMS_VERSION = "2026-01-demo-older";

export const PERSONA_HISTORIES: readonly PersonaHistory[] = [
  {
    key: "sanna",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["man"],
      ageWindow: { min: 32, max: 44 },
      pond: "espoo",
    },
    profile: {
      displayName: "Sanna",
      bio: "Arkkitehti, joka piirtää työkseen taloja ja vapaa-ajalla lintuja. Viikonloppuisin minut löytää Nuuksiosta termospullon kanssa. Etsin jotakuta, joka jaksaa kävellä perille asti.",
      bioPreset: null,
      fields: {
        languages: ["fi", "en", "sv"],
        intent: "long_term",
        monogamy: "monogamous",
        hasKids: "no",
        wantsKids: "want",
        smoking: "never",
        drinking: "socially",
        education: "maisteri",
        field: "arts",
        occupation: "arts_culture",
        occupationTitle: "Arkkitehti",
        hobbies: ["hiking", "birdwatching", "swimming"],
        height: 171,
      },
      prompts: [
        { key: "sunday", answer: "Aamu-uinti, sitten pitkä aamiainen ja sanomalehti." },
        { key: "teach_me", answer: "Opeta minut tunnistamaan sienet. Tunnen vain kantarellin." },
      ],
      specialCategoryConsent: null,
    },
    photos: 3,
    afterwards: "nothing",
  },
  { key: "onni", locale: "fi", onboarding: null, profile: null, photos: 0, afterwards: "nothing" },
  {
    key: "noa",
    locale: "en",
    onboarding: {
      gender: "non_binary",
      seeks: ["woman", "man", "non_binary"],
      ageWindow: { min: 24, max: 34 },
      pond: "otaniemi",
    },
    profile: {
      displayName: "Noa",
      bio: "Doctoral student by day, bouldering by night. I cook one dish very well and I am working on a second. Tell me what you are reading.",
      bioPreset: null,
      fields: {
        languages: ["en", "fi"],
        intent: "open_to_either",
        education: "maisteri",
        field: "science",
        // The setting of ADR-019 §5 on one persona, so the demo can show it.
        hideFromField: true,
        occupation: "science",
        occupationTitle: "Doctoral researcher",
        hobbies: ["climbing", "cooking", "reading"],
      },
      prompts: [{ key: "hidden_talent", answer: "I can name a tree by its bark." }],
      specialCategoryConsent: null,
    },
    photos: 2,
    afterwards: "nothing",
  },
  {
    key: "kerttu",
    locale: "sv",
    onboarding: {
      gender: "woman",
      seeks: ["woman", "man"],
      ageWindow: { min: 35, max: 50 },
      pond: "espoo",
    },
    profile: {
      displayName: "Kerttu",
      bio: null,
      bioPreset: "ask_me_instead",
      fields: {
        languages: ["sv", "fi"],
        intent: "long_term",
        hasKids: "yes_not_with_me",
        wantsKids: "dont_want",
        hobbies: ["reading", "coffee", "forest_walks"],
      },
      prompts: [
        { key: "three_things", answer: "Havet, en bra bok och nybryggt kaffe." },
        { key: "first_date", answer: "En promenad längs stranden, oavsett väder." },
      ],
      specialCategoryConsent: null,
    },
    photos: 3,
    afterwards: "older_terms",
  },
  {
    key: "tapio",
    locale: "fi",
    onboarding: {
      gender: "man",
      seeks: ["woman"],
      ageWindow: { min: 38, max: 55 },
      pond: "espoo",
    },
    profile: null,
    photos: 0,
    afterwards: "banned",
  },
  {
    key: "ilona",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["man"],
      ageWindow: { min: 28, max: 40 },
      pond: "otaniemi",
    },
    profile: {
      displayName: "Ilona",
      bio: "Kokeilin, katsoin ja lähdin. Ehkä palaan.",
      bioPreset: null,
      fields: {},
      prompts: [],
      specialCategoryConsent: null,
    },
    photos: 0,
    afterwards: "deleted",
  },
];

/** The persona of a history; a history without a persona is a mistake in this file. */
export function personaOf(history: PersonaHistory): DemoPersona {
  const persona = DEMO_PERSONAS.find((p) => p.key === history.key);
  if (!persona) throw new Error(`no persona ${history.key}`);
  return persona;
}
