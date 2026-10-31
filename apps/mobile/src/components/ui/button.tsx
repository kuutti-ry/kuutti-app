import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Platform, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { TOUCH_TARGET } from "@/theme/a11y";

// From React Native Reusables (#12, TD-9), adapted to the accessibility
// baseline: heights are minimums so scaled text is never clipped, every size
// is at least the 44 pt target, colours are tokens only, and a button whose
// content is not plain text cannot be written without an accessibilityLabel.
const buttonVariants = cva(
  cn(
    // Every variant has outline's 1 px border, transparent but where a variant
    // or the disabled look draws it: a choice toggles between default (chosen)
    // and outline, and a busy button between enabled and disabled, and a
    // button 2 px narrower re-wrapped a row of chips on every tap (#239). The
    // background shows through it on every platform. Solid is said, not left
    // to the default: when a border's style goes away Android keeps the dash it
    // had (BorderDrawable.updatePathEffect skips a null style, React Native
    // 0.86), so a button enabled again stayed dashed until it remounted (#548).
    "group shrink-0 flex-row items-center justify-center gap-2 rounded-md border border-solid border-transparent",
    Platform.select({
      web: "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
    }),
  ),
  {
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
      size: {
        default: "min-h-touch min-w-touch px-5 py-2",
        lg: "min-h-14 min-w-touch px-8 py-3",
        icon: "min-h-touch min-w-touch p-2",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

const buttonTextVariants = cva("text-base font-semibold", {
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
  accessibilityRole?: "button" | "radio" | "tab" | "link";
} & React.RefAttributes<React.ComponentRef<typeof Pressable>> &
  VariantProps<typeof buttonVariants> &
  ButtonContent & { style?: StyleProp<ViewStyle> };

// A style, not a class: the guarantee must hold wherever the stylesheet does
// not (tests, a class merged away by a caller).
const MINIMUM_TARGET: ViewStyle = { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET };

function Button({
  className,
  variant,
  size,
  children,
  style,
  accessibilityRole = "button",
  accessibilityState,
  ...props
}: ButtonProps) {
  return (
    <TextClassContext.Provider
      value={cn(buttonTextVariants({ variant }), props.disabled && DISABLED_TEXT)}
    >
      <Pressable
        accessibilityRole={accessibilityRole}
        accessibilityState={{ ...accessibilityState, disabled: props.disabled === true }}
        className={cn(buttonVariants({ variant, size }), props.disabled && DISABLED, className)}
        style={[MINIMUM_TARGET, style]}
        {...props}
      >
        {typeof children === "string" ? <Text>{children}</Text> : children}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export type { ButtonProps };
export { Button };
