import * as SwitchPrimitives from "@rn-primitives/switch";
import type * as React from "react";
import { Platform } from "react-native";
import { cn } from "@/lib/utils";
import { hitSlopFor } from "@/theme/a11y";

// Drawn size in points; hitSlop extends the touch target to 44 pt (#12).
const TRACK_WIDTH = 52;
const TRACK_HEIGHT = 32;

// From React Native Reusables (#12), adapted. On and off differ by the thumb's
// position, not only by colour, and the label is required: a switch has no
// text of its own.
type SwitchProps = Omit<
  React.ComponentProps<typeof SwitchPrimitives.Root>,
  "accessibilityLabel" | "aria-label"
> & { accessibilityLabel: string };

function Switch({ className, accessibilityLabel, ...props }: SwitchProps) {
  return (
    <SwitchPrimitives.Root
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      aria-label={accessibilityLabel}
      accessibilityState={{ checked: props.checked, disabled: props.disabled === true }}
      hitSlop={hitSlopFor(TRACK_WIDTH, TRACK_HEIGHT)}
      style={{ width: TRACK_WIDTH, height: TRACK_HEIGHT }}
      className={cn(
        "shrink-0 flex-row items-center rounded-full border-2 border-input px-0.5",
        Platform.select({
          web: "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
        }),
        props.checked ? "justify-end bg-primary" : "justify-start bg-background",
        props.disabled && "opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          "size-6 rounded-full",
          props.checked ? "bg-primary-foreground" : "bg-input",
          Platform.select({ web: "pointer-events-none block" }),
        )}
      />
    </SwitchPrimitives.Root>
  );
}

export { Switch, TRACK_HEIGHT, TRACK_WIDTH };
