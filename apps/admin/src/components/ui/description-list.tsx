import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// The panel's own, in shadcn/ui's manner (ADR-047): a term and its value side
// by side on a wide screen, one under the other on a phone, the value
// wrapping anywhere. A <div> around a pair (a prompt, a field) lays out as if
// it were not there.
export function DescriptionList({ className, ...props }: ComponentProps<"dl">) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 sm:grid-cols-[minmax(8rem,max-content)_1fr] sm:gap-y-2 [&_dd]:mb-2 [&_dd]:wrap-anywhere sm:[&_dd]:mb-0 [&_dt]:text-muted-foreground [&>div]:contents",
        className,
      )}
      {...props}
    />
  );
}
