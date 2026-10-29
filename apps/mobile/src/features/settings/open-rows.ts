import { useCallback, useEffect, useState } from "react";
import { readPreference, writePreference } from "@/lib/preferences";

/** The keys stored; anything that is not a list of names is none open. */
function readOpenRows(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
}

/**
 * Which of Settings' rows are open (#511), kept on the phone so that the
 * list comes back as it was left; all closed the first time. `also` is open
 * besides, for a link that names a row (the screen-reader hint's way to the
 * photo descriptions), also when the link comes while the list is open, and
 * is kept with the rest once a row is pressed.
 */
export function useOpenRows(also?: string) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(also ? [also] : []));
  useEffect(() => {
    let mounted = true;
    void readPreference("settingsOpen").then((stored) => {
      if (mounted) setOpen((now) => new Set([...readOpenRows(stored), ...now]));
    });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (also) setOpen((now) => (now.has(also) ? now : new Set([...now, also])));
  }, [also]);
  const toggle = useCallback((key: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      void writePreference("settingsOpen", JSON.stringify([...next]));
      return next;
    });
  }, []);
  return { open, toggle };
}
