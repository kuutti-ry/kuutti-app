import { type AnyLocale, type PlainMessageKey, realLocale } from "@kuutti/i18n";
import {
  BIO_MIN_FOR_COMPLETENESS,
  type BioPreset,
  type CompletenessItem,
  type DealBreakerField,
  type Gender,
  type HomeSummary,
  PHOTOS_FOR_COMPLETENESS,
  type PlaceName,
  type PromptKey,
} from "@kuutti/schema";
import type { useT } from "@/lib/locale";

// The registry in packages/schema names fields, options, prompts and
// placeholder bios by key; their texts are messages.yaml entries with the
// same key. ProfileScreen.test.tsx renders every one of them and fails on a
// text that is still a key, which keeps the catalogue and the registry equal.
// `distance` is a deal-breaker with no field of the registry (ADR-061 §7), and
// its options are the four bands, the words of a card's line as of the filter.

/** The gender word of the card (#150): the same word onboarding asks with. */
export const genderKey = (gender: Gender): PlainMessageKey =>
  `onboarding.gender.${gender}` as PlainMessageKey;

/** Whom one seeks, in the words of the seeks step (#146): one gender as the person wants to see it. */
export const seeksKey = (gender: Gender): PlainMessageKey =>
  `onboarding.seeks.${gender}` as PlainMessageKey;

export const fieldLabelKey = (field: DealBreakerField): PlainMessageKey =>
  `profile.field.${field}` as PlainMessageKey;

export const optionKey = (field: DealBreakerField, option: string): PlainMessageKey =>
  `profile.option.${field}.${option}` as PlainMessageKey;

/**
 * An answer as a deal-breaker names it, which is about somebody else (#551):
 * where the person's own words are in the first person ("En koskaan", "Yes,
 * living with me"), a filter has words of its own. The value stored is the same.
 */
export const filterOptionKey = (field: DealBreakerField, option: string): PlainMessageKey =>
  field === "hasKids" || field === "wantsKids" || (field === "smoking" && option === "never")
    ? (`profile.filterOption.${field}.${option}` as PlainMessageKey)
    : optionKey(field, option);

export const promptKey = (key: PromptKey): PlainMessageKey =>
  `profile.prompt.${key}` as PlainMessageKey;

export const presetKey = (key: BioPreset): PlainMessageKey =>
  `profile.bioPreset.${key}` as PlainMessageKey;

/**
 * A place's name in the reader's language (ADR-061 §3): the list has Finnish
 * and Swedish, English reads Finnish, and Stadi is Finnish here, a place's
 * name being no joke. Always on a line of its own or after a colon: no
 * sentence is built around it (TD-17).
 */
export const placeName = (place: PlaceName, locale: AnyLocale): string =>
  realLocale(locale) === "sv" ? place.sv : place.fi;

/** What the person's own card says of their home: the area where they chose it, else the town. */
export const shownPlaceName = (home: HomeSummary, locale: AnyLocale): string =>
  placeName(home.showArea && home.area ? home.area : home.town, locale);

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
