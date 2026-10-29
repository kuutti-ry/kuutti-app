import { useCallback, useEffect, useState } from "react";

// The row of Settings left open, while the app runs (#511): back from the
// licences or from home, the list is as it was; a cold start has every row
// closed. Kept in memory alone, never on the phone (the maintainer, 29/10/2026).
let remembered: string | null = null;

/** Sets the row the list opens with next, as a row's press or a link does; null closes them all. */
export function rememberOpenRow(key: string | null) {
  remembered = key;
}

/**
 * Which row of Settings is open (#511): one at a time, so that opening a row
 * closes the one that was open, and the list stays short enough to scan.
 * `asked` opens a row as a link names it (the screen-reader hint's way to the
 * photo descriptions, a flow's way to logging out), also when the link comes
 * while the list is open. Every row opened while the list is on screen keeps
 * its panel mounted until the list goes (`opened`), so what was typed under a
 * row that closed waits for it to open again.
 */
export function useOpenRow(asked?: string) {
  const [open, setOpen] = useState<string | null>(() => asked ?? remembered);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(open ? [open] : []));
  useEffect(() => {
    if (asked) setOpen(asked);
  }, [asked]);
  useEffect(() => {
    rememberOpenRow(open);
    if (open) setOpened((was) => (was.has(open) ? was : new Set([...was, open])));
  }, [open]);
  const toggle = useCallback((key: string) => setOpen((now) => (now === key ? null : key)), []);
  return { open, opened, toggle };
}
