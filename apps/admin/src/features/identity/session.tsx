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
  const token = React.useRef<string | null>(null);
  const mounted = React.useRef(false);
  const started = React.useRef(false);
  const generation = React.useRef(0);

  // The token may authorize its own check while the screen stays loading.
  // A stored role is never enough to display a staff screen.
  React.useEffect(() => {
    setTokenSource(() => token.current);
    setUnauthorizedHandler(() => {
      if (token.current === null) return;
      token.current = null;
      generation.current += 1;
      writeStored(null);
      setState({ status: "signed-out", error: "session_ended" });
    });
    return () => {
      setTokenSource(() => null);
      setUnauthorizedHandler(() => undefined);
    };
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    const stop = () => {
      mounted.current = false;
    };
    // StrictMode replays effects: the single-use exchange belongs to the
    // provider, and its first run may finish during the replayed mount.
    if (started.current) return stop;
    started.current = true;
    if (!API_URL) {
      setState({ status: "signed-out", error: "no_api" });
      return stop;
    }
    const owner = generation.current;
    const current = () => mounted.current && generation.current === owner;
    const fragment = readFragment(window.location.hash);
    if (fragment.code || fragment.error) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    void (async () => {
      try {
        if (fragment.error) {
          writeStored(null);
          setState({ status: "signed-out", error: fragment.error });
          return;
        }
        if (fragment.code) {
          const { data, error, response } = await api.POST("/admin/auth/exchange", {
            body: { code: fragment.code },
          });
          if (!current()) return;
          if (!data) {
            writeStored(null);
            setState({
              status: "signed-out",
              error: failed(response, error, "exchange").code ?? "generic",
            });
            return;
          }
          const session = AdminSession.parse(data);
          token.current = session.accessToken;
          writeStored(session);
          setState({ status: "signed-in", session });
          return;
        }
        const stored = readStored();
        if (!stored) {
          setState({ status: "signed-out" });
          return;
        }
        token.current = stored.accessToken;
        const { data } = await api.GET("/admin/whoami");
        if (!current()) return;
        if (!data) {
          token.current = null;
          writeStored(null);
          setState({ status: "signed-out" });
          return;
        }
        const me = AdminWhoAmI.parse(data);
        const session = { ...stored, role: me.role, expiresAt: me.expiresAt };
        writeStored(session);
        setState({ status: "signed-in", session });
      } catch {
        if (!current()) return;
        token.current = null;
        writeStored(null);
        setState({ status: "signed-out", ...(fragment.code ? { error: "generic" } : {}) });
      }
    })();
    return stop;
  }, []);

  const signIn = React.useCallback(() => {
    if (!API_URL) return;
    window.location.assign(`${API_URL}/admin/auth/start`);
  }, []);

  const signOut = React.useCallback(async () => {
    const logout = api.POST("/admin/auth/logout");
    generation.current += 1;
    token.current = null;
    writeStored(null);
    setState({ status: "signed-out" });
    await logout.catch(() => undefined);
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
