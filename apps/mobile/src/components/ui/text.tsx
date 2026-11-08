import { Slot } from "@rn-primitives/slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, Text as RNText, type Role } from "react-native";
import { cn } from "@/lib/utils";
import { HEADING_FONT_SCALE, MAX_FONT_SCALE } from "@/theme/a11y";

// From React Native Reusables (#12, TD-9), adapted: text follows the OS font
// size up to MAX_FONT_SCALE, headings less (HEADING_FONT_SCALE), and no
// variant shrinks at a web breakpoint.
// The type is #408's (ADR-052 §4): what is read, ours and people's, is in the
// phone's own font (font-system) at 17 pt; Saiga (font-sans) draws headings
// and short labels. Saiga Regular is as dark as the system font's Semibold, so
// it takes Semibold's jobs, and Bold is for h1 alone.
const textVariants = cva(
  cn("font-system text-body text-foreground", Platform.select({ web: "select-text" })),
  {
    variants: {
      variant: {
        default: "",
        h1: "font-sans text-h1 font-bold",
        h2: "font-sans text-h2 font-medium",
        h3: "font-sans text-title font-medium",
        h4: "font-sans text-control font-medium",
        // A heading inside a card or a dialog, or over an open row of Settings (#511).
        title: "font-sans text-title font-normal",
        // The heading of a group of rows: small and quiet, as the phone's own lists draw it.
        group: "font-sans text-label font-normal text-muted-foreground",
        // A field's label, a chip's words, a short tag.
        small: "font-sans text-label font-normal",
        muted: "text-small text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type TextVariantProps = VariantProps<typeof textVariants>;
type TextVariant = NonNullable<TextVariantProps["variant"]>;

const ROLE: Partial<Record<TextVariant, Role>> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  title: "heading",
};

const ARIA_LEVEL: Partial<Record<TextVariant, string>> = {
  h1: "1",
  h2: "2",
  h3: "3",
  h4: "4",
  title: "4",
};

const FONT_SCALE: Partial<Record<TextVariant, number>> = HEADING_FONT_SCALE;

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
      maxFontSizeMultiplier={(variant && FONT_SCALE[variant]) ?? MAX_FONT_SCALE}
      {...props}
    />
  );
}

export { Text, TextClassContext };
