import type { PondSeeks } from "@kuutti/schema";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";

/**
 * Whom people on Kuutti seek (#507, #581, ADR-013 §12, §13): one continuous bar,
 * those who seek men at one end, those who seek women at the other, everyone in
 * the middle. No animation, and the bar holds no text. Under it, in the bar's
 * order, each band's share in words beside a swatch of its colour: the words and
 * the order carry the meaning, never the colour alone, and they wrap at any text
 * size. One element for a screen reader, which says the three figures in words.
 */
export function SeeksBar({ seeks }: { seeks: PondSeeks }) {
  const { t } = useT();
  const bands = [
    {
      band: "men",
      colour: "bg-seeks-men",
      label: t("pond.counter.seeks.men", { share: seeks.men }),
    },
    {
      band: "everyone",
      colour: "bg-seeks-everyone",
      label: t("pond.counter.seeks.everyone", { share: seeks.everyone }),
    },
    {
      band: "women",
      colour: "bg-seeks-women",
      label: t("pond.counter.seeks.women", { share: seeks.women }),
    },
  ] as const;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t("pond.counter.seeks.label", seeks)}
      className="gap-2 py-1"
    >
      <View className="h-5 flex-row overflow-hidden rounded-md">
        {bands.map(({ band, colour }) => (
          <View key={band} className={colour} style={{ flexGrow: seeks[band], flexBasis: 0 }} />
        ))}
      </View>
      <View className="flex-row flex-wrap justify-between gap-x-4 gap-y-1">
        {bands.map(({ band, colour, label }) => (
          <View key={band} className="flex-row items-center gap-1.5">
            <View className={cn("size-3 rounded-sm", colour)} />
            <Text className="text-sm">{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
