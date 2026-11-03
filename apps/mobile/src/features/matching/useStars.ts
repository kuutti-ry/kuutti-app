import type { StarredPerson } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { clearStar, fetchStars } from "./client";

export type StarsView =
  | { status: "loading" }
  | { status: "ready"; items: StarredPerson[] }
  | { status: "failed"; error: unknown };

/**
 * The Starred list (#575, ADR-064 §6), read whenever the screen comes to the front,
 * since the API asks the filters on every read and a card opened from it may have
 * taken a star off. What is shown stays until the new answer is there, and a read
 * that fails takes nothing away that was known. It signs nothing: a row's thumb is
 * asked for as any photo's.
 */
export function useStars() {
  const [view, setView] = useState<StarsView>({ status: "loading" });
  const [clearFailed, setClearFailed] = useState(false);
  const asked = useRef(0);

  const read = useCallback(async () => {
    asked.current += 1;
    const mine = asked.current;
    try {
      const items = await fetchStars();
      if (mine === asked.current) setView({ status: "ready", items });
    } catch (error) {
      if (mine !== asked.current) return;
      setView((was) => (was.status === "ready" ? was : { status: "failed", error }));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void read();
    }, [read]),
  );

  /** A star taken off: its row goes, also when another phone took it off first (404). */
  const clear = useCallback(async (id: string) => {
    setClearFailed(false);
    try {
      await clearStar(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        setClearFailed(true);
        return;
      }
    }
    asked.current += 1;
    setView((was) =>
      was.status === "ready"
        ? { status: "ready", items: was.items.filter((item) => item.id !== id) }
        : was,
    );
  }, []);

  return {
    view,
    clearFailed,
    clear,
    retry: useCallback(() => {
      setView({ status: "loading" });
      void read();
    }, [read]),
  };
}
