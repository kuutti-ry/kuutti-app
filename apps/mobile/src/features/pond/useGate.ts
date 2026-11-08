import type { GateResponse } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetchGate } from "./client";

export type GateView =
  | { status: "loading" }
  | { status: "ready"; gate: GateResponse }
  /** `error` says why, for the card to say so (LoadFailed). */
  | { status: "failed"; error: unknown };

/**
 * Whether matching is open for the person (#500). Read when the screen comes
 * to the front and when the app comes back to the foreground: the home screen
 * stays where it is while the person adds their photos on another one, and
 * while an admin opens their pond with the app in a pocket. What is shown stays
 * until the new answer is there, so a look at the card never flickers and a
 * read that fails takes nothing away that was known.
 */
export function useGate(): GateView & { retry: () => void } {
  const [state, setState] = useState<GateView>({ status: "loading" });
  const mounted = useRef(true);
  const asked = useRef(0);

  const read = useCallback((quietly: boolean) => {
    asked.current += 1;
    const mine = asked.current;
    // Of two reads under way the later one speaks.
    const current = () => mounted.current && mine === asked.current;
    if (!quietly) setState({ status: "loading" });
    fetchGate()
      .then((gate) => {
        if (current()) setState({ status: "ready", gate });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        setState((was) => (quietly && was.status === "ready" ? was : { status: "failed", error }));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      read(true);
    }, [read]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") read(true);
    });
    return () => subscription.remove();
  }, [read]);

  const retry = useCallback(() => read(false), [read]);
  return { ...state, retry };
}
