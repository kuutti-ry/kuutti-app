import type * as React from "react";
import { Platform, TextInput } from "react-native";
import { cn } from "@/lib/utils";
import { MAX_FONT_SCALE } from "@/theme/a11y";

// From React Native Reusables (#12), adapted: a minimum height instead of a
// fixed one (scaled text is never clipped), the 3:1 --input outline in both
// themes, and a label the type insists on, since a placeholder is not one.
// Read-only is drawn as a disabled Button is (#467): a dashed outline and the
// text in --muted-foreground, never faded below the set's contrast.
type InputProps = Omit<React.ComponentProps<typeof TextInput>, "accessibilityLabel"> &
  React.RefAttributes<TextInput> & { accessibilityLabel: string };

function Input({ className, ...props }: InputProps) {
  return (
    <TextInput
      className={cn(
        "min-h-touch w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 font-sans text-base text-foreground placeholder:text-muted-foreground",
        props.editable === false && "border-dashed text-muted-foreground",
        Platform.select({
          web: "outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        }),
        className,
      )}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      {...props}
    />
  );
}

export { Input };
