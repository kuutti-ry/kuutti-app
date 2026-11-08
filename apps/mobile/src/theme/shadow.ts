import { useUnstableNativeVariable } from "nativewind";
import { Platform, type ViewStyle } from "react-native";

/**
 * Neubrutalism's hard shadow (neubrutalism.com): the shape again, offset down
 * and right, in the ink, with no blur. Its three tiers, kept small for a
 * dating app: a control, a container, and a dialog over everything.
 */
export const HARD_SHADOW = { control: 2, container: 3, overlay: 5 } as const;

// NativeWind turns box-shadow into a colour and a blur and drops the offset, so
// the shadow is React Native's own boxShadow style. Its colour is the ink, the
// --stroke token, as on neubrutalism.com: on a phone read from the set the root
// view carries (NativeWind keeps only a variable some class uses, and
// border-stroke does), on the web the CSS variable itself, which NativeWind's
// hook does not read there.
const useInkChannels: () => unknown =
  Platform.OS === "web" ? () => undefined : () => useUnstableNativeVariable("--stroke");

function hslOf(channels: unknown): string | undefined {
  const text = Array.isArray(channels) ? channels.join(" ") : channels;
  if (typeof text !== "string") return undefined;
  const [hue, saturation, lightness] = text.trim().split(/[\s,]+/);
  return hue && saturation && lightness ? `hsl(${hue}, ${saturation}, ${lightness})` : undefined;
}

/** The hard shadow at an offset, or nothing where the token cannot be read. */
export function useHardShadow(offset: number): ViewStyle {
  const channels = useInkChannels();
  const colour = Platform.OS === "web" ? "hsl(var(--stroke))" : hslOf(channels);
  return colour === undefined ? {} : { boxShadow: `${offset}px ${offset}px 0px 0px ${colour}` };
}
