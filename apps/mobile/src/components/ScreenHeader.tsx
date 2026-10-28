import ArrowLeft from "lucide-react-native/icons/arrow-left";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useHapticTap } from "@/theme/haptics";

/**
 * The top of a screen that is not home: the way back and the screen's title,
 * pinned above its content so neither scrolls away. Headers are hidden
 * app-wide (`app/_layout.tsx`), so a screen draws this above its ScrollView,
 * never inside it. The bar has the background token and a hairline of the
 * border token, so what scrolls up stops under a clear edge.
 *
 * The title is one line that shrinks as far as its width needs, on both
 * platforms (#467): wrapped, a word longer than the line broke in the middle
 * ("Conversa / tions" at the largest text; Finnish and Swedish compounds such
 * as "Valintapainikkeet" from x1.1 on a 375 pt phone, and at the default size
 * on a 320 pt one), and a pinned title of two or three lines took the room the
 * content needs most at that size. It has no fixed line height
 * (`text-4xl/[normal]`): iOS places a shrunk font at the foot of the line
 * height set for the font before it shrank, below the arrow's middle. The web
 * preview cannot shrink text, and one line there is an ellipsis that hides the
 * title, so it wraps as before.
 */
export function ScreenHeader({
  title,
  backLabel,
  onBack,
  children,
  className,
}: {
  title: string;
  /** What a screen reader says for the arrow: where it goes. */
  backLabel: string;
  onBack: () => void;
  /** Buttons after the title, at the right (the profile's card preview). */
  children?: ReactNode;
  className?: string;
}) {
  const tap = useHapticTap();
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 border-b border-border bg-background px-6 py-2",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel={backLabel}
        onPress={() => {
          tap();
          onBack();
        }}
      >
        <Icon as={ArrowLeft} />
      </Button>
      <Text
        variant="h1"
        accessibilityRole="header"
        className="flex-1 text-4xl/[normal]"
        numberOfLines={Platform.OS === "web" ? undefined : 1}
        adjustsFontSizeToFit
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
