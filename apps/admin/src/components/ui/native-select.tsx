import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

// shadcn/ui's NativeSelect, Vega style (ADR-047): the platform's own <select>,
// its list and keyboard the browser's, drawn as the Input with a chevron. The
// wrapper takes the width; every other prop is the select's.
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <div
      data-slot="native-select-wrapper"
      className={cn("relative w-full has-[select:disabled]:opacity-50 sm:w-fit", className)}
    >
      <select
        data-slot="native-select"
        className="min-h-11 w-full min-w-0 appearance-none rounded-md border border-input bg-card py-1 ps-3 pe-9 text-base shadow-xs transition-[color,box-shadow] focus-visible:border-ring disabled:cursor-not-allowed sm:text-sm dark:bg-input/10"
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
