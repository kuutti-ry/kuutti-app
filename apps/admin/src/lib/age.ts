import { useT } from "@kuutti/i18n/react";
import { useCallback } from "react";

// How long something has waited (#303, #311), measured by the API's clock,
// which each answer that needs it carries, never by the browser's: a
// moderator's machine may be set to any time.

const HOUR_MS = 3_600_000;

/** Past the response time the association promises (#299), at the API's `now`. */
export function isLate(since: string, now: string, responseHours: number): boolean {
  return Date.parse(now) - Date.parse(since) > responseHours * HOUR_MS;
}

/** How long from `since` to the API's `now`, in the coarsest unit that still says it. */
export function useAge(): (since: string, now: string) => string {
  const { t } = useT();
  return useCallback(
    (since: string, now: string) => {
      const hours = Math.floor((Date.parse(now) - Date.parse(since)) / HOUR_MS);
      if (hours < 1) return t("admin.age.lessThanHour");
      if (hours < 48) return t("admin.age.hours", { hours });
      return t("admin.age.days", { days: Math.floor(hours / 24) });
    },
    [t],
  );
}
