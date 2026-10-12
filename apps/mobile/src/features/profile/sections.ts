import type { PlainMessageKey } from "@kuutti/i18n";
import type { ProfileFieldKey } from "@kuutti/schema";

/** What a section edits: a field of the registry, or one of the document's own parts. */
export type SectionItem = ProfileFieldKey | "displayName" | "bio" | "prompts";

/**
 * The profile in sections (#227): a list on `/profile`, each section its own
 * screen that saves on leaving. Every field of the registry is in exactly one
 * section (the test holds it), so a new field cannot be left off the profile.
 */
export const PROFILE_SECTIONS = [
  { id: "basics", items: ["displayName", "identityLabel", "bio", "height", "languages"] },
  { id: "prompts", items: ["prompts"] },
  { id: "relationship", items: ["intent", "monogamy", "hasKids", "wantsKids"] },
  {
    id: "work",
    items: ["education", "field", "hideFromField", "occupation", "occupationTitle"],
  },
  { id: "lifestyle", items: ["smoking", "drinking", "drugsAttitude", "exercise", "pets"] },
  { id: "hobbies", items: ["hobbies"] },
  { id: "beliefs", items: ["politics", "religion", "zodiac"] },
] as const satisfies ReadonlyArray<{ id: string; items: readonly SectionItem[] }>;

export type SectionId = (typeof PROFILE_SECTIONS)[number]["id"];
export type ProfileSection = { id: SectionId; items: readonly SectionItem[] };

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

export const sectionTitleKey = (id: SectionId) => `profile.section.${id}.title` as PlainMessageKey;
export const sectionSummaryKey = (id: SectionId) =>
  `profile.section.${id}.summary` as PlainMessageKey;
