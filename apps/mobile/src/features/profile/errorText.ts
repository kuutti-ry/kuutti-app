import type { PlainMessageKey } from "@kuutti/i18n";
import type { useT } from "@/lib/locale";
import type { ProfileNotice } from "./useProfile";

/** The API's refusals of a save the app has its own words for; anything else is the fallback's. */
const ERROR_TEXT: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["text_contact_details", "profile.error.text_contact_details"],
  ["consent_required", "errors.special_category_locked"],
  ["filter_unanswered", "profile.dealBreakers.gated"],
]);

/**
 * What a refused save says, wherever the profile is edited: the sections, a
 * later question, onboarding's steps and a deal-breaker all read the same table
 * (#223). A screen with nothing to check (a deal-breaker, #551) names its own
 * fallback for the rest.
 */
export function profileErrorText(
  notice: ProfileNotice,
  t: ReturnType<typeof useT>["t"],
  fallback: PlainMessageKey = "profile.error.generic",
): string {
  const code = notice?.kind === "error" ? notice.code : undefined;
  return t(ERROR_TEXT.get(code ?? "") ?? fallback);
}
