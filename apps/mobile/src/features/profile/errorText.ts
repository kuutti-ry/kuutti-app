import type { PlainMessageKey } from "@kuutti/i18n";
import type { useT } from "@/lib/locale";
import type { ProfileNotice } from "./useProfile";

/** The API's refusals of a save the app has its own words for; anything else is the generic line. */
const ERROR_TEXT: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["text_contact_details", "profile.error.text_contact_details"],
  ["consent_required", "errors.special_category_locked"],
]);

/**
 * What a refused save says, wherever the profile is edited: the sections, a
 * later question and onboarding's steps all read the same table (#223).
 */
export function profileErrorText(notice: ProfileNotice, t: ReturnType<typeof useT>["t"]): string {
  const code = notice?.kind === "error" ? notice.code : undefined;
  return t(ERROR_TEXT.get(code ?? "") ?? "profile.error.generic");
}
