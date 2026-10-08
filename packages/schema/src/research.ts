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
 * The profile fields an event may carry: the closed lists only (`single`,
 * `multi`), never a text, a number or a setting, and never a field flagged
 * `specialCategory` (ADR-009 §2, ADR-019 §4). Computed from the registry, so
 * a new field is out until it is one of those kinds, and a flag on a field
 * takes it out the same day.
 */
export const RESEARCH_FIELD_KEYS = PROFILE_FIELD_KEYS.filter((key) => {
  const spec = PROFILE_FIELDS[key];
  return (
    (spec.kind === "single" || spec.kind === "multi") &&
    !spec.specialCategory &&
    spec.role !== "hidden"
  );
});

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

/** One event as the export shows it to the person: everything the row holds except the ids. The name is a string, not the enum, so an event retired from the registry still exports while its partition lives. */
export const ResearchEventRecord = z
  .object({
    name: z.string().min(1).max(80),
    at: z.iso.datetime(),
    consentVersion: z.string().min(1).max(80),
    /** The pond's slug, or null for an event before the person chose one. */
    pond: z.string().min(1).max(60).nullable(),
    /** As stored; a string like the name, so a renamed band still exports. */
    ageBand: z.string().min(1).max(12),
    snapshot: ResearchSnapshot,
    props: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "ResearchEventRecord" });
export type ResearchEventRecord = z.infer<typeof ResearchEventRecord>;

export const RESEARCH_EXPORT_EVENTS_MAX = 1000;

/** What research holds about the person, for the export (#51): the enrolment and the events, never the research_id. */
export const ResearchExport = z
  .object({
    enrolled: z.boolean(),
    since: z.iso.datetime().nullable(),
    consentVersion: z.string().min(1).max(80).nullable(),
    /** Newest first, at most 1000. Empty when not enrolled: the events cannot be found, which is the point. */
    events: z.array(ResearchEventRecord).max(RESEARCH_EXPORT_EVENTS_MAX),
  })
  .meta({ id: "ResearchExport" });
export type ResearchExport = z.infer<typeof ResearchExport>;
