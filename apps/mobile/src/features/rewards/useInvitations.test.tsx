import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { saveSession } from "@/lib/session";
import { useInvitations } from "./useInvitations";

// The person's invitations (#107), read as the gate is (useGate): on focus
// and on coming back to the foreground, quietly (what is shown stays until
// the answer is there), loudly on a retry; of two reads under way the later
// one speaks; a refresh resolves once its answer is in.

const { __focus: focus } = jest.requireMock("expo-router") as { __focus: () => void };
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = () =>
  json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
const invitations = (counted: number) => ({
  canInvite: true,
  redeemable: false,
  reward: { fish: 1, likes: 0 },
  open: [],
  counted,
  earned: { fish: 0, likes: 0 },
});

/** Each read waits for the test to answer it. */
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
function answering(...answers: Array<() => Response>) {
  let n = 0;
  globalThis.fetch = jest.fn(async () => {
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    if (!answer) throw new Error("no answer prepared");
    return answer();
  }) as unknown as typeof fetch;
  return () => n;
}

let appStateListener: ((state: string) => void) | undefined;
beforeEach(async () => {
  appStateListener = undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: jest.fn() } as never;
  });
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("useInvitations", () => {
  it("reads the invitations when the screen has the focus", async () => {
    answering(() => json(invitations(0)));
    const { result } = await renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ status: "ready", invitations: invitations(0) });
  });

  it("says it failed when the first read fails, and loads again on a retry", async () => {
    answering(failure, () => json(invitations(1)));
    const { result } = await renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("shows loading on a retry, but keeps what it showed when a quiet read fails", async () => {
    const waiting = pendingReads();
    const { result } = await renderHook(() => useInvitations());
    await act(async () => waiting.shift()?.(json(invitations(0))));
    expect(result.current.status).toBe("ready");
    await act(async () => focus());
    await act(async () => waiting.shift()?.(failure()));
    expect(result.current).toMatchObject({ status: "ready", invitations: invitations(0) });
    await act(async () => result.current.retry());
    expect(result.current.status).toBe("loading");
    await act(async () => waiting.shift()?.(failure()));
    expect(result.current.status).toBe("failed");
  });

  it("reads again when the app comes back to the foreground, not when it leaves", async () => {
    const reads = answering(
      () => json(invitations(0)),
      () => json(invitations(1)),
    );
    const { result } = await renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => appStateListener?.("background"));
    expect(reads()).toBe(1);
    await act(async () => appStateListener?.("active"));
    await waitFor(() => expect(result.current).toMatchObject({ invitations: invitations(1) }));
    expect(reads()).toBe(2);
  });

  it("refreshes quietly and resolves once the answer is in", async () => {
    answering(
      () => json(invitations(0)),
      () => json(invitations(3)),
    );
    const { result } = await renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current).toMatchObject({ status: "ready", invitations: invitations(3) });
  });

  it("lets the later of two reads speak, whichever answers first", async () => {
    const waiting = pendingReads();
    const { result } = await renderHook(() => useInvitations());
    await act(async () => result.current.retry());
    const [first, second] = waiting;
    await act(async () => second?.(json(invitations(1))));
    expect(result.current).toMatchObject({ status: "ready", invitations: invitations(1) });
    await act(async () => first?.(json(invitations(9))));
    expect(result.current).toMatchObject({ invitations: invitations(1) });
    await act(async () => result.current.retry());
    await act(async () => focus());
    const [, , third, fourth] = waiting;
    await act(async () => fourth?.(json(invitations(4))));
    await act(async () => third?.(failure()));
    expect(result.current).toMatchObject({ status: "ready", invitations: invitations(4) });
  });
});
