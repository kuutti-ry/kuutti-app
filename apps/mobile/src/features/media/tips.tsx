import { type FishSpecies, TipKind } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { readPreference, writePreference } from "@/lib/preferences";
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
 * The tips said for the current main photo (#297): on the device, beside the
 * theme and the language, never sent anywhere. A tip belongs to the main
 * photo it is about: said once for it, whether dismissed or left on the
 * screen, and not again while that photo stays the main one. Another photo
 * made the main one starts afresh, so a fish photo chosen again earns its tip
 * again, as the maintainer asked (15/10/2026). Without a main photo the id
 * is empty.
 */
export type SeenTips = { mainId: string; kinds: TipKind[] };
const SEEN_KEY = "photoTipsSeen";
const NOTHING_SEEN: SeenTips = { mainId: "", kinds: [] };

// Writes queue behind one another, and a read waits for them, so a dismissal
// and the screen's closing moments later never read the same old value and
// lose one.
let pendingWrite: Promise<void> = Promise.resolve();

function writeSeenTips(next: SeenTips): Promise<void> {
  pendingWrite = pendingWrite.then(() => writePreference(SEEN_KEY, JSON.stringify(next)));
  return pendingWrite;
}

async function readSeenTips(): Promise<SeenTips> {
  await pendingWrite;
  const raw = await readPreference(SEEN_KEY);
  if (raw === null) return NOTHING_SEEN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NOTHING_SEEN;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NOTHING_SEEN;
  const { mainId, kinds } = parsed as Record<string, unknown>;
  if (typeof mainId !== "string" || !Array.isArray(kinds)) return NOTHING_SEEN;
  // Only kinds this build knows: anything else stored is dropped.
  return {
    mainId,
    kinds: kinds.filter((kind): kind is TipKind => TipKind.safeParse(kind).success),
  };
}

async function markTipSeen(kind: TipKind, mainId: string): Promise<void> {
  const seen = await readSeenTips();
  const kinds = seen.mainId === mainId ? seen.kinds : [];
  await writeSeenTips({ mainId, kinds: kinds.includes(kind) ? kinds : [...kinds, kind] });
}

/**
 * One tip at a time, where the photos are (#287): the first that applies and
 * was not yet said for this main photo (#297), said as soon as the check has
 * decided the photo. Dismissing it, or leaving the screen with it on, counts
 * as having heard it.
 */
export function PhotoTip({
  tips,
  fishSpecies,
  mainId,
}: {
  tips: readonly TipKind[];
  fishSpecies: FishSpecies | null;
  /** The main photo (ADR-009 §4), the one the tips are about; null while there is none. */
  mainId: string | null;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const key = mainId ?? "";
  // Null until the device has answered what was said already: nothing is said
  // before that. A record of another main photo is over, whether or not this
  // one has a tip: choosing a photo again starts afresh.
  const [seen, setSeen] = useState<SeenTips | null>(null);
  useEffect(() => {
    let live = true;
    void readSeenTips().then((read) => {
      if (!live) return;
      if (read.mainId === key) return setSeen(read);
      const fresh: SeenTips = { mainId: key, kinds: [] };
      setSeen(fresh);
      void writeSeenTips(fresh);
    });
    return () => {
      live = false;
    };
  }, [key]);
  const said = seen && seen.mainId === key ? seen.kinds : [];
  const tip = seen ? (tips.find((kind) => !said.includes(kind)) ?? null) : null;
  // Whatever was on the screen is remembered as said when it gives way: to a
  // dismissal, to another main photo, or to the screen closing.
  useEffect(() => {
    if (!tip) return;
    return () => void markTipSeen(tip, key);
  }, [tip, key]);
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
            setSeen((previous) => ({
              mainId: key,
              kinds: [...(previous?.mainId === key ? previous.kinds : []), tip],
            }));
          }}
        >
          {t("profile.tip.dismiss")}
        </Button>
      </CardContent>
    </Card>
  );
}
