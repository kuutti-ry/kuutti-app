import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";

/** A list screen's way to read its list again; the words name what is read. */
export function RefreshButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="outline" onClick={onClick}>
      <RefreshCw aria-hidden="true" />
      {children}
    </Button>
  );
}
