import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// shadcn/ui's Input, Vega style (ADR-047), on the platform's own control: 44
// px tall, outlined in --input (3:1 against the page, tokens.test.ts), the
// focus ring the stylesheet's outline.
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-base shadow-xs transition-[color,box-shadow] focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm dark:bg-input/10",
        className,
      )}
      {...props}
    />
  );
}
