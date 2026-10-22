import type { Invitations } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetchInvitations } from "./client";

export type InvitationsView =
  | { status: "loading" }
  | { status: "ready"; invitations: Invitations }
  /** `error` says why, for the screen to say so (LoadFailed). */
  | { status: "failed"; error: unknown };

/**
 * The person's invitations (#107), read the way the gate is (useGate): when
 * the screen comes to the front and when the app comes back to the
 * foreground, since a friend may use a code and the night may count one while
 * the screen is open in a pocket. What is shown stays until the new answer is
 * there, and a quiet read that fails takes nothing away. `refresh` is such a
 * read after the screen's own changes, and resolves once it has answered.
 */
export function useInvitations(): InvitationsView & {
  retry: () => void;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<InvitationsView>({ status: "loading" });
  const mounted = useRef(true);
  const asked = useRef(0);

  const read = useCallback((quietly: boolean): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    // Of two reads under way the later one speaks.
    const current = () => mounted.current && mine === asked.current;
    if (!quietly) setState({ status: "loading" });
    return fetchInvitations().then(
      (invitations) => {
        if (current()) setState({ status: "ready", invitations });
      },
      (error: unknown) => {
        if (!current()) return;
        setState((was) => (quietly && was.status === "ready" ? was : { status: "failed", error }));
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void read(true);
    }, [read]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void read(true);
    });
    return () => subscription.remove();
  }, [read]);

  const retry = useCallback(() => void read(false), [read]);
  const refresh = useCallback(() => read(true), [read]);
  return { ...state, retry, refresh };
}
