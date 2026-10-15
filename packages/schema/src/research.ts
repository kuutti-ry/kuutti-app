import { z } from "zod";
import { Gender } from "./onboarding.ts";
import { PROFILE_FIELD_KEYS, PROFILE_FIELDS, type ProfileFieldKey } from "./profile-fields.ts";

/**
 * The research event registry (#50, TD-5, ADR-011): one entry per event name,
 * with the question it answers and a strict schema for its props. `track()` in
 * the API refuses anything not named here, so message text, free text, e-mail
 * and raw `seeks` stay out of every event by construction (rules/schema.md).
 * Every event also carries the consent version, the pond and the coarse
 * snapshot below, added by the API from the rows, never by the caller.
 * Adding an event is a change here with the one-line question it answers.
 */

const props = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const RESEARCH_EVENTS = {
  research_opt_in: {
    question: "When in their journey do people join the study, and is the account active by then?",
    props: props({
      /** Whole days from registration to the opt-in: coarse on purpose, so the tombstone's registration time cannot be recovered from an event (ADR-011 §1). */
      sinceRegistrationD: z.int().min(0),
      accountActive: z.boolean(),
    }),
  },
  profile_saved: {
    question: "Do profiles get finished, and how many approved photos do they have when saved?",
    props: props({
      complete: z.boolean(),
      approvedPhotos: z.int().min(0).max(50),
    }),
  },
  account_paused: {
    question: "How many people step away for a while rather than delete (#170)?",
    props: props({}),
  },
  account_resumed: {
    question: "How long do breaks last before the person comes back (#170)?",
    props: props({
      /** Whole days from the pause to the login that ended it: coarse on purpose, like sinceRegistrationD. */
      afterDays: z.int().min(0),
    }),
  },
} as const;

export type ResearchEventName = keyof typeof RESEARCH_EVENTS;
export const RESEARCH_EVENT_NAMES = Object.keys(RESEARCH_EVENTS) as ResearchEventName[];
export const ResearchEventName = z.enum(
  RESEARCH_EVENT_NAMES as [ResearchEventName, ...ResearchEventName[]],
);

export type ResearchEventProps<N extends ResearchEventName> = z.infer<
  (typeof RESEARCH_EVENTS)[N]["props"]
>;

/** Age in whole years, banded: coarse enough that a band and a pond name nobody (rule 5). */
export const AGE_BANDS = ["18-24", "25-29", "30-34", "35-39", "40-49", "50+"] as const;
export const AgeBand = z.enum(AGE_BANDS).meta({ id: "AgeBand" });
export type AgeBand = z.infer<typeof AgeBand>;

export function ageBandOf(age: number): AgeBand {
  if (age < 25) return "18-24";
  if (age < 30) return "25-29";
  if (age < 35) return "30-34";
  if (age < 40) return "35-39";
  if (age < 50) return "40-49";
  return "50+";
}

/**
 * The profile fields an event may carry (ADR-011 §9): the ones the registry
 * flags `research`. Only the registry's `single()` takes the flag, so a multi
 * (a set of fifty-nine hobbies is a fingerprint, not a category), a text, a
 * number or a setting cannot carry it by type; that a flagged field is
 * neither `specialCategory` (ADR-009 §2, ADR-019 §4) nor hidden is the
 * registry's test. Computed from the registry, so a field is out until it is
 * flagged, and a flag on a field takes it out the same day.
 */
export const RESEARCH_FIELD_KEYS = PROFILE_FIELD_KEYS.filter((key) => PROFILE_FIELDS[key].research);

/**
 * The floor of k for the research block (ADR-011 §9): a cell of pond, age band
 * and snapshot must hold at least this many pseudonyms in any copy that leaves
 * the operational database, and the nightly census warns when the live table
 * has a cell under it. The waitlist's floor (rules/schema.md), and like the
 * retention a rule, not a `matching_config` row.
 */
export const RESEARCH_K_MIN = 10;

const researchFieldShape = Object.fromEntries(
  RESEARCH_FIELD_KEYS.map((key) => [key, PROFILE_FIELDS[key].schema.optional()]),
) as { [K in ProfileFieldKey]?: z.ZodOptional<(typeof PROFILE_FIELDS)[K]["schema"]> };

export const ResearchFields = z.object(researchFieldShape).strict().meta({ id: "ResearchFields" });
export type ResearchFields = z.infer<typeof ResearchFields>;

/**
 * What a stored profile document contributes to a snapshot: each research
 * field whose value still parses against the registry; anything else, an
 * unknown key, a text field, a removed option, is left out, never copied.
 */
export function researchFieldsOf(fields: unknown): ResearchFields {
  const out: Record<string, unknown> = {};
  if (typeof fields !== "object" || fields === null) return out as ResearchFields;
  for (const key of RESEARCH_FIELD_KEYS) {
    const parsed = PROFILE_FIELDS[key].schema.safeParse((fields as Record<string, unknown>)[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as ResearchFields;
}

/** The coarse snapshot every event carries, taken from the rows at the moment of the event. */
export const ResearchSnapshot = z
  .object({
    gender: Gender.nullable(),
    fields: ResearchFields,
  })
  .strict()
  .meta({ id: "ResearchSnapshot" });
export type ResearchSnapshot = z.infer<typeof ResearchSnapshot>;

/**
 * What research holds about the person, for the export (#51): the enrolment
 * alone, never the research_id. The events are not in it (ADR-011 §10): they
 * are the researchers' material, pseudonymised while the mapping row lives and
 * anonymised in every copy that leaves the database, not a record about the
 * person.
 */
export const ResearchExport = z
  .object({
    enrolled: z.boolean(),
    since: z.iso.datetime().nullable(),
    consentVersion: z.string().min(1).max(80).nullable(),
  })
  .meta({ id: "ResearchExport" });
export type ResearchExport = z.infer<typeof ResearchExport>;
