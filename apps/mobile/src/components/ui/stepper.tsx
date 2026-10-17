import Minus from "lucide-react-native/icons/minus";
import Plus from "lucide-react-native/icons/plus";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useHapticTap } from "@/theme/haptics";

/**
 * A number between a minus and a plus: every answer a button (ADR-010 §9),
 * each with its own spoken label, the number announced as it changes. The
 * age window of onboarding and the height of the profile (#146, #148).
 * The label is left out where the field above already names the number: the
 * height said "Height" twice (#238).
 * It takes no flex of its own: as `flex-1` in a column it could shrink to
 * nothing while its buttons still drew over the hint below (#238), so a row
 * that shares out its width passes `flex-1` itself.
 */
export function Stepper({
  className,
  label,
  value,
  shown,
  downLabel,
  upLabel,
  canDown,
  canUp,
  onChange,
}: {
  className?: string;
  label?: string;
  value: number;
  /** The number as text, with its unit where it has one. */
  shown: string;
  downLabel: string;
  upLabel: string;
  canDown: boolean;
  canUp: boolean;
  onChange: (next: number) => void;
}) {
  const tap = useHapticTap();
  return (
    <View className={cn("items-center gap-1", className)}>
      {label !== undefined && <Text variant="small">{label}</Text>}
      <View className="flex-row items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          accessibilityLabel={downLabel}
          disabled={!canDown}
          onPress={() => {
            tap();
            onChange(value - 1);
          }}
        >
          <Icon as={Minus} />
        </Button>
        <Text variant="h2" accessibilityLiveRegion="polite">
          {shown}
        </Text>
        <Button
          variant="outline"
          size="icon"
          accessibilityLabel={upLabel}
          disabled={!canUp}
          onPress={() => {
            tap();
            onChange(value + 1);
          }}
        >
          <Icon as={Plus} />
        </Button>
      </View>
    </View>
  );
}
