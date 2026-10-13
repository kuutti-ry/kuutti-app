import { z } from "zod";

/**
 * The profile fields (#47, #145, TD-16, ADR-009, ADR-019): one registry, read
 * by the API for validation and for the card, by the app for the form and the
 * card, by the research snapshot of #50 for its coarse categories, and by the
 * population generator of the demo. Each field carries a kind with its options
 * or bounds, and two roles: what the person's own value may do (`role`) and
 * what preference about other people's value may exist (`preferenceAbout`).
 * The roles are data here and nowhere in code paths, so the card, the pool,
 * the round builder and the deal-breakers read one table (ADR-019 §2).
 * `specialCategory` marks an article 9 field: its value is refused until the
 * person has given the explicit consent of the current wording, and it never
 * enters an event (ADR-009 §2, ADR-019 §4). `research` lets a single-choice
 * field into the research snapshot, one field at a time with the nightly
 * census's answer in hand (ADR-011 §9). Option texts are messages.yaml
 * keys `profile.option.<field>.<option>`. A closed list keeps the card free of
 * contact details and of text a moderator would have to read; adding an
 * option is a change here and no migration.
 */

/**
 * What the person's own value may do (ADR-019 §1): `hard` is always in the
 * matching query, both ways; `soft` orders a round and is never shown as a
 * score; `info` is shown on the card and never queried; `hidden` is stored
 * and never shown (a setting).
 */
export type FieldRole = "hard" | "soft" | "info" | "hidden";

/**
 * What preference about other people's value may exist: `hard` always on,
 * both ways; `deal_breaker` an optional hard filter from the whitelist of
 * #149, on a field the person answered themselves; `soft` ordering only;
 * `none` no preference exists.
 */
export type PreferenceAbout = "hard" | "deal_breaker" | "soft" | "none";

type Roles = { role: FieldRole; preferenceAbout: PreferenceAbout; specialCategory?: boolean };
/** Only a single choice may enter the research snapshot (ADR-011 §9): the other helpers do not take the flag. */
type SingleRoles = Roles & { research?: boolean };
type Options = readonly [string, ...string[]];

const roles = (r: SingleRoles) => ({
  role: r.role,
  preferenceAbout: r.preferenceAbout,
  specialCategory: r.specialCategory ?? false,
  research: r.research ?? false,
});

const single = <T extends Options>(options: T, r: SingleRoles) => ({
  kind: "single" as const,
  options,
  ...roles(r),
  schema: z.enum(options),
});

/**
 * What a multi-choice list may say beyond its options: `alone` names the
 * options that are an answer only by themselves ("none of them" next to a
 * party says both; the app clears the others and the contract refuses the
 * mix, #239), `shownFirst` how many lead the picker before the rest is
 * searched for (the languages, #239).
 */
type MultiExtra<T extends Options> = { alone?: readonly T[number][]; shownFirst?: number };

/**
 * Several answers of a closed list, as many as the person likes (the
 * maintainer, #239: "we allow always more data"; what a card shows of them
 * and what matching reads are decisions of their own). The cap is the list
 * itself, so the contract still names one.
 */
const multi = <T extends Options>(options: T, r: Roles, extra: MultiExtra<T> = {}) => {
  const alone: readonly string[] = extra.alone ?? [];
  return {
    kind: "multi" as const,
    options,
    alone,
    shownFirst: extra.shownFirst,
    ...roles(r),
    schema: z
      .array(z.enum(options))
      .min(1)
      .max(options.length)
      .refine((chosen) => new Set(chosen).size === chosen.length, {
        message: "an option was chosen twice",
      })
      .refine((chosen) => chosen.length === 1 || !chosen.some((o) => alone.includes(o)), {
        message: "an option that stands alone was chosen with others",
      }),
  };
};

const text = (maxLength: number, r: Roles) => ({
  kind: "text" as const,
  maxLength,
  ...roles(r),
  schema: z.string().trim().min(1).max(maxLength),
});

/** A whole number inside a closed range; the unit is in the text. */
const integer = (min: number, max: number, r: Roles) => ({
  kind: "number" as const,
  min,
  max,
  ...roles(r),
  schema: z.int().min(min).max(max),
});

/** A setting the person switches on; never shown to anybody. */
const flag = (r: Roles) => ({ kind: "flag" as const, ...roles(r), schema: z.boolean() });

/**
 * Languages by ISO 639-1 code, named in the reader's language like every
 * other option (Finnish, suomi, finska; ADR-019 §3 as amended by #238): a
 * language is not a country and no flag stands for one. In the order of use
 * (#239): the two national languages, English, then by the people of 20 to 64
 * who speak each as their registered language (Statistics Finland, StatFin
 * 11rl, 31.12.2025). The first LANGUAGES_SHOWN_FIRST lead the picker, the
 * rest is found by search, and "other" stays last.
 */
