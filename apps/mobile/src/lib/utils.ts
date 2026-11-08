import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own spacing, `touch` (tailwind.config.js), made known to the
// merge: otherwise `min-h-touch` and a caller's `min-h-32` both stay, and the
// first wins in the stylesheet, so a multiline field draws one line tall (#511).
// The type scale's sizes likewise (#408): unknown, `text-body` reads as a
// colour and a caller's `text-foreground` would take it away.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ["touch"],
      text: ["h1", "h2", "title", "body", "control", "label", "small", "caption"],
    },
  },
});

/** Class names merged the Tailwind way: later utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
