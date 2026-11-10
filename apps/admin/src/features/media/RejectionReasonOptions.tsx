import { useT } from "@kuutti/i18n/react";
import { REJECTION_REASONS } from "./reasons.ts";

/**
 * The options of a photo's rejection reason: none chosen first, which cannot
 * be chosen back, then the reasons in order. The queue's (#49) and a
 * take-down's on a person's page (#477).
 */
export function RejectionReasonOptions() {
  const { t } = useT();
  return (
    <>
      <option value="" disabled>
        {t("admin.queue.reason.choose")}
      </option>
      {REJECTION_REASONS.map((reason) => (
        <option key={reason.value} value={reason.value}>
          {t(reason.label)}
        </option>
      ))}
    </>
  );
}
