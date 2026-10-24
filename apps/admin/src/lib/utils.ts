import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class names merged the Tailwind way: later utilities win over earlier ones (ADR-047). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
