import { useT } from "@kuutti/i18n/react";
import { Clock } from "lucide-react";
import { badgeVariants } from "../../components/ui/badge.tsx";

/**
 * What has waited past its hours, after a space: a clock and the words, never
 * the colour alone (#303). The overview's queues, a report in the queue and an
 * automatic ban.
 */
export function Late({ hours }: { hours: number }) {
  const { t } = useT();
  return (
    <>
      {" "}
      <strong className={badgeVariants({ variant: "destructive" })}>
        <Clock aria-hidden="true" />
        {t("admin.late", { hours: String(hours) })}
      </strong>
    </>
  );
}
