import type { Gender, ProfileUpdate } from "@kuutti/schema";
import { DEMO_PERSONAS, type DemoPersona } from "./personas.ts";

/**
 * What the six personas "with a history" have done before the demo begins
 * (#73, ADR-014 §12). The ages follow the codes of Telia's test persons (#140). Data only: `pnpm demo:reset` gives a persona its history
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
    /** The one pond for now (#146): named here as the API would assign it, so the story reads as the person's. */
    pond: string;
  } | null;
  profile: ProfileUpdate | null;
  /** How many of the persona's own pictures the loader uploads and approves (#142): the release has that many of them. */
  photos: number;
  /** Pictures the check is meant to refuse, uploaded for this persona and left to the queue (#142). */
  negatives?: readonly string[];
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
      pond: "suomi",
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
      pond: "suomi",
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
    // The queue's four: no face, several people, text, and a location in the EXIF the pipeline strips.
    negatives: ["no-face", "several-people", "text", "exif-location"],
    afterwards: "nothing",
  },
  {
    key: "kerttu",
    locale: "sv",
    onboarding: {
      gender: "woman",
      seeks: ["woman", "man"],
      ageWindow: { min: 35, max: 50 },
      pond: "suomi",
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
      pond: "suomi",
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
      pond: "suomi",
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
