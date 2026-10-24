import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// shadcn/ui's Label, Vega style (ADR-047).
export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the caller gives htmlFor or puts the control inside.
    <label
      data-slot="label"
      className={cn("text-sm leading-snug font-medium select-none", className)}
      {...props}
    />
  );
}
