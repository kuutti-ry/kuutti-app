import { Image } from "expo-image";
import { cssInterop } from "nativewind";
import { Platform } from "react-native";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";

// The text colour class is handed over as tintColor, the way Icon does it for
// lucide. That hand-over is native only; on the web target the ink is inverted
// under the dark class instead, and both dark foregrounds are near white.
const Tinted = cssInterop(Image, {
  className: { target: "style", nativeStyleToProp: { color: "tintColor" } },
});

/**
 * A drawing in black ink on transparency, tinted with a text colour class so
 * it follows all four theme sets: the home screen's mark, a profile option's
 * glyph (#213), a contact's service (#474). Decorative, hidden from screen
 * readers: the words beside it carry the meaning. `className` gives the size
 * and the text colour.
 */
export function Ink({ source, className }: { source: number; className: string }) {
  return (
    <Tinted
      source={source}
      contentFit="contain"
      className={cn(className, Platform.select({ web: "dark:invert" }))}
      {...DECORATIVE}
    />
  );
}
