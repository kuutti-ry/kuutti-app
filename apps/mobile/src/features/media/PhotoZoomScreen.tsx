import type { PhotoCaption } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { captionKey } from "./captions";
import { PhotoImage } from "./PhotoImage";

export type PhotoZoomParams = {
  id: string;
  blurhash: string;
  /** 1-based, for the label. */
  position: number;
  total: number;
  /** The owner's line (#296), read with the photo; none when absent. */
  caption?: PhotoCaption | null;
};

/**
 * The one screen that asks for the full variant (rules/mobile.md Images):
 * everywhere else a photo is a thumb or a card. Opened from the grid with what
 * the label needs; nothing is fetched here but the URL.
 */
export function PhotoZoomScreen({ id, blurhash, position, total, caption }: PhotoZoomParams) {
  const { t } = useT();
  const label = caption
    ? t("photos.zoom.labelCaption", { position, total, caption: t(captionKey(caption)) })
    : t("photos.zoom.label", { position, total });
  const router = useRouter();
  const tap = useHapticTap();
  // The API said no (#52): the person reads why under the placeholder, never a silent gap.
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 py-2">
        <Button
          variant="ghost"
          accessibilityLabel={t("photos.zoom.back")}
          onPress={() => {
            tap();
            router.back();
          }}
        >
          <Text>{t("photos.zoom.back")}</Text>
        </Button>
      </View>
      <View className="flex-1 bg-background">
        <PhotoImage
          id={id}
          variant="full"
          blurhash={blurhash}
          contentFit="contain"
          accessibilityLabel={label}
          style={{ flex: 1 }}
          onRefused={(code) => setRefusal(code ?? "unknown")}
        />
        {refusal !== null && (
          <Text variant="muted" className="px-4 py-3 text-center">
            {t(
              refusal === "photo_budget_exceeded"
                ? "photos.error.photo_budget_exceeded"
                : "photos.error.generic",
            )}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}
