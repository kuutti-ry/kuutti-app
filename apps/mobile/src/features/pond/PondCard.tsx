import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { SeeksBar } from "./SeeksBar";
import { usePondCounter } from "./usePondCounter";

/**
 * How many people have completed their profiles (#54, #581, ADR-013): the
 * counter's number, in one sentence. Below the threshold no number is said, here
 * as everywhere, and nothing on the card names a condition or says that an
 * unfinished profile exists. There is one pond, the country (ADR-061 §8), so the
 * card names no area (#500). Once it may be said, the bar of whom those people
 * seek stands right under the sentence, which then leads into it (#507).
 */
export function PondCard() {
  const { t } = useT();
  const tap = useHapticTap();
  const counter = usePondCounter();
  const figures = counter.status === "ready" ? counter.figures : null;
  const finished = figures?.finished ?? null;
  const seeks = figures?.seeks ?? null;

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
          {counter.status === "ready" && finished === null && (
            <Text>{t("pond.counter.small")}</Text>
          )}
          {finished !== null && seeks === null && (
            <Text>{t("pond.counter.finished", { people: finished })}</Text>
          )}
          {finished !== null && seeks !== null && (
            <>
              <Text>{t("pond.counter.seeks.finished", { people: finished })}</Text>
              <SeeksBar seeks={seeks} />
            </>
          )}
        </CardContent>
      </View>
    </Card>
  );
}
