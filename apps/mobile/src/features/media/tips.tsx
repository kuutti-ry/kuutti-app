import type { FishSpecies, TipKind } from "@kuutti/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";

/**
 * One advisory tip for the owner (#56); kinds are the API's, words are the
 * client's. The fish tip names the fish when the API is sure of it (#253).
 */
export function tipText(
  t: ReturnType<typeof useT>["t"],
  kind: TipKind,
  fishSpecies: FishSpecies | null = null,
): string {
  switch (kind) {
    case "sunglasses":
      return t("profile.tip.sunglasses");
    case "mirror_selfie":
      return t("profile.tip.mirror_selfie");
    case "tight_crop":
      return t("profile.tip.tight_crop");
    case "group_photo":
      return t("profile.tip.group_photo");
    case "poor_lighting":
      return t("profile.tip.poor_lighting");
    case "blurry":
      return t("profile.tip.blurry");
    case "few_photos":
      return t("profile.tip.few_photos");
    case "revealing":
      return t("profile.tip.revealing");
    case "fish":
      return fishSpecies
        ? t("profile.tip.fish_species", { species: fishSpecies })
        : t("profile.tip.fish");
  }
}

/**
 * Tips dismissed in this run of the app (#56): kept outside the screen, so
 * leaving the photos and coming back does not bring one back. Nothing is
 * stored; the next start shows them again.
 */
const dismissedTips = new Set<TipKind>();

/**
 * One tip at a time, where the photos are (#287): the first that applies and
 * was not dismissed, said as soon as the check has decided the photo.
 */
export function PhotoTip({
  tips,
  fishSpecies,
}: {
  tips: readonly TipKind[];
  fishSpecies: FishSpecies | null;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  // Renders again after a dismissal; the kinds themselves are in dismissedTips.
  const [, setDismissals] = useState(0);
  const tip = tips.find((kind) => !dismissedTips.has(kind)) ?? null;
  if (!tip) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("profile.tip.title")}</CardTitle>
      </CardHeader>
      <CardContent className="gap-3">
        <Text>{tipText(t, tip, fishSpecies)}</Text>
        <Button
          variant="outline"
          onPress={() => {
            tap();
            dismissedTips.add(tip);
            setDismissals((n) => n + 1);
          }}
        >
          {t("profile.tip.dismiss")}
        </Button>
      </CardContent>
    </Card>
  );
}
