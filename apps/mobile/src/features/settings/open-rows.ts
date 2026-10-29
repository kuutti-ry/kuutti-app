import { useCallback, useEffect, useRef, useState } from "react";

// The row of Settings left open, while the app runs (#511): back from the
// licences or from home, the list is as it was; a cold start has every row
// closed. Kept in memory alone, never on the phone (the maintainer, 29/10/2026).
// It belongs to the session that left it open: logged out, or somebody else
// logged in on the phone, the list starts with every row closed, not at
// Logging out where the last session ended.
let remembered: { key: string; session: string | null } | null = null;

/**
 * Sets the row the list opens with next, as a row's press or a link does,
 * for the session given (null while signed out); a null key closes them all.
 */
export function rememberOpenRow(key: string | null, session: string | null) {
  remembered = key === null ? null : { key, session };
}

/** The row the session left open, if it is the session that left it. */
const recall = (session: string | null) =>
  remembered?.session === session ? remembered.key : null;

/**
 * Which row of Settings is open (#511): one at a time, so that opening a row
 * closes the one that was open, and the list stays short enough to scan.
 * `asked` opens a row as a link names it (the screen-reader hint's way to the
 * photo descriptions, a flow's way to logging out), also when the link comes
 * while the list is open. Every row opened while the list is on screen keeps
 * its panel mounted until the list goes (`opened`), so what was typed under a
 * row that closed waits for it to open again. `session` is the session's id,
 * null while signed out, undefined while the stored session is still being
 * read (the app's first moments).
 */
export function useOpenRow(asked: string | undefined, session: string | null | undefined) {
  const [open, setOpen] = useState<string | null>(
    () => asked ?? (session === undefined ? null : recall(session)),
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(open ? [open] : []));
  useEffect(() => {
    if (asked) setOpen(asked);
  }, [asked]);
  // Drawn before the stored session was read: the row it left open, once it
  // is known. Read here, not in the update, which runs after the effect
  // below has remembered the list as it was drawn, with no row open.
  useEffect(() => {
    if (session === undefined || asked) return;
    const left = recall(session);
    setOpen((now) => now ?? left);
  }, [session, asked]);
  // The session the row was opened in, not the one after it: a logout keeps
  // Logging out open on screen, saying there is no session, and the next
  // session finds the list closed. Nothing is remembered before the session
  // is known, so that the memory outlasts the first moments.
  const openedIn = useRef(session);
  openedIn.current = session;
  const known = session !== undefined;
  useEffect(() => {
    if (known) rememberOpenRow(open, openedIn.current ?? null);
    if (open) setOpened((was) => (was.has(open) ? was : new Set([...was, open])));
  }, [open, known]);
  const toggle = useCallback((key: string) => setOpen((now) => (now === key ? null : key)), []);
  return { open, opened, toggle };
}
