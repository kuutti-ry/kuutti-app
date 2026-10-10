import type { PondSummary } from "@kuutti/schema";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { pondName } from "./names";
import { useWaitlist } from "./useWaitlist";

/**
 * How the person's own pond is filling up (#54, ADR-013): the figures of the
 * public counter, in words. Below the threshold no number is said, here as
 * everywhere, and the card says why the numbers stand still for a while: they
 * move in steps of at least k people. The pond's name stands on a line of its
 * own, in the nominative and in the person's language (#174): no sentence is
 * built around it (TD-17).
 */
export function WaitlistCard({ pond }: { pond: PondSummary }) {
  const { t } = useT();
  const tap = useHapticTap();
  const waitlist = useWaitlist(pond.id);
  const figures = waitlist.status === "ready" ? waitlist.figures : null;

  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("pond.waitlist.label")} className="gap-6">
        <CardHeader>
          <CardDescription>{t("pond.waitlist.title")}</CardDescription>
          <CardTitle>{pondName(t, pond)}</CardTitle>
        </CardHeader>
        <CardContent className="gap-2">
          {waitlist.status === "loading" && (
            <Text accessibilityLiveRegion="polite">{t("pond.waitlist.loading")}</Text>
          )}
          {waitlist.status === "failed" && (
            <View className="gap-3">
              <Text accessibilityLiveRegion="assertive">{t("pond.waitlist.failed")}</Text>
              <Button
                variant="outline"
                accessibilityRole="button"
                accessibilityLabel={t("pond.waitlist.retry")}
                onPress={() => {
                  tap();
                  waitlist.retry();
                }}
              >
                <Text>{t("pond.waitlist.retry")}</Text>
              </Button>
            </View>
          )}
          {waitlist.status === "ready" &&
            (figures === null || figures.verified === null ? (
              <Text>{t("pond.waitlist.small", { k: waitlist.k })}</Text>
            ) : (
              <>
                <Text>{t("pond.waitlist.verified", { people: figures.verified })}</Text>
                {figures.split && (
                  <Text variant="muted">
                    {t("pond.waitlist.split", {
                      women: figures.split.woman,
                      men: figures.split.man,
                      nonBinary: figures.split.nonBinary,
                    })}
                  </Text>
                )}
                {figures.finishing !== null && (
                  <Text>{t("pond.waitlist.finishing", { people: figures.finishing })}</Text>
                )}
              </>
            ))}
          {waitlist.status === "ready" && figures !== null && figures.verified !== null && (
            <Text variant="muted">{t("pond.waitlist.steps", { k: waitlist.k })}</Text>
          )}
        </CardContent>
      </View>
    </Card>
  );
}
