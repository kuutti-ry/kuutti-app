import type { PondSummary } from "@kuutti/schema";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { pondName } from "./names";
import { SeeksBar } from "./SeeksBar";
import { usePondCounter } from "./usePondCounter";

/**
 * How the person's own pond is filling up (#54, ADR-013): the counter's
 * figures, in words. Below the threshold no number is said, here as
 * everywhere, and the card says why the numbers stand still for a while: they
 * move in steps of at least k people. The pond's name stands on a line of its
 * own, in the nominative and in the person's language (#174): no sentence is
 * built around it (TD-17). The bar of whom the people there seek stands under
 * the total, once the pond may say it (#507).
 */
export function PondCard({ pond }: { pond: PondSummary }) {
  const { t } = useT();
  const tap = useHapticTap();
  const counter = usePondCounter(pond.id);
  const figures = counter.status === "ready" ? counter.figures : null;

  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("pond.counter.label")} className="gap-6">
        <CardHeader>
          <CardDescription>{t("pond.counter.title")}</CardDescription>
          <CardTitle>{pondName(t, pond)}</CardTitle>
        </CardHeader>
        <CardContent className="gap-2">
          {counter.status === "loading" && (
            <Text accessibilityLiveRegion="polite">{t("pond.counter.loading")}</Text>
          )}
          {counter.status === "failed" && (
            <LoadFailed
              headline={t("pond.counter.failed")}
              error={counter.error}
              onRetry={() => {
                tap();
                counter.retry();
              }}
            />
          )}
          {counter.status === "ready" &&
            (figures === null || figures.verified === null ? (
              <Text>{t("pond.counter.small", { k: counter.k })}</Text>
            ) : (
              <>
                <Text>{t("pond.counter.verified", { people: figures.verified })}</Text>
                {figures.seeks && <SeeksBar seeks={figures.seeks} />}
                {figures.finishing !== null && (
                  <Text>{t("pond.counter.finishing", { people: figures.finishing })}</Text>
                )}
              </>
            ))}
          {counter.status === "ready" && figures !== null && figures.verified !== null && (
            <Text variant="muted">{t("pond.counter.steps", { k: counter.k })}</Text>
          )}
        </CardContent>
      </View>
    </Card>
  );
}
