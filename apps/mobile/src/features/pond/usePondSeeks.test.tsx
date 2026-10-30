import { act, renderHook, waitFor } from "@testing-library/react-native";
import { usePondSeeks } from "./usePondSeeks";

// The shares of the card's bar (#507): what the route says, nothing when it
// says nothing or fails, and an answer for a pond no longer asked about is dropped.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SHARES = { men: 30, everyone: 20, women: 50 };
const OTHER = { men: 40, everyone: 20, women: 40 };

describe("usePondSeeks", () => {
  it("gives the shares of the caller's pond", async () => {
    const seen: string[] = [];
    globalThis.fetch = jest.fn(async (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return json({ seeks: SHARES });
    }) as unknown as typeof fetch;
    const { result } = await renderHook(() => usePondSeeks("pond-1"));
    await waitFor(() => expect(result.current).toEqual(SHARES));
    expect(seen).toEqual(["/ponds/seeks"]);
  });

  it("has nothing while the pond may not say", async () => {
    const asked = jest.fn(async () => json({ seeks: null }));
    globalThis.fetch = asked as unknown as typeof fetch;
    const { result } = await renderHook(() => usePondSeeks("pond-1"));
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("has nothing when the read fails, and asks again for another pond", async () => {
    const answers = [json({ error: { code: "internal_error" } }, 503), json({ seeks: SHARES })];
    globalThis.fetch = jest.fn(async () => answers.shift()) as unknown as typeof fetch;
    const { result, rerender } = await renderHook(({ id }: { id: string }) => usePondSeeks(id), {
      initialProps: { id: "pond-1" },
    });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
    await rerender({ id: "pond-2" });
    await waitFor(() => expect(result.current).toEqual(SHARES));
  });

  it("drops the answer, or the failure, for a pond no longer asked about", async () => {
    const waiting: Array<(response: Response) => void> = [];
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          waiting.push(resolve);
        }),
    ) as unknown as typeof fetch;
    const { result, rerender } = await renderHook(({ id }: { id: string }) => usePondSeeks(id), {
      initialProps: { id: "pond-1" },
    });
    await rerender({ id: "pond-2" });
    const [first, second] = waiting;
    await act(async () => first?.(json({ seeks: OTHER })));
    expect(result.current).toBeNull();
    await act(async () => second?.(json({ seeks: SHARES })));
    expect(result.current).toEqual(SHARES);
    await rerender({ id: "pond-1" });
    await rerender({ id: "pond-2" });
    const [, , third, fourth] = waiting;
    await act(async () => third?.(json({ error: { code: "internal_error" } }, 503)));
    expect(result.current).toBeNull();
    await act(async () => fourth?.(json({ seeks: OTHER })));
    expect(result.current).toEqual(OTHER);
  });
});
