import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class names merged the Tailwind way: later utilities win over earlier ones (ADR-050). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** An id as the panel shortens it (#171): its first eight characters, enough to tell two apart on a screen. */
export const short = (id: string) => id.slice(0, 8);
