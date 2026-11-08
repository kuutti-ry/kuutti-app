import { LoaderCircle } from "lucide-react";

// shadcn/ui's Spinner (ADR-050) with the words it waits for: a busy line, its
// icon decorative and still when the system asks for reduced motion.
export function Loading({ children }: { children: string }) {
  return (
    <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
      {children}
    </p>
  );
}
