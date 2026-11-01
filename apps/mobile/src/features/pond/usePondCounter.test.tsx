import { act, renderHook, waitFor } from "@testing-library/react-native";
import { usePondCounter } from "./usePondCounter";

// What the counter says of the one pond (#54): its figures, none when the
// list is empty, a failure with a retry, and the answer of a read that a retry
// replaced is dropped.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ENTRY = {
  pond: { id: "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e01", slug: "suomi", name: "Suomi" },
  day: "2026-10-05",
  verified: 150,
  split: null,
  finishing: null,
  seeks: null,
};
const COUNTER = { k: 10, ponds: [ENTRY] };

function pendingReads() {
  const waiting: Array<(response: Response) => void> = [];
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        waiting.push(resolve);
      }),
  ) as unknown as typeof fetch;
  return waiting;
}

describe("usePondCounter", () => {
  it("gives the pond's figures and the step they are said in", async () => {
    globalThis.fetch = jest.fn(async () => json(COUNTER)) as unknown as typeof fetch;
    const { result } = await renderHook(() => usePondCounter());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ status: "ready", k: 10, figures: ENTRY });
  });

  it("has no figures when the list is empty", async () => {
    globalThis.fetch = jest.fn(async () => json({ k: 10, ponds: [] })) as unknown as typeof fetch;
    const { result } = await renderHook(() => usePondCounter());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ k: 10, figures: null });
  });

  it("fails, and loads again on a retry", async () => {
    const waiting = pendingReads();
    const { result } = await renderHook(() => usePondCounter());
    await act(async () => waiting.shift()?.(json({ error: { code: "internal_error" } }, 503)));
    expect(result.current.status).toBe("failed");
    await act(async () => result.current.retry());
    expect(result.current.status).toBe("loading");
    await act(async () => waiting.shift()?.(json(COUNTER)));
    expect(result.current).toMatchObject({ status: "ready", figures: ENTRY });
  });

  it("drops the answer, or the failure, of a read that a retry replaced", async () => {
    const waiting = pendingReads();
    const { result } = await renderHook(() => usePondCounter());
    await act(async () => result.current.retry());
    const [first, second] = waiting;
    await act(async () => first?.(json(COUNTER)));
    expect(result.current.status).toBe("loading");
    await act(async () => second?.(json(COUNTER)));
    expect(result.current).toMatchObject({ figures: ENTRY });
    await act(async () => result.current.retry());
    await act(async () => result.current.retry());
    const [, , third, fourth] = waiting;
    await act(async () => third?.(json({ error: { code: "internal_error" } }, 503)));
    expect(result.current.status).toBe("loading");
    await act(async () => fourth?.(json(COUNTER)));
    expect(result.current).toMatchObject({ status: "ready", figures: ENTRY });
  });
});
