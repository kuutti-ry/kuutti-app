import { AuthExchangeResponse } from "@kuutti/schema";
import * as React from "react";
import { ApiError, api } from "@/lib/api";
import {
  clearSession,
  loadSession,
  onSessionChange,
  type StoredSession,
  saveSession,
} from "@/lib/session";

/**
 * Whether this device is signed in (#35). "loading" until the stored session
 * has been read; the sign-in screen and the deep-link handler (#36) call
 * signIn with the one-time code and the verifier of the attempt it belongs to
 * (ADR-027); a refresh the API refuses flips the state to signed-out on its
 * own, wherever the app is.
 */
type AuthOutcome = AuthExchangeResponse["outcome"];

export type SessionState =
  | { status: "loading" }
  /** `notice` is what the sign-in screen says next: "paused" right after a break began on this device (#170). */
  | { status: "signed-out"; notice?: "paused" }
  | { status: "signed-in"; sessionId: string; outcome?: AuthOutcome };

/** The export as the API answers it (#237): a zip, named by the API, nothing about the person in the name. */
export type ExportFile = { name: string; bytes: Uint8Array };

const DEFAULT_EXPORT_NAME = "kuutti-data.zip";

/**
 * The name from `Content-Disposition: attachment; filename="..."`, or the
 * default when the header says nothing. The API's stems are ASCII; the
 * replacement keeps the name a file name whatever a later catalogue says,
 * since it becomes a path on the phone.
 */
export function exportFileName(disposition: string | null): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1]?.replace(/[^\w.-]/g, "_") ?? DEFAULT_EXPORT_NAME;
}

type SessionApi = SessionState & {
  signIn: (code: string, verifier: string) => Promise<AuthOutcome>;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
  /** Everything Kuutti holds about the person (#51), as the API answers it: the zip and its name. */
  exportData: () => Promise<ExportFile>;
  /** Erasure per TD-7 (#51); the device is signed out locally at once. */
  deleteAccount: () => Promise<void>;
  /** Taking a break (#170, ADR-022): the API pauses the account and ends every session; the device is signed out locally with the notice. */
  pauseAccount: () => Promise<void>;
};

const SessionContext = React.createContext<SessionApi | null>(null);

const fromStored = (session: StoredSession | null): SessionState =>
  session ? { status: "signed-in", sessionId: session.sessionId } : { status: "signed-out" };

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SessionState>({ status: "loading" });

  React.useEffect(() => {
    let mounted = true;
    void loadSession().then((session) => {
      if (mounted) setState(fromStored(session));
    });
    // Unsubscribed in the same cleanup that ends `mounted`: no call comes after it.
    const unsubscribe = onSessionChange((session) => {
      setState((previous) => merge(previous, fromStored(session)));
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const signIn = React.useCallback(async (code: string, verifier: string) => {
    const { data, error, response } = await api.POST("/auth/exchange", {
      body: { code, verifier },
    });
    if (!data) {
      throw new ApiError(`sign-in answered ${response.status}`, response.status, error?.error.code);
    }
    const { outcome, ...tokens } = AuthExchangeResponse.parse(data);
    await saveSession(tokens);
    setState({ status: "signed-in", sessionId: tokens.sessionId, outcome });
    return outcome;
  }, []);

  // Ending the session locally does not wait for the API: a phone without
  // network still signs out, and the row expires or is swept later.
  const signOut = React.useCallback(async () => {
    await api.POST("/auth/logout").catch(() => undefined);
    await clearSession();
  }, []);

  const signOutEverywhere = React.useCallback(async () => {
    const { response } = await api.POST("/auth/logout-all");
    if (!response.ok && response.status !== 401) {
      throw new ApiError(`log out everywhere answered ${response.status}`, response.status);
    }
    await clearSession();
  }, []);

  const exportData = React.useCallback(async (): Promise<ExportFile> => {
    const { data, error, response } = await api.GET("/account/export", {
      parseAs: "arrayBuffer",
    });
    if (!data) {
      throw new ApiError(`export answered ${response.status}`, response.status, error?.error.code);
    }
    return {
      name: exportFileName(response.headers.get("content-disposition")),
      bytes: new Uint8Array(data),
    };
  }, []);

  // The API has already ended every token of the account when it answers 204;
  // the local store follows. A failure leaves the session in place.
  const deleteAccount = React.useCallback(async () => {
    const { error, response } = await api.POST("/account/delete", { body: { confirm: true } });
    if (!response.ok) {
      throw new ApiError(
        `deletion answered ${response.status}`,
        response.status,
        error?.error.code,
      );
    }
    await clearSession();
  }, []);

  // Like the deletion, but nothing is gone: the sign-in screen says so, once,
  // from the notice; the store's own change arrives first and this state after it.
  const pauseAccount = React.useCallback(async () => {
    const { error, response } = await api.POST("/account/pause", { body: { confirm: true } });
    if (!response.ok) {
      throw new ApiError(`break answered ${response.status}`, response.status, error?.error.code);
    }
    await clearSession();
    setState({ status: "signed-out", notice: "paused" });
  }, []);

  const value = React.useMemo<SessionApi>(
    () => ({
      ...state,
      signIn,
      signOut,
      signOutEverywhere,
      exportData,
      deleteAccount,
      pauseAccount,
    }),
    [state, signIn, signOut, signOutEverywhere, exportData, deleteAccount, pauseAccount],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** A store change during sign-in keeps the outcome the exchange reported. */
function merge(previous: SessionState, next: SessionState): SessionState {
  if (
    previous.status === "signed-in" &&
    next.status === "signed-in" &&
    previous.sessionId === next.sessionId
  ) {
    return previous;
  }
  return next;
}

export function useSession(): SessionApi {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error("useSession needs a SessionProvider above it");
  return value;
}
