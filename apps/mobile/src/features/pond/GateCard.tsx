import type { ReactNode } from "react";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { useGate } from "./useGate";

/**
 * Where the person stands between a finished profile and the first round
 * (#94, ADR-015): in line for their area, let in and waiting for enough
 * people who match, or open. In words, with the reason beside every number:
 * why there is a line, who counts, and why the numbers are round. They are
 * shown as they were served, in steps; the card works nothing out of them.
 * Nothing here names a gender, and nothing can be tapped to move ahead.
 * Once matching is open, the card carries what the home screen hands it for
 * that: the way to today's round (#379).
 */
export function GateCard({ whenOpen }: { whenOpen?: ReactNode }) {
  const { t } = useT();
  const tap = useHapticTap();
  const view = useGate();
  const gate = view.status === "ready" ? view.gate : null;

  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("pond.gate.label")} className="gap-6">
        <CardHeader>
          <CardDescription>{t("pond.gate.title")}</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          {view.status === "loading" && (
            <Text accessibilityLiveRegion="polite">{t("pond.gate.loading")}</Text>
          )}
          {view.status === "failed" && (
            <LoadFailed
              headline={t("pond.gate.failed")}
              error={view.error}
              onRetry={() => {
                tap();
                view.retry();
              }}
            />
          )}
          {gate?.state === "incomplete" && <Text>{t("pond.gate.incomplete")}</Text>}
          {gate?.state === "pending" && <Text>{t("pond.gate.pending")}</Text>}
          {gate?.state === "waiting" && gate.within !== null && (
            <>
              <Text>{t("pond.gate.waiting", { within: gate.within })}</Text>
              <Text variant="muted">{t("pond.gate.waiting.why")}</Text>
              <Text variant="muted">{t("pond.gate.steps", { step: gate.step })}</Text>
            </>
          )}
          {gate?.state === "closed" && gate.needed !== null && (
            <>
              <Text>{t("pond.gate.closed", { needed: gate.needed })}</Text>
              <Text variant="muted">{t("pond.gate.closed.who")}</Text>
              <Text variant="muted">{t("pond.gate.steps", { step: gate.step })}</Text>
            </>
          )}
          {gate?.state === "open" && (
            <>
              <Text>{t("pond.gate.open")}</Text>
              {whenOpen}
            </>
          )}
        </CardContent>
      </View>
    </Card>
  );
}
