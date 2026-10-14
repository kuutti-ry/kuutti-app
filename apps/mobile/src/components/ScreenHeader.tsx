import ArrowLeft from "lucide-react-native/icons/arrow-left";
import type { ReactNode } from "react";
import { View } from "react-native";
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
      <Text variant="h1" accessibilityRole="header" className="flex-1">
        {title}
      </Text>
      {children}
    </View>
  );
}
