import type { PlainMessageKey } from "@kuutti/i18n";
import {
  BIO_MIN_FOR_COMPLETENESS,
  type BioPreset,
  type CompletenessItem,
  type Gender,
  PHOTOS_FOR_COMPLETENESS,
  type ProfileFieldKey,
  type PromptKey,
} from "@kuutti/schema";
import type { useT } from "@/lib/locale";

// The registry in packages/schema names fields, options, prompts and
// placeholder bios by key; their texts are messages.yaml entries with the
// same key. ProfileScreen.test.tsx renders every one of them and fails on a
// text that is still a key, which keeps the catalogue and the registry equal.

/** The gender word of the card (#150): the same word onboarding asks with. */
export const genderKey = (gender: Gender): PlainMessageKey =>
  `onboarding.gender.${gender}` as PlainMessageKey;

export const fieldLabelKey = (field: ProfileFieldKey): PlainMessageKey =>
  `profile.field.${field}` as PlainMessageKey;

export const optionKey = (field: ProfileFieldKey, option: string): PlainMessageKey =>
  `profile.option.${field}.${option}` as PlainMessageKey;

export const promptKey = (key: PromptKey): PlainMessageKey =>
  `profile.prompt.${key}` as PlainMessageKey;

export const presetKey = (key: BioPreset): PlainMessageKey =>
  `profile.bioPreset.${key}` as PlainMessageKey;

/** What is missing, in words; the two thresholds come from the contract, not from the text. */
export function completenessText(t: ReturnType<typeof useT>["t"], item: CompletenessItem): string {
  switch (item) {
    case "photos":
      return t("profile.completeness.photos", { min: PHOTOS_FOR_COMPLETENESS });
    case "bio_or_prompts":
      return t("profile.completeness.bio_or_prompts", { min: BIO_MIN_FOR_COMPLETENESS });
    case "display_name":
      return t("profile.completeness.display_name");
    case "seeks":
      return t("profile.completeness.seeks");
    case "age_window":
      return t("profile.completeness.age_window");
  }
}
