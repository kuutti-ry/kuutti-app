import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// shadcn/ui's Textarea, Vega style (ADR-047): as the Input, at least two lines tall.
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base shadow-xs transition-[color,box-shadow] focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm dark:bg-input/10",
        className,
      )}
      {...props}
    />
  );
}
