import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useWaitlist } from "./useWaitlist";

// What the public counter says of one pond (#54): its figures, none when the
// list does not name it, a failure with a retry, and an answer for a pond
// that is no longer asked about is dropped.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pond = (n: number) => ({
  id: `0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e${n.toString().padStart(2, "0")}`,
  slug: `pond-${n}`,
  name: `Pond ${n}`,
  nameInessive: `Pond ${n}`,
  parentId: null,
});
const entry = (n: number, verified: number) => ({
  pond: pond(n),
  day: "2026-10-05",
  verified,
  split: null,
  finishing: null,
});
const WAITLIST = { k: 10, ponds: [entry(1, 150), entry(2, 40)] };

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

describe("useWaitlist", () => {
  it("gives the figures of the asked pond and the step they are said in", async () => {
    globalThis.fetch = jest.fn(async () => json(WAITLIST)) as unknown as typeof fetch;
    const { result } = await renderHook(() => useWaitlist(pond(2).id));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ status: "ready", k: 10, figures: entry(2, 40) });
  });

  it("has no figures for a pond the list does not name", async () => {
    globalThis.fetch = jest.fn(async () => json(WAITLIST)) as unknown as typeof fetch;
    const { result } = await renderHook(() => useWaitlist(pond(9).id));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ k: 10, figures: null });
  });

  it("fails, and loads again on a retry", async () => {
    const waiting = pendingReads();
    const { result } = await renderHook(() => useWaitlist(pond(1).id));
    await act(async () => waiting.shift()?.(json({ error: { code: "internal_error" } }, 503)));
    expect(result.current.status).toBe("failed");
    await act(async () => result.current.retry());
    expect(result.current.status).toBe("loading");
    await act(async () => waiting.shift()?.(json(WAITLIST)));
    expect(result.current).toMatchObject({ status: "ready", figures: entry(1, 150) });
  });

  it("drops the answer, or the failure, for a pond no longer asked about", async () => {
    const waiting = pendingReads();
    const { result, rerender } = await renderHook(({ id }: { id: string }) => useWaitlist(id), {
      initialProps: { id: pond(1).id },
    });
    await rerender({ id: pond(2).id });
    const [first, second] = waiting;
    await act(async () => first?.(json(WAITLIST)));
    expect(result.current.status).toBe("loading");
    await act(async () => second?.(json(WAITLIST)));
    expect(result.current).toMatchObject({ figures: entry(2, 40) });
    await rerender({ id: pond(1).id });
    await rerender({ id: pond(2).id });
    const [, , third, fourth] = waiting;
    await act(async () => third?.(json({ error: { code: "internal_error" } }, 503)));
    expect(result.current.status).toBe("loading");
    await act(async () => fourth?.(json(WAITLIST)));
    expect(result.current).toMatchObject({ status: "ready", figures: entry(2, 40) });
  });
});
