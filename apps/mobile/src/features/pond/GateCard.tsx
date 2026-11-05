import type { ReactNode } from "react";
import { LoadFailed } from "@/components/LoadFailed";
import { Card, CardContent } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { useGate } from "./useGate";

/**
 * Whether matching is open for the person (#500, ADR-060 §4), one sentence for
 * each of three things: the profile lacks something, it is finished and
 * matching has not opened, or open. Each says Matching, so the card has no name
 * of its own to draw or to hear (#581): a label here would reach no phone, since a
 * plain view is flattened away, and `accessible` would fold See people into one
 * element. No number and nothing that can be tapped to move ahead. Once matching
 * is open, the card carries what the home screen hands it for that: the way to
 * the queue (#379, ADR-062).
 */
export function GateCard({ whenOpen }: { whenOpen?: ReactNode }) {
  const { t } = useT();
  const tap = useHapticTap();
  const view = useGate();
  const gate = view.status === "ready" ? view.gate : null;

  return (
    <Card className="w-full max-w-md">
      <CardContent className="gap-2">
        {view.status === "loading" && (
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        )}
        {view.status === "failed" && (
          <LoadFailed
            error={view.error}
            onRetry={() => {
              tap();
              view.retry();
            }}
          />
        )}
        {gate?.state === "incomplete" && <Text>{t("pond.gate.incomplete")}</Text>}
        {gate?.state === "closed" && <Text>{t("pond.gate.closed")}</Text>}
        {gate?.state === "open" && (
          <>
            <Text>{t("pond.gate.open")}</Text>
            {whenOpen}
          </>
        )}
      </CardContent>
    </Card>
  );
}