const LANGUAGES = [
  "fi",
  "sv",
  "en",
  "ru",
  "et",
  "uk",
  "ar",
  "fa",
  "zh",
  "so",
  "vi",
  "sq",
  "ku",
  "tl",
  "th",
  "bn",
  "tr",
  "ne",
  "es",
  "ur",
  "de",
  "ro",
  "pl",
  "fr",
  "hi",
  "pt",
  "it",
  "lv",
  "hu",
  "nl",
  "lt",
  "ja",
  "se",
  "ko",
  "other",
] as const;
export const LANGUAGES_SHOWN_FIRST = 10;

/**
 * The hobbies: a fixed list so that shared ones can be highlighted on a card
 * (#150), never a score. Grouped for the chip grid of #148 in HOBBY_GROUPS;
 * "other" stands outside the groups.
 */
export const HOBBIES = [
  "hiking",
  "cycling",
  "running",
  "skiing",
  "swimming",
  "sailing",
  "foraging",
  "fishing",
  "climbing",
  "gym",
  "football",
  "floorball",
  "ice_hockey",
  "yoga",
  "dance",
  "martial_arts",
  "padel",
  "photography",
  "drawing",
  "making_music",
  "writing",
  "crafts",
  "theatre",
  "cooking",
  "baking",
  "coffee",
  "wine_and_beer",
  "reading",
  "cinema",
  "museums",
  "concerts",
  "podcasts",
  "board_games",
  "video_games",
  "chess",
  "puzzles",
  "gardening",
  "sauna",
  "cottage",
  "diy",
  "travelling",
  "road_trips",
  "learning_languages",
  "dogs",
  "cats",
  "horses",
  "birdwatching",
  "programming",
  "electronics",
  "astronomy",
  "volunteering",
  "karaoke",
  "pub_quiz",
  "dinner_parties",
  "meditation",
  "winter_swimming",
  "forest_walks",
  "slow_mornings",
  "other",
] as const;
export type Hobby = (typeof HOBBIES)[number];

export const HOBBY_GROUP_KEYS = [
  "outdoors",
  "sports",
  "creative",
  "food",
  "culture",
  "games",
  "home",
  "travel",
  "animals",
  "tech",
  "social",
  "wellbeing",
] as const;
export type HobbyGroup = (typeof HOBBY_GROUP_KEYS)[number];

/** Every hobby but "other" in exactly one group (a test holds that); texts are profile.hobbyGroup.<group>. */
export const HOBBY_GROUPS: Readonly<Record<HobbyGroup, readonly Hobby[]>> = {
  outdoors: [
    "hiking",
    "cycling",
    "running",
    "skiing",
    "swimming",
    "sailing",
    "foraging",
    "fishing",
    "climbing",
  ],
  sports: ["gym", "football", "floorball", "ice_hockey", "yoga", "dance", "martial_arts", "padel"],
  creative: ["photography", "drawing", "making_music", "writing", "crafts", "theatre"],
  food: ["cooking", "baking", "coffee", "wine_and_beer"],
  culture: ["reading", "cinema", "museums", "concerts", "podcasts"],
  games: ["board_games", "video_games", "chess", "puzzles"],
  home: ["gardening", "sauna", "cottage", "diy"],
  travel: ["travelling", "road_trips", "learning_languages"],
  animals: ["dogs", "cats", "horses", "birdwatching"],
  tech: ["programming", "electronics", "astronomy"],
  social: ["volunteering", "karaoke", "pub_quiz", "dinner_parties"],
  wellbeing: ["meditation", "winter_swimming", "forest_walks", "slow_mornings"],
};

const HEIGHT_MIN_CM = 140;
const HEIGHT_MAX_CM = 220;

/**
 * The parties by their usual abbreviation: the nine of the parliament and the
 * Pirate Party, in the order of their Finnish names, each shown with its logo
 * before the name (#213, ADR-019 §3); the list is refreshed after the
 * election of April 2027. "None of them" is an answer of its own, after the
 * parties and without a logo, and it stands alone (#239). The coffee party
 * left the list on the maintainer's word (#239); migration 0037 took it out
 * of stored answers.
 */
export const POLITICS_OPTIONS = [
  "kesk",
  "kok",
  "kd",
  "liik",
  "ps",
  "pp",
  "rkp",
  "sdp",
  "vas",
  "vihr",
  "none_of_them",
] as const;
/** The options of `politics` that are parties: the ones with a logo. */
export const PARTY_OPTIONS = POLITICS_OPTIONS.filter((option) => option !== "none_of_them");

