import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { MINIMUM_TARGET } from "@/theme/a11y";
import { HARD_SHADOW, useHardShadow } from "@/theme/shadow";
import { useLook } from "@/theme/ThemeProvider";

// From React Native Reusables (#12, TD-9), adapted to the accessibility
// baseline: heights are minimums so scaled text is never clipped, every size
// is at least the 44 pt target, colours are tokens only, and a button whose
// content is not plain text cannot be written without an accessibilityLabel.
// Every variant has the same border, transparent but where a variant or the
// disabled look draws it: a choice toggles between default (chosen) and
// outline, and a busy button between enabled and disabled, and a narrower
// button re-wrapped a row of chips on every tap (#239). The background shows
// through it on every platform. Solid is said, not left to the default: when a
// border's style goes away Android keeps the dash it had
// (BorderDrawable.updatePathEffect skips a null style, React Native 0.86), so a
// button enabled again stayed dashed until it remounted (#548).
const BASE = cn(
  "group shrink-0 flex-row items-center justify-center gap-2 rounded-md border-solid border-transparent",
  Platform.select({
    web: "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
  }),
);

const SIZES = {
  default: "min-h-touch min-w-touch px-5 py-2",
  lg: "min-h-14 min-w-touch px-8 py-3",
  icon: "min-h-touch min-w-touch p-2",
};

// Today's style: a 1 px border, drawn by outline alone, and fills that darken pressed.
const todaysButton = cva(cn(BASE, "border"), {
  variants: {
    variant: {
      default: cn(
        "bg-primary active:bg-primary/90",
        Platform.select({ web: "hover:bg-primary/90" }),
      ),
      destructive: cn(
        "bg-destructive active:bg-destructive/90",
        Platform.select({ web: "hover:bg-destructive/90" }),
      ),
      outline: cn(
        "border-input bg-background active:bg-accent",
        Platform.select({ web: "hover:bg-accent" }),
      ),
      secondary: cn(
        "bg-secondary active:bg-secondary/80",
        Platform.select({ web: "hover:bg-secondary/80" }),
      ),
      ghost: cn("active:bg-accent", Platform.select({ web: "hover:bg-accent" })),
    },
    size: SIZES,
  },
  defaultVariants: { variant: "default", size: "default" },
});

// The neubrutalism try (outside production): a 2 px stroke in the ink on every
// drawn variant, and a press that moves the button into its hard shadow.
const neubrutalistButton = cva(cn(BASE, "border-2"), {
  variants: {
    variant: {
      default: cn("border-stroke bg-primary", Platform.select({ web: "hover:bg-primary/90" })),
      destructive: cn(
        "border-stroke bg-destructive",
        Platform.select({ web: "hover:bg-destructive/90" }),
      ),
      outline: cn(
        "border-stroke bg-card active:bg-accent",
        Platform.select({ web: "hover:bg-accent" }),
      ),
      secondary: cn(
        "border-stroke bg-secondary",
        Platform.select({ web: "hover:bg-secondary/80" }),
      ),
      ghost: cn("active:bg-accent", Platform.select({ web: "hover:bg-accent" })),
    },
    size: SIZES,
  },
  defaultVariants: { variant: "default", size: "default" },
});

// Saiga Regular: as dark as the system font's Semibold, the weight a phone
// gives a button's words (#408).
const buttonTextVariants = cva("font-sans text-control font-normal", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      destructive: "text-destructive-foreground",
      outline: "text-foreground",
      secondary: "text-secondary-foreground",
      ghost: "text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

// Disabled is drawn, not faded (#467): opacity took the label to about 3:1 in
// the high-contrast sets, which aim at 7:1. No fill and a dashed outline tell
// it from every enabled variant by shape, in all four sets; the label and an
// icon take --muted-foreground, which check:contrast holds on the background
// and on a card, and the outline --input, held at 3:1. Its pressed and hover
// fills go too: on the web a disabled button's label still takes the hover,
// and the variant's fill came back behind the muted label.
const DISABLED = cn(
  "border-dashed border-input bg-transparent active:bg-transparent",
  Platform.select({ web: "hover:bg-transparent" }),
);
const DISABLED_TEXT = "text-muted-foreground";

/**
 * Plain text labels itself. Anything else (an icon, a composed child) has no
 * text a screen reader could fall back on, so the label is required by the
 * type: `<Button><Icon as={X} /></Button>` does not compile.
 */
type ButtonContent =
  | { children: string; accessibilityLabel?: string }
  | { children: Exclude<React.ReactNode, string>; accessibilityLabel: string };

type ButtonProps = Omit<
  React.ComponentProps<typeof Pressable>,
  "children" | "accessibilityLabel" | "accessibilityRole" | "role" | "style"
> & {
  /** A button unless it is one option of a group (the dev settings' theme choice). */
  accessibilityRole?: "button" | "radio" | "checkbox" | "tab" | "link";
} & React.RefAttributes<React.ComponentRef<typeof Pressable>> &
  VariantProps<typeof todaysButton> &
  ButtonContent & { style?: StyleProp<ViewStyle> };

// Pressed, a drawn button moves into its hard shadow, which it then covers: the
// neubrutalism try's press, at once, so no motion to reduce.
const PRESSED: ViewStyle = {
  transform: [{ translateX: HARD_SHADOW.control }, { translateY: HARD_SHADOW.control }],
};

function Button({
  className,
  variant,
  size,
  children,
  style,
  accessibilityRole = "button",
  accessibilityState,
  onPressIn,
  onPressOut,
  ...props
}: ButtonProps) {
  const look = useLook();
  const shadow = useHardShadow(HARD_SHADOW.control);
  // A ghost button is a row or a link, and a disabled one lies flat.
  const raised = look === "neubrutalism" && variant !== "ghost" && props.disabled !== true;
  const recipe = look === "neubrutalism" ? neubrutalistButton : todaysButton;
  // Pressed is state here, not a style function: NativeWind's Pressable drops one.
  const [pressed, setPressed] = React.useState(false);
  return (
    <TextClassContext.Provider
      value={cn(buttonTextVariants({ variant }), props.disabled && DISABLED_TEXT)}
    >
      <Pressable
        accessibilityRole={accessibilityRole}
        accessibilityState={{ ...accessibilityState, disabled: props.disabled === true }}
        className={cn(recipe({ variant, size }), props.disabled && DISABLED, className)}
        style={[MINIMUM_TARGET, raised && (pressed ? PRESSED : shadow), style]}
        onPressIn={(event) => {
          setPressed(true);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          setPressed(false);
          onPressOut?.(event);
        }}
        {...props}
      >
        {typeof children === "string" ? <Text>{children}</Text> : children}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export type { ButtonProps };
export { Button };
