import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { SeeksBar } from "./SeeksBar";
import { usePondCounter } from "./usePondCounter";

/**
 * How many people are on Kuutti (#54, ADR-013): the counter's figures, in
 * words. Below the threshold no number is said, here as everywhere, and the
 * card says why the numbers stand still for a while: they move in steps of at
 * least k people. There is one pond, the country (ADR-061 §8), so the card
 * names no area (#500). The bar of whom those people seek stands under the
 * total, once it may be said (#507).
 */
export function PondCard() {
  const { t } = useT();
  const tap = useHapticTap();
  const counter = usePondCounter();
  const figures = counter.status === "ready" ? counter.figures : null;

  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("pond.counter.title")} className="gap-6">
        <CardHeader>
          <CardTitle>{t("pond.counter.title")}</CardTitle>
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
