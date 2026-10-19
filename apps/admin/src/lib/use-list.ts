import { useCallback, useEffect, useRef, useState } from "react";

// One list a screen loads from one admin route (#302): the photo queue and the
// feedback list share it, and every later queue will. A 403 is its own state,
// rendered as nothing, because the shell has already said that the role does
// not allow it (lib/api.ts); a 401 never reaches a screen, since it ends the
// session. Only the latest load lands: a refresh that overtakes an earlier one
// is not undone by the earlier answer arriving last.

export type ListPage<T> = { items: T[]; total: number };

/** Ready: the page as parsed, with whatever else it carries (the report queue's clock, #311). */
export type ListState<P extends ListPage<unknown>> =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "forbidden" }
  | ({ kind: "ready" } & P);

export type ListSource<P extends ListPage<unknown>> = {
  /** One request through the generated client; it resolves with the answer or rejects on the network. */
  fetchPage: () => Promise<{ data?: unknown; response: Response }>;
  /** The contract's parse: an answer that is not the contract is the error state. */
  parse: (data: unknown) => P;
  /** Names the list in the console line of a failed load. */
  what: string;
};

export function useList<P extends ListPage<unknown>>(
  source: ListSource<P>,
): {
  state: ListState<P>;
  reload: () => Promise<void>;
  /** One item was decided where it stands: what waits goes down by one. */
  settle: () => void;
  /** The items changed where they stand, without a reload that would unmount them. */
  update: (change: (items: P["items"]) => P["items"]) => void;
} {
  const [state, setState] = useState<ListState<P>>({ kind: "loading" });
  // The source is read at load time, so a screen may pass a new object on every render.
  const current = useRef(source);
  current.current = source;
  const latest = useRef(0);

  const reload = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    const land = (next: ListState<P>) => {
      if (mine === latest.current) setState(next);
    };
    setState({ kind: "loading" });
    try {
      const { data, response } = await current.current.fetchPage();
      if (response.status === 403) return land({ kind: "forbidden" });
      if (!data) return land({ kind: "error" });
      land({ kind: "ready", ...current.current.parse(data) });
    } catch (error) {
      // A network failure or an answer that is not the contract: the same
      // error state, never a loading state that nothing will end.
      console.error(`${current.current.what} load failed`, error);
      land({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const settle = useCallback(
    () =>
      setState((previous) =>
        previous.kind === "ready"
          ? { ...previous, total: Math.max(0, previous.total - 1) }
          : previous,
      ),
    [],
  );

  const update = useCallback(
    (change: (items: P["items"]) => P["items"]) =>
      setState((previous) =>
        previous.kind === "ready" ? { ...previous, items: change(previous.items) } : previous,
      ),
    [],
  );

  return { state, reload, settle, update };
}
