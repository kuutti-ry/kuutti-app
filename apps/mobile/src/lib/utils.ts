import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own spacing, `touch` (tailwind.config.js), made known to the
// merge: otherwise `min-h-touch` and a caller's `min-h-32` both stay, and the
// first wins in the stylesheet, so a multiline field draws one line tall (#511).
const twMerge = extendTailwindMerge({ extend: { theme: { spacing: ["touch"] } } });

/** Class names merged the Tailwind way: later utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
