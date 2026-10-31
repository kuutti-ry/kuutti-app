import type { ReactNode } from "react";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { useGate } from "./useGate";

/**
 * Whether matching is open for the person (#500, ADR-060 §4), one sentence for
 * each of three things: the profile lacks something, it is finished and their
 * area has not opened, or open. No number and nothing that can be tapped to
 * move ahead. Once matching is open, the card carries what the home screen
 * hands it for that: the way to today's round (#379).
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
          {gate?.state === "closed" && <Text>{t("pond.gate.closed")}</Text>}
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
