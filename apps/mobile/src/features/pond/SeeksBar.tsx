import type { PondSeeks } from "@kuutti/schema";
import { cssInterop } from "nativewind";
import type { ViewStyle } from "react-native";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";

// The text colour class reaches the strokes as currentColor, the way Icon colours lucide's.
const Canvas = cssInterop(Svg, { className: "style" });

/** Wider than the widest card: a band of any width is filled, and clips the rest. */
const WIDTH = 480;
const HEIGHT = 20;
const SPACING = 6;
/** A band stays wide enough for its pattern to read, however small its share. */
const BAND_MIN_WIDTH = 14;

const strokes = (fromY: number, toY: number) => {
  let d = "";
  for (let x = -HEIGHT; x < WIDTH; x += SPACING) d += `M${x} ${fromY}L${x + HEIGHT} ${toY}`;
  return d;
};
const RISING = strokes(HEIGHT, 0);
const FALLING = strokes(0, HEIGHT);

type Band = "men" | "everyone" | "women";

function Strokes({ d, className, testID }: { d: string; className: string; testID: string }) {
  return (
    <Canvas
      width={WIDTH}
      height={HEIGHT}
      className={cn("absolute left-0 top-0", className)}
      testID={testID}
      {...DECORATIVE}
    >
      <Path d={d} stroke="currentColor" strokeWidth={2} fill="none" />
    </Canvas>
  );
}

/**
 * A band's pattern. Rising strokes for men, falling for women, and both for
 * everyone, so the middle of the bar is the overlap of its two ends and each
 * band differs by its shape in every theme set, never by colour alone.
 */
function Hatched({
  band,
  className,
  style,
}: {
  band: Band;
  className?: string;
  style?: ViewStyle;
}) {
  return (
    <View
      className={cn("overflow-hidden rounded-sm border border-input", className)}
      style={style}
      {...DECORATIVE}
    >
      {band !== "women" && <Strokes d={RISING} className="text-primary" testID="strokes-rising" />}
      {band !== "men" && (
        <Strokes d={FALLING} className="text-foreground" testID="strokes-falling" />
      )}
    </View>
  );
}

/**
 * Whom the people of the area seek (#507, ADR-013 §12): one bar, those who seek
 * men at one end, those who seek women at the other, everyone in the middle. No
 * animation, and the bar holds no text: the labels below it wrap at any text
 * size. One element for a screen reader, which says the three figures in words.
 */
export function SeeksBar({ seeks }: { seeks: PondSeeks }) {
  const { t } = useT();
  const bands = [
    { band: "men", label: t("pond.waitlist.seeks.men", { share: seeks.men }) },
    { band: "everyone", label: t("pond.waitlist.seeks.everyone", { share: seeks.everyone }) },
    { band: "women", label: t("pond.waitlist.seeks.women", { share: seeks.women }) },
  ] as const;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t("pond.waitlist.seeks.label", seeks)}
      className="gap-2 py-1"
    >
      <Text variant="muted">{t("pond.waitlist.seeks.title")}</Text>
      <View className="flex-row gap-0.5">
        {bands.map(({ band }) => (
          <Hatched
            key={band}
            band={band}
            style={{
              height: HEIGHT,
              flexGrow: seeks[band],
              flexBasis: 0,
              minWidth: BAND_MIN_WIDTH,
            }}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap justify-between gap-x-4 gap-y-1">
        {bands.map(({ band, label }) => (
          <View key={band} className="flex-row items-center gap-1.5">
            <Hatched band={band} style={{ width: HEIGHT, height: HEIGHT }} />
            <Text>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
