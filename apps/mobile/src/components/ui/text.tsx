import { Slot } from "@rn-primitives/slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, Text as RNText, type Role } from "react-native";
import { cn } from "@/lib/utils";
import { MAX_FONT_SCALE } from "@/theme/a11y";

// From React Native Reusables (#12, TD-9), adapted: text follows the OS font
// size up to MAX_FONT_SCALE, and no variant shrinks at a web breakpoint.
const textVariants = cva(cn("text-base text-foreground", Platform.select({ web: "select-text" })), {
  variants: {
    variant: {
      default: "",
      h1: "text-4xl font-extrabold tracking-tight",
      h2: "text-3xl font-semibold tracking-tight",
      h3: "text-2xl font-semibold tracking-tight",
      h4: "text-xl font-semibold tracking-tight",
      lead: "text-xl text-muted-foreground",
      large: "text-lg font-semibold",
      small: "text-sm font-medium",
      muted: "text-sm text-muted-foreground",
      code: "rounded bg-muted px-1 py-0.5 font-mono text-sm",
    },
  },
  defaultVariants: { variant: "default" },
});

type TextVariantProps = VariantProps<typeof textVariants>;
type TextVariant = NonNullable<TextVariantProps["variant"]>;

const ROLE: Partial<Record<TextVariant, Role>> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
};

const ARIA_LEVEL: Partial<Record<TextVariant, string>> = { h1: "1", h2: "2", h3: "3", h4: "4" };

/** The text classes a parent (a Button, a Card) wants its Text children to take. */
const TextClassContext = React.createContext<string | undefined>(undefined);

type TextProps = React.ComponentProps<typeof RNText> &
  React.RefAttributes<RNText> &
  TextVariantProps & { asChild?: boolean };

function Text({ className, asChild = false, variant = "default", ...props }: TextProps) {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot : RNText;
  return (
    <Component
      className={cn(textVariants({ variant }), textClass, className)}
      role={variant ? ROLE[variant] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant] : undefined}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      {...props}
    />
  );
}

export { Text, TextClassContext };