export const PROFILE_FIELDS = {
  /** Asked in onboarding (#146); "open to either" matches both others (#147). The one field in the research snapshot (ADR-011 §9). */
  intent: single(["long_term", "casual", "open_to_either"], {
    role: "hard",
    preferenceAbout: "hard",
    research: true,
  }),
  /** Offered after a non-binary gender only, by the screen (#146); display only, never matching. */
  identityLabel: single(
    [
      "agender",
      "genderfluid",
      "genderqueer",
      "bigender",
      "two_spirit",
      "questioning",
      "non_binary",
    ],
    { role: "info", preferenceAbout: "none" },
  ),
  monogamy: single(["monogamous", "non_monogamous"], {
    role: "info",
    preferenceAbout: "deal_breaker",
  }),
  hasKids: single(["no", "yes_with_me", "yes_not_with_me"], {
    role: "info",
    preferenceAbout: "deal_breaker",
  }),
  /** The same three answers; the texts adapt to hasKids on the screen (want more, no more; #148). */
  wantsKids: single(["want", "dont_want", "not_sure"], {
    role: "info",
    preferenceAbout: "deal_breaker",
  }),
  /** Vaping is a way of smoking of its own, not a frequency (the maintainer, #239). */
  smoking: single(["never", "sometimes", "regularly", "quitting", "vaping"], {
    role: "info",
    preferenceAbout: "deal_breaker",
  }),
  /** Nicotine that is not smoked (#239): snus, pouches, either or both, or neither, which stands alone; no frequency. Smoking's companion on the later screens. */
  nicotine: multi(
    ["snus", "pouches", "none"],
    { role: "info", preferenceAbout: "none" },
    { alone: ["none"] },
  ),
  languages: multi(
    LANGUAGES,
    { role: "info", preferenceAbout: "deal_breaker" },
    { shownFirst: LANGUAGES_SHOWN_FIRST },
  ),
  /** The Finnish levels; the preference is "similar to mine", with AMK and kandi adjacent (#87). */
  education: single(["peruskoulu", "toinen_aste", "amk", "kandi", "maisteri", "tohtori"], {
    role: "soft",
    preferenceAbout: "soft",
  }),
  drinking: single(["never", "rarely", "socially", "often"], {
    role: "soft",
    preferenceAbout: "soft",
  }),
  /** An attitude, never behaviour: use is an offence, and this sits next to a bank-verified identity (ADR-019 §4). */
  drugsAttitude: single(["not_my_thing", "dont_mind", "fine_with_it"], {
    role: "soft",
    preferenceAbout: "soft",
  }),
  hobbies: multi(HOBBIES, { role: "info", preferenceAbout: "none" }),
  /** Centimetres; display only, never filterable. */
  height: integer(HEIGHT_MIN_CM, HEIGHT_MAX_CM, { role: "info", preferenceAbout: "none" }),
  exercise: single(["never", "sometimes", "weekly", "daily"], {
    role: "info",
    preferenceAbout: "none",
  }),
  pets: multi(["dog", "cat", "other", "none", "allergic"], {
    role: "info",
    preferenceAbout: "none",
  }),
  /** Fields of study or work, as many as apply (#178, #239); a list per university is a configuration of its own, later (ADR-019 §5). */
  field: multi(
    [
      "tech",
      "engineering",
      "business",
      "arts",
      "science",
      "health",
      "education",
      "law",
      "social",
      "trades",
      "service",
      "other",
    ],
    { role: "info", preferenceAbout: "none" },
  ),
  /** "Hide me from my field": people of the same field never see this person; the round builder of #95 reads it. */
  hideFromField: flag({ role: "hidden", preferenceAbout: "none" }),
  /** Lines of work, as many as apply (#178, #239). */
  occupation: multi(
    [
      "student",
      "tech",
      "healthcare",
      "education",
      "business",
      "arts_culture",
      "science",
      "trades_construction",
      "service_hospitality",
      "public_sector",
      "transport",
      "agriculture",
      "media",
      "law_finance",
      "sports",
      "entrepreneur",
      "between_jobs",
      "retired",
      "other",
    ],
    { role: "info", preferenceAbout: "none" },
  ),
  /** A short title in the person's words and no employer's name: under the plain-text rule like every free text. */
  occupationTitle: text(40, { role: "info", preferenceAbout: "none" }),
  /** Article 9: the parties the person could vote for, or none of them; shown only when filled, never a filter. */
  politics: multi(
    POLITICS_OPTIONS,
    { role: "info", preferenceAbout: "none", specialCategory: true },
    { alone: ["none_of_them"] },
  ),
  /** Article 9; a deal-breaker only after the Ombudsman's answer (ADR-019 §4). The list is the maintainer's. */
  /** The religions by their share of the people of Finland (Statistics Finland, 2023; the maintainer, 10/10/2026), the stances after them. */
  religion: single(
    [
      "lutheran",
      "orthodox",
      "other_christian",
      "muslim",
      "buddhist",
      "hindu",
      "jewish",
      "spiritual",
      "agnostic",
      "atheist",
      "other",
    ],
    { role: "info", preferenceAbout: "none", specialCategory: true },
  ),
  /** Self-declared: nothing stored could derive it (no birth day, rule 3). The thirteenth sign is the attitude, and it sits among the twelve, not after them (the maintainer, 10/10/2026). */
  zodiac: single(
    [
      "aries",
      "taurus",
      "gemini",
      "cancer",
      "leo",
      "virgo",
      "corgi",
      "libra",
      "scorpio",
      "sagittarius",
      "capricorn",
      "aquarius",
      "pisces",
    ],
    { role: "info", preferenceAbout: "none" },
  ),
} as const;

