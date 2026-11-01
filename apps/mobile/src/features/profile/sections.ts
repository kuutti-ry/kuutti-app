import type { PlainMessageKey } from "@kuutti/i18n";
import type { ProfileFieldKey } from "@kuutti/schema";

/** What a section edits: a field of the registry, or one of the document's own parts. */
export type SectionItem = ProfileFieldKey | "displayName" | "bio" | "prompts";

/**
 * The profile in sections (#227): a list on `/profile`, each section its own
 * screen that saves on leaving. Every field of the registry is in exactly one
 * section (the test holds it), so a new field cannot be left off the profile.
 * What one is here for is a section of its own, opened from What you seek
 * (#542): one answer, one door, so the profile's list leaves it out.
 */
export const PROFILE_SECTIONS = [
  { id: "basics", items: ["displayName", "identityLabel", "bio", "height", "languages"] },
  { id: "prompts", items: ["prompts"] },
  { id: "intent", items: ["intent"] },
  { id: "relationship", items: ["monogamy", "hasKids", "wantsKids"] },
  {
    id: "work",
    items: ["education", "field", "hideFromField", "occupation", "occupationTitle"],
  },
  {
    id: "lifestyle",
    items: ["smoking", "nicotine", "drinking", "drugsAttitude", "exercise", "pets"],
  },
  { id: "hobbies", items: ["hobbies"] },
  { id: "beliefs", items: ["politics", "religion", "zodiac"] },
] as const satisfies ReadonlyArray<{ id: string; items: readonly SectionItem[] }>;

export type SectionId = (typeof PROFILE_SECTIONS)[number]["id"];
export type ProfileSection = { id: SectionId; items: readonly SectionItem[] };

/** The section What you seek opens, and the only one the profile's list has no row for. */
export const INTENT_SECTION = "intent" satisfies SectionId;

/** The sections with a row on the profile's list. */
export const LISTED_SECTIONS: readonly ProfileSection[] = PROFILE_SECTIONS.filter(
  (section) => section.id !== INTENT_SECTION,
);

export const sectionPath = (id: SectionId) => `/profile/section/${id}` as const;

export function findSection(id: string): ProfileSection | undefined {
  return PROFILE_SECTIONS.find((section) => section.id === id);
}

/** The section that holds an item; every item is in exactly one (the test holds it). */
export function sectionOf(item: SectionItem): SectionId {
  const section = PROFILE_SECTIONS.find((s) => (s.items as readonly SectionItem[]).includes(item));
  if (!section) throw new Error(`no section holds ${item}`);
  return section.id;
}

/** A section's title; What you seek names what one is here for by onboarding's own question. */
export const sectionTitleKey = (id: SectionId): PlainMessageKey =>
  id === INTENT_SECTION
    ? "onboarding.intent.title"
    : (`profile.section.${id}.title` as PlainMessageKey);
export const sectionSummaryKey = (id: SectionId) =>
  `profile.section.${id}.summary` as PlainMessageKey;
