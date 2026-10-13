import {
  PHOTOS_FOR_COMPLETENESS,
  PROFILE_FIELDS,
  PROMPTS_MAX,
  type ProfileFieldKey,
  type ProfileUpdate,
} from "@kuutti/schema";
import type { ProfileSection, SectionItem } from "./sections";

/** How much of one part of the profile is answered (#239); done when every part counted is. */
export type Progress = { answered: number; total: number };

export const isDone = ({ answered, total }: Progress) => answered >= total;

/**
 * Whether a field's answer is one a part of the profile waits for: every
 * choice and number. Not a setting (hide me from my field), which off is a
 * choice and not a gap, and not a free text (the job title), so a student or
 * a retired person is not left short forever. The list's marks and the later
 * screens' walk both read it (#239).
 */
export const countsAsAnswer = (field: ProfileFieldKey): boolean =>
  PROFILE_FIELDS[field].kind !== "flag" && PROFILE_FIELDS[field].kind !== "text";

/** The prompts that hold an answer: what a save keeps (useProfile leaves an empty one out). */
export const answeredPrompts = (prompts: ProfileUpdate["prompts"]): number =>
  prompts.filter((prompt) => prompt.answer.trim() !== "").length;

/**
 * What one item of a section adds to its progress: an answer that counts
 * (countsAsAnswer), other nicotine among them (#239). Not the identity label,
 * which the section shows only once it is given.
 */
function itemProgress(item: SectionItem, profile: ProfileUpdate): Progress {
  switch (item) {
    case "displayName":
      return { answered: profile.displayName.trim() === "" ? 0 : 1, total: 1 };
    case "bio":
      return { answered: profile.bio !== null || profile.bioPreset !== null ? 1 : 0, total: 1 };
    case "prompts":
      return {
        answered: Math.min(answeredPrompts(profile.prompts), PROMPTS_MAX),
        total: PROMPTS_MAX,
      };
    case "identityLabel":
      return { answered: 0, total: 0 };
    default:
      if (!countsAsAnswer(item)) return { answered: 0, total: 0 };
      return { answered: profile.fields[item] === undefined ? 0 : 1, total: 1 };
  }
}

/**
 * A section's progress for its row on the profile list (#239): each field
 * answered counts one, the prompts count each answered one of three. Every
 * field is optional (ADR-019), so this is no task list: the row says how far
 * the section is filled, and a check mark once it is.
 */
export function sectionProgress(section: ProfileSection, profile: ProfileUpdate): Progress {
  return section.items.reduce<Progress>(
    (sum, item) => {
      const one = itemProgress(item, profile);
      return { answered: sum.answered + one.answered, total: sum.total + one.total };
    },
    { answered: 0, total: 0 },
  );
}

/** The photos' progress: approved photos of the ones a card needs, done once it has them. */
export const photoProgress = (approved: number): Progress => ({
  answered: Math.min(approved, PHOTOS_FOR_COMPLETENESS),
  total: PHOTOS_FOR_COMPLETENESS,
});
