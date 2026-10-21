import type { Gender, ProfileUpdate } from "@kuutti/schema";
import { DEMO_PERSONAS, type DemoPersona } from "./personas.ts";

/**
 * What the eighteen personas "with a history" have done before the demo begins
 * (#73, ADR-014 §12). The ages follow the codes of Telia's test persons
 * (#140), and each age window holds its persona's own age (a test says so).
 * Data only: `pnpm demo:reset` gives a persona its history by logging it in
 * at the mock bank and sending these answers through the API's own routes,
 * as the app would, so every rule that holds for a person holds for a
 * persona. What no route can do (an older wording of the terms, a
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
  /** Of the faces, how many (the last ones) wait for a moderator where no check decides; none by default. */
  facesInReview?: number;
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
      ageWindow: { min: 42, max: 56 },
      pond: "paakaupunkiseutu",
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
        field: ["arts"],
        occupation: ["arts_culture"],
        occupationTitle: "Arkkitehti",
        hobbies: ["hiking", "birdwatching", "swimming"],
        height: 171,
      },
      prompts: [
        { key: "sunday", answer: "Aamu-uinti, sitten pitkä aamiainen ja sanomalehti." },
        { key: "teach_me", answer: "Opeta minut tunnistamaan sienet. Tunnen vain kantarellin." },
      ],
    },
    photos: 5,
    afterwards: "nothing",
  },
  { key: "onni", locale: "fi", onboarding: null, profile: null, photos: 0, afterwards: "nothing" },
  {
    key: "noa",
    locale: "en",
    onboarding: {
      gender: "non_binary",
      seeks: ["woman", "man", "non_binary"],
      ageWindow: { min: 35, max: 50 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Noa",
      bio: "Doctoral student by day, bouldering by night. I cook one dish very well and I am working on a second. Tell me what you are reading.",
      bioPreset: null,
      fields: {
        languages: ["en", "fi"],
        intent: "open_to_either",
        education: "maisteri",
        field: ["science"],
        // The setting of ADR-019 §5 on one persona, so the demo can show it.
        hideFromField: true,
        occupation: ["science"],
        occupationTitle: "Doctoral researcher",
        hobbies: ["climbing", "cooking", "reading"],
      },
      prompts: [{ key: "hidden_talent", answer: "I can name a tree by its bark." }],
    },
    photos: 2,
    // The second face waits for a moderator: one approved photo is short of
    // the two a profile needs (#56), so the gate and the profile wait.
    facesInReview: 1,
    // Four more pictures for the check (#142): no face, text and several
    // people are not accepted and Noa is told why, with no moderator asked;
    // the one whose EXIF location the pipeline strips is a face and is
    // approved (ADR-006 §2, #206, #253). Locally the check queues
    // everything (§4): all of them wait for a person.
    negatives: ["no-face", "several-people", "text", "exif-location"],
    afterwards: "nothing",
  },
  {
    key: "kerttu",
    locale: "sv",
    onboarding: {
      gender: "woman",
      seeks: ["woman", "man"],
      ageWindow: { min: 40, max: 55 },
      pond: "paakaupunkiseutu",
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
    },
    photos: 4,
    afterwards: "older_terms",
  },
  {
    key: "tapio",
    locale: "fi",
    onboarding: {
      gender: "man",
      seeks: ["woman"],
      ageWindow: { min: 45, max: 60 },
      pond: "paakaupunkiseutu",
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
      ageWindow: { min: 48, max: 64 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Ilona",
      bio: "Kokeilin, katsoin ja lähdin. Ehkä palaan.",
      bioPreset: null,
      fields: {},
      prompts: [],
    },
    photos: 0,
    afterwards: "deleted",
  },
  // The break's flow (#170, ADR-022): onboarded and active, no photos, so the
  // flow finds her signed in and leaves her so; nothing another flow reads.
  {
    key: "helmi",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["man"],
      ageWindow: { min: 80, max: 99 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Helmi",
      bio: null,
      bioPreset: "ask_me_instead",
      fields: { intent: "long_term" },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  // The chat's pair (#348): in each other's pool both ways, and Antti in
  // Sanna's, so the conversations of conversations.ts are matches the filters
  // allow (a test says so). No photos: the release has no faces of them.
  {
    key: "antti",
    locale: "fi",
    onboarding: {
      gender: "man",
      seeks: ["woman", "man"],
      ageWindow: { min: 40, max: 55 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Antti",
      bio: "Kirjastonhoitaja, joka leipoo sunnuntaisin liikaa pullaa ja vie ylimääräiset naapureille. Metsässä kävelen hitaasti ja pysähdyn joka sienen kohdalla.",
      bioPreset: null,
      fields: {
        languages: ["fi", "en"],
        intent: "long_term",
        hobbies: ["baking", "forest_walks", "board_games"],
      },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  {
    key: "ville",
    locale: "fi",
    onboarding: {
      gender: "man",
      seeks: ["man"],
      ageWindow: { min: 44, max: 56 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Ville",
      bio: "Purjehdin kesät saaristossa ja talvet uin avannossa. Arkisin suunnittelen siltoja. Etsin jotakuta, jonka kanssa hiljaisuuskin on hyvää seuraa.",
      bioPreset: null,
      fields: {
        languages: ["fi", "sv", "en"],
        intent: "long_term",
        hobbies: ["sailing", "winter_swimming", "sauna"],
      },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  // The contact share's pair (#103): in each other's pool both ways and in no
  // other persona's, so their conversation is a match the filters allow (a
  // test says so) and the flow that shares a contact there changes nothing
  // the chat's flows read. No photos: the release has no faces of them.
  {
    key: "elina",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["man"],
      ageWindow: { min: 35, max: 48 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Elina",
      bio: "Fysioterapeutti, joka korjaa työkseen muiden selkiä ja omansa kuntosalilla. Luen dekkareita bussissa ja kasvatan parvekkeella liikaa tomaatteja.",
      bioPreset: null,
      fields: {
        languages: ["fi", "en"],
        intent: "long_term",
        hobbies: ["reading", "gardening", "gym"],
      },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  {
    key: "jussi",
    locale: "fi",
    onboarding: {
      gender: "man",
      seeks: ["woman"],
      ageWindow: { min: 33, max: 45 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Jussi",
      bio: "Opettaja, joka viettää kesät mökillä ja talvet lukupiirissä. Teen hyvää kalakeittoa ja huonoja sanaleikkejä. Etsin jotakuta, joka nauraa niille silti.",
      bioPreset: null,
      fields: {
        languages: ["fi", "sv"],
        intent: "long_term",
        hobbies: ["cottage", "reading", "fishing"],
      },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  // The report's pair (#351): in each other's pool both ways and in no other
  // persona's, so their conversation is a match the filters allow (a test
  // says so) and the flow that reports and blocks there changes nothing
  // another flow reads. No photos: the release has no faces of them.
  {
    key: "laura",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 26, max: 35 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Laura",
      bio: "Graafikko, joka piirtää työkseen ja kiipeilee vapaa-ajallaan. Kotona odottaa kissa ja liian monta kasvia. Etsin jotakuta, jonka kanssa käydä museoissa ja syödä liikaa jäätelöä.",
      bioPreset: null,
      fields: {
        languages: ["fi", "en"],
        intent: "long_term",
        hobbies: ["drawing", "climbing", "museums"],
      },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  {
    key: "emmi",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 27, max: 35 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Emmi",
      bio: "Sairaanhoitaja, joka viettää vapaapäivänsä metsässä tai lautapelien ääressä. Leivon sunnuntaisin ja kutsun ystävät syömään. Etsin jotakuta, joka nauttii hitaista aamuista.",
      bioPreset: null,
      fields: {
        languages: ["fi", "sv"],
        intent: "long_term",
        hobbies: ["forest_walks", "board_games", "baking"],
      },
      prompts: [],
    },
    photos: 0,
    afterwards: "nothing",
  },
  // The round's cast (#379): five women who seek women, so that each is let
  // in at once (ADR-015 §10: seeking one's own gender is no contest), all in
  // each other's pool both ways and in no other persona's (a test says so):
  // 36 and 37, above the report's pair's windows and below Kerttu.
  // Iida's round holds the other four, Henna first, who liked her yesterday
  // (rounds.ts). Complete profiles: the release's faces of them (#142).
  {
    key: "iida",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 34, max: 44 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Iida",
      bio: "Farmaseutti, joka pyöräilee töihin ympäri vuoden ja leipoo viikonloppuisin ruisleipää. Laulan kuorossa ja kaipaan jotakuta, jonka kanssa jakaa hitaat aamut.",
      bioPreset: null,
      fields: {
        languages: ["fi", "en"],
        intent: "long_term",
        hobbies: ["cycling", "baking", "making_music"],
      },
      prompts: [],
    },
    photos: 3,
    afterwards: "nothing",
  },
  {
    key: "henna",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 34, max: 44 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Henna",
      bio: "Meribiologi, joka viettää kesät kajakissa saariston reunalla. Talvella kirjoitan raportteja ja haaveilen kesästä. Etsin jotakuta, joka tulee mukaan aamuvarhain.",
      bioPreset: null,
      fields: {
        languages: ["fi", "sv", "en"],
        intent: "long_term",
        hobbies: ["sailing", "swimming", "baking"],
      },
      prompts: [],
    },
    photos: 2,
    afterwards: "nothing",
  },
  {
    key: "katja",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 34, max: 45 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Katja",
      bio: "Musiikinopettaja ja sellisti, jonka koira vie lenkille säällä kuin säällä. Metsässä hiljenen, konsertissa en. Etsin jotakuta, joka nauttii molemmista.",
      bioPreset: null,
      fields: {
        languages: ["fi", "en"],
        intent: "long_term",
        hobbies: ["making_music", "dogs", "forest_walks"],
      },
      prompts: [],
    },
    photos: 2,
    afterwards: "nothing",
  },
  {
    key: "minna",
    locale: "en",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 34, max: 42 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Minna",
      bio: "Game designer by day, winter runner by choice. I make a very good chai and a passable pulla. Looking for someone to explore new cafés with.",
      bioPreset: null,
      fields: {
        languages: ["en", "fi"],
        intent: "open_to_either",
        hobbies: ["running", "video_games", "coffee"],
      },
      prompts: [],
    },
    photos: 2,
    afterwards: "nothing",
  },
  {
    key: "riikka",
    locale: "fi",
    onboarding: {
      gender: "woman",
      seeks: ["woman"],
      ageWindow: { min: 35, max: 45 },
      pond: "paakaupunkiseutu",
    },
    profile: {
      displayName: "Riikka",
      bio: "Puuseppä, joka korjaa vanhoja huonekaluja ja keittää parhaan lohikeiton, jonka tiedän. Viikonloppuisin kirpputoreilla. Etsin jotakuta, jolla on aikaa jutella.",
      bioPreset: null,
      fields: {
        languages: ["fi"],
        intent: "long_term",
        hobbies: ["diy", "cooking", "sauna"],
      },
      prompts: [],
    },
    photos: 2,
    afterwards: "nothing",
  },
];

/** The persona of a history; a history without a persona is a mistake in this file. */
export function personaOf(history: PersonaHistory): DemoPersona {
  const persona = DEMO_PERSONAS.find((p) => p.key === history.key);
  if (!persona) throw new Error(`no persona ${history.key}`);
  return persona;
}