export type ProfileFieldKey = keyof typeof PROFILE_FIELDS;
export const PROFILE_FIELD_KEYS = Object.keys(PROFILE_FIELDS) as ProfileFieldKey[];

/** The fields whose value needs the explicit consent of the current wording first (ADR-009 §2, ADR-019 §4). */
export const SPECIAL_CATEGORY_FIELDS = PROFILE_FIELD_KEYS.filter(
  (key) => PROFILE_FIELDS[key].specialCategory,
);

/**
 * The fields a card carries (ADR-019 §2): what is there to be seen (info) and
 * what both sides matched on (hard); never a soft value, never a setting.
 */
export const CARD_FIELD_KEYS = PROFILE_FIELD_KEYS.filter((key) => {
  const role = PROFILE_FIELDS[key].role;
  return role === "info" || role === "hard";
});

/**
 * The optional fields as the screens after the gate ask them, one per
 * screen with "Ask me later", in the field sheet's order (#148, TD-16).
 * Intent and the identity label are onboarding's; a companion field shares
 * its screen with the one it belongs to.
 */
export const LATER_FIELD_ORDER: readonly ProfileFieldKey[] = [
  "hasKids",
  "wantsKids",
  "smoking",
  "languages",
  "education",
  "drinking",
  "drugsAttitude",
  "hobbies",
  "height",
  "exercise",
  "pets",
  "field",
  "occupation",
  "politics",
  "religion",
  "zodiac",
];
export const LATER_COMPANIONS: Readonly<Partial<Record<ProfileFieldKey, ProfileFieldKey>>> = {
  smoking: "nicotine",
  field: "hideFromField",
  occupation: "occupationTitle",
};

/** The fields a deal-breaker may be set on (#149), always one the person answered themselves. */
export const DEAL_BREAKER_FIELDS = PROFILE_FIELD_KEYS.filter(
  (key) => PROFILE_FIELDS[key].preferenceAbout === "deal_breaker",
);

/** Every field optional: unanswered is a legitimate state, never a default value. A test holds the keys to the registry's. */
export const ProfileFields = z
  .object({
    intent: PROFILE_FIELDS.intent.schema.optional(),
    identityLabel: PROFILE_FIELDS.identityLabel.schema.optional(),
    monogamy: PROFILE_FIELDS.monogamy.schema.optional(),
    hasKids: PROFILE_FIELDS.hasKids.schema.optional(),
    wantsKids: PROFILE_FIELDS.wantsKids.schema.optional(),
    smoking: PROFILE_FIELDS.smoking.schema.optional(),
    nicotine: PROFILE_FIELDS.nicotine.schema.optional(),
    languages: PROFILE_FIELDS.languages.schema.optional(),
    education: PROFILE_FIELDS.education.schema.optional(),
    drinking: PROFILE_FIELDS.drinking.schema.optional(),
    drugsAttitude: PROFILE_FIELDS.drugsAttitude.schema.optional(),
    hobbies: PROFILE_FIELDS.hobbies.schema.optional(),
    height: PROFILE_FIELDS.height.schema.optional(),
    exercise: PROFILE_FIELDS.exercise.schema.optional(),
    pets: PROFILE_FIELDS.pets.schema.optional(),
    field: PROFILE_FIELDS.field.schema.optional(),
    hideFromField: PROFILE_FIELDS.hideFromField.schema.optional(),
    occupation: PROFILE_FIELDS.occupation.schema.optional(),
    occupationTitle: PROFILE_FIELDS.occupationTitle.schema.optional(),
    politics: PROFILE_FIELDS.politics.schema.optional(),
    religion: PROFILE_FIELDS.religion.schema.optional(),
    zodiac: PROFILE_FIELDS.zodiac.schema.optional(),
  })
  .strict()
  .meta({ id: "ProfileFields" });
export type ProfileFields = z.infer<typeof ProfileFields>;

/** What of a profile's fields goes on a card: the card fields only (ADR-019 §2). */
export function cardFields(fields: ProfileFields): ProfileFields {
  const out: Record<string, unknown> = {};
  for (const key of CARD_FIELD_KEYS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return out as ProfileFields;
}
