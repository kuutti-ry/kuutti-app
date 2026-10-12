import { AdminSession, AdminWhoAmI } from "@kuutti/schema";
import * as React from "react";
import { API_URL, api, failed, setTokenSource, setUnauthorizedHandler } from "../../lib/api.ts";

/**
 * The staff session (#49, rules/admin.md): eight hours, no refresh, one
 * bearer token the API handed out for a one-time code. The code arrives in
 * the URL fragment after the bank login (never in a query string, so no
 * server log sees it) and is exchanged once; the session lives in
 * sessionStorage, so a closed tab ends it and another tab of the same window
 * shares it. A refusal arrives the same way, as #error=admin_not_allowed.
 */
export type StaffSession = AdminSession;

const KEY = "kuutti.admin.session";

function readStored(): StaffSession | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? AdminSession.parse(JSON.parse(raw)) : null;
    return parsed && new Date(parsed.expiresAt).getTime() > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(session: StaffSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // No storage (private mode with storage off): the session lives in memory for this page.
  }
}

/** What the fragment carried: a code to exchange, a refusal to show, or nothing. */
export function readFragment(hash: string): { code?: string; error?: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("code");
  const error = params.get("error");
  return { ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out"; error?: string }
  | { status: "signed-in"; session: StaffSession };

type SessionApi = SessionState & {
  signIn: () => void;
  signOut: () => Promise<void>;
};

const SessionContext = React.createContext<SessionApi | null>(null);

export function StaffSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SessionState>({ status: "loading" });
  const stateRef = React.useRef(state);
  stateRef.current = state;

  // The client's middleware reads the token from here; never from storage
  // directly. A 401 to a request that carried it ends the session here, from
  // whichever screen asked: back to the sign-in, saying so (#250).
  React.useEffect(() => {
    setTokenSource(() =>
      stateRef.current.status === "signed-in" ? stateRef.current.session.accessToken : null,
    );
    setUnauthorizedHandler(() => {
      writeStored(null);
      setState({ status: "signed-out", error: "session_ended" });
    });
    // A panel that has closed signs nobody out on a late answer.
    return () => setUnauthorizedHandler(() => undefined);
  }, []);

  React.useEffect(() => {
    let mounted = true;
    // No API address (a production build without VITE_API_URL): nothing is
    // sent anywhere, and the panel says it cannot sign in.
    if (!API_URL) {
      setState({ status: "signed-out", error: "no_api" });
      return;
    }
    const fragment = readFragment(window.location.hash);
    if (fragment.code || fragment.error) {
      // The fragment is consumed once: a reload must not exchange or show it again.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    // Up to its first await this runs inside the effect itself, where `mounted` is still true.
    void (async () => {
      if (fragment.error) {
        writeStored(null);
        setState({ status: "signed-out", error: fragment.error });
        return;
      }
      if (fragment.code) {
        // Not gated on `mounted`: React's StrictMode runs this effect twice in
        // development, and the second run finds the fragment already consumed.
        // The code is single-use, so the first run's exchange is the one that
        // counts, and its late setState lands on the live provider.
        const { data, error, response } = await api.POST("/admin/auth/exchange", {
          body: { code: fragment.code },
        });
        if (!data) {
          setState({
            status: "signed-out",
            error: failed(response, error, "exchange").code ?? "generic",
          });
          return;
        }
        const session = AdminSession.parse(data);
        writeStored(session);
        setState({ status: "signed-in", session });
        return;
      }
      const stored = readStored();
      if (!stored) {
        // The second StrictMode run must not undo the first run's exchange in flight.
        setState((previous) =>
          previous.status === "loading" ? { status: "signed-out" } : previous,
        );
        return;
      }
      // A stored token is checked against the API before anything is shown
      // with it. The client's middleware reads the ref, and setState fills it
      // only on the next render, so the ref is set here first or the first
      // request would go out without the token and sign the person out.
      stateRef.current = { status: "signed-in", session: stored };
      setState(stateRef.current);
      const { data } = await api.GET("/admin/whoami");
      if (!mounted) return;
      if (!data) {
        writeStored(null);
        // A 401 has already ended the session and said so; keep that.
        setState((previous) =>
          previous.status === "signed-out" ? previous : { status: "signed-out" },
        );
      } else {
        const me = AdminWhoAmI.parse(data);
        // Only a session still signed in is confirmed: a request that came
        // back 401 while this one was out has ended it, and it stays ended.
        setState((previous) =>
          previous.status === "signed-in"
            ? {
                status: "signed-in",
                session: { ...stored, role: me.role, expiresAt: me.expiresAt },
              }
            : previous,
        );
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const signIn = React.useCallback(() => {
    if (!API_URL) return;
    window.location.assign(`${API_URL}/admin/auth/start`);
  }, []);

  const signOut = React.useCallback(async () => {
    await api.POST("/admin/auth/logout").catch(() => undefined);
    writeStored(null);
    setState({ status: "signed-out" });
  }, []);

  const value = React.useMemo<SessionApi>(
    () => ({ ...state, signIn, signOut }),
    [state, signIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useStaffSession(): SessionApi {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error("useStaffSession needs a StaffSessionProvider above it");
  return value;
}
