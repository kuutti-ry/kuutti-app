import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ListPage, type ListSource, useList } from "./use-list.ts";

// The list every queue screen loads (#302): its states, the reload, the
// count that goes down as items are decided, and the order loads land in.

type Item = { id: number };

const page = (items: Item[], total = items.length): ListPage<Item> => ({ items, total });
const answer = (data: unknown, status = 200) => ({
  data: status < 400 ? data : undefined,
  response: new Response(null, { status }),
});
const parse = (data: unknown): ListPage<Item> => {
  const value = data as ListPage<Item>;
  if (!Array.isArray(value?.items) || typeof value.total !== "number") {
    throw new Error("not the contract");
  }
  return value;
};
const source = (fetchPage: ListSource<Item>["fetchPage"]): ListSource<Item> => ({
  fetchPage,
  parse,
  what: "probe",
});

/** A request whose answer the test hands over when it wants to. */
function deferred() {
  let resolve: (value: ReturnType<typeof answer>) => void = () => undefined;
  const promise = new Promise<ReturnType<typeof answer>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useList", () => {
  it("loads once on mount: loading, then the items with how many wait in all", async () => {
    const fetchPage = vi.fn(async () => answer(page([{ id: 1 }, { id: 2 }], 7)));
    const { result } = renderHook(() => useList(source(fetchPage)));
    expect(result.current.state).toEqual({ kind: "loading" });
    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: "ready",
        items: [{ id: 1 }, { id: 2 }],
        total: 7,
      }),
    );
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("is the error state when the answer carries no data (a 500, a proxy's page)", async () => {
    const { result } = renderHook(() => useList(source(async () => answer(null, 500))));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "error" }));
  });

  it("is its own state on a 403, which the shell explains, not the error", async () => {
    const { result } = renderHook(() => useList(source(async () => answer(null, 403))));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "forbidden" }));
  });

  it("is the error state, and says which list in the console, when the network fails", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
    const failure = new TypeError("Failed to fetch");
    const { result } = renderHook(() =>
      useList(
        source(async () => {
          throw failure;
        }),
      ),
    );
    await waitFor(() => expect(result.current.state).toEqual({ kind: "error" }));
    expect(console).toHaveBeenCalledWith("probe load failed", failure);
  });

  it("is the error state when the answer is not the contract", async () => {
    vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useList(source(async () => answer({ items: "nope", total: 1 }))),
    );
    await waitFor(() => expect(result.current.state).toEqual({ kind: "error" }));
  });

  it("reloads on request: loading again, then what waits now", async () => {
    let round = 0;
    const { result } = renderHook(() =>
      useList(
        source(async () => {
          round += 1;
          return answer(page([{ id: round }]));
        }),
      ),
    );
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready", total: 1 }));
    let reloading: Promise<void> = Promise.resolve();
    act(() => {
      reloading = result.current.reload();
    });
    expect(result.current.state).toEqual({ kind: "loading" });
    await act(() => reloading);
    expect(result.current.state).toEqual({ kind: "ready", items: [{ id: 2 }], total: 1 });
  });

  it("takes one off what waits for each item settled, never below nothing", async () => {
    const { result } = renderHook(() => useList(source(async () => answer(page([{ id: 1 }], 2)))));
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready", total: 2 }));
    act(() => result.current.settle());
    expect(result.current.state).toMatchObject({ kind: "ready", total: 1 });
    act(() => {
      result.current.settle();
      result.current.settle();
    });
    expect(result.current.state).toMatchObject({ kind: "ready", total: 0 });
  });

  it("settles nothing while the list is not ready", async () => {
    const { result } = renderHook(() => useList(source(async () => answer(null, 500))));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "error" }));
    act(() => result.current.settle());
    expect(result.current.state).toEqual({ kind: "error" });
  });

  it("lands only the latest load: an earlier answer arriving last changes nothing", async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const { result } = renderHook(() => useList(source(() => (queue.shift() ?? second).promise)));
    let reloading: Promise<void> = Promise.resolve();
    act(() => {
      reloading = result.current.reload();
    });
    await act(async () => {
      second.resolve(answer(page([{ id: 2 }])));
      await reloading;
    });
    expect(result.current.state).toEqual({ kind: "ready", items: [{ id: 2 }], total: 1 });
    await act(async () => {
      first.resolve(answer(page([{ id: 1 }])));
      await first.promise;
    });
    expect(result.current.state).toEqual({ kind: "ready", items: [{ id: 2 }], total: 1 });
  });

  it("reads the source a screen passes at load time, so a new object on every render is fine", async () => {
    const one = vi.fn(async () => answer(page([{ id: 1 }])));
    const two = vi.fn(async () => answer(page([{ id: 2 }])));
    const { result, rerender } = renderHook(({ fetchPage }) => useList(source(fetchPage)), {
      initialProps: { fetchPage: one },
    });
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready" }));
    rerender({ fetchPage: two });
    // A new source is no reason to load again by itself.
    expect(two).not.toHaveBeenCalled();
    await act(() => result.current.reload());
    expect(two).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: "ready", items: [{ id: 2 }], total: 1 });
  });
});
