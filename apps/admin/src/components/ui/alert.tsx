import { CircleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// shadcn/ui's Alert, Vega style, destructive (ADR-047), as one line of the
// panel: a paragraph with role="alert", its icon decorative, its words the
// failure or refusal, said in red and in words.
export function Alert({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p
      role="alert"
      data-slot="alert"
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg border border-destructive/50 bg-card px-4 py-3 text-sm text-destructive",
        className,
      )}
      {...props}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
