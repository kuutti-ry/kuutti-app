import { readFragment } from "./session.tsx";

// Where a member of staff was when they went to the bank (#302). The API
// returns every staff login to the panel's own address (ADMIN_APP_URL, with
// the one-time code or the refusal in the fragment, ADR-006 §5), so the panel
// remembers the path itself and puts it back before the router starts: no
// screen flashes up and asks the API for anything on the way.

const KEY = "kuutti.admin.return";

/** A path of this origin: one slash, then anything but a second one. Never a scheme, never another host. */
const SAME_ORIGIN_PATH = /^\/(?!\/)/;

/** Before the bank login: the path and query the person is on. */
export function rememberReturnPath(location: Pick<Location, "pathname" | "search">): void {
  try {
    window.sessionStorage.setItem(KEY, location.pathname + location.search);
  } catch {
    // No storage (private mode with storage off): the person lands on the front page.
  }
}

/**
 * On the bank's return, before the router reads the address: the remembered
 * path, with the fragment the session still has to read. Nothing happens
 * without a code or a refusal in the fragment; the remembered path is used
 * once, and one that is not a path of this origin is dropped.
 */
export function restoreReturnPath(
  location: Pick<Location, "hash"> = window.location,
  history: Pick<History, "replaceState"> = window.history,
): void {
  const fragment = readFragment(location.hash);
  if (!fragment.code && !fragment.error) return;
  let path: string | null = null;
  try {
    path = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (path && SAME_ORIGIN_PATH.test(path)) history.replaceState(null, "", path + location.hash);
}
