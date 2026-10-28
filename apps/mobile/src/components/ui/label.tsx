import * as LabelPrimitive from "@rn-primitives/label";
import type * as React from "react";
import { Platform } from "react-native";
import { cn } from "@/lib/utils";
import { MAX_FONT_SCALE } from "@/theme/a11y";

// From React Native Reusables (#12), adapted: scales with the OS font size,
// and a disabled label is --muted-foreground, never faded below the set's
// contrast (#467).
function Label({
  className,
  onPress,
  onLongPress,
  onPressIn,
  onPressOut,
  disabled,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Text>) {
  return (
    <LabelPrimitive.Root
      // A press on the label is a convenience for sighted users; the control it
      // names carries the role and the label, so this wrapper is not an
      // accessibility element of its own and its text is read as text.
      accessible={false}
      className={cn(
        // Shrinks beside a control, and its text wraps, where a row would
        // otherwise push the control past the screen's edge (#285).
        "flex shrink select-none flex-row items-center gap-2",
        Platform.select({ web: "cursor-default" }),
      )}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled}
    >
      <LabelPrimitive.Text
        className={cn(
          "shrink font-sans text-sm font-medium text-foreground",
          disabled && "text-muted-foreground",
          className,
        )}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        {...props}
      />
    </LabelPrimitive.Root>
  );
}

export { Label };
