import { act, renderHook } from "@testing-library/react-native";
import { rememberOpenRow, useOpenRow } from "./open-rows";

// Which row of Settings is open, and the one left open while the app runs (#511).

const A = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const B = "0b2a7d4e-5c1f-4e8a-9d3b-7f6e5d4c3b2a";

beforeEach(() => rememberOpenRow(null, null));

describe("useOpenRow", () => {
  it("opens with the row the same session left open, and with none for another", async () => {
    rememberOpenRow("theme", A);
    const same = await renderHook(() => useOpenRow(undefined, A));
    expect(same.result.current.open).toBe("theme");
    rememberOpenRow("theme", A);
    const other = await renderHook(() => useOpenRow(undefined, B));
    expect(other.result.current.open).toBeNull();
  });

  it("waits for the stored session before it opens the row left open, and keeps the memory meanwhile", async () => {
    rememberOpenRow("lock", A);
    const hook = await renderHook(
      ({ session }: { session: string | null | undefined }) => useOpenRow(undefined, session),
      { initialProps: { session: undefined as string | null | undefined } },
    );
    expect(hook.result.current.open).toBeNull();
    await hook.rerender({ session: A });
    expect(hook.result.current.open).toBe("lock");
  });

  it("opens the row a link names over the one left open, and remembers it", async () => {
    rememberOpenRow("theme", A);
    const hook = await renderHook(() => useOpenRow("device", A));
    expect(hook.result.current.open).toBe("device");
    const again = await renderHook(() => useOpenRow(undefined, A));
    expect(again.result.current.open).toBe("device");
  });

  it("opens one row at a time, a second press closing it, and keeps every opened panel", async () => {
    const hook = await renderHook(() => useOpenRow(undefined, null));
    await act(async () => hook.result.current.toggle("theme"));
    await act(async () => hook.result.current.toggle("language"));
    expect(hook.result.current.open).toBe("language");
    expect([...hook.result.current.opened]).toEqual(["theme", "language"]);
    await act(async () => hook.result.current.toggle("language"));
    expect(hook.result.current.open).toBeNull();
    const again = await renderHook(() => useOpenRow(undefined, null));
    expect(again.result.current.open).toBeNull();
  });

  it("keeps a row open through a logout, remembered for the session it was opened in", async () => {
    const hook = await renderHook(
      ({ session }: { session: string | null | undefined }) => useOpenRow(undefined, session),
      { initialProps: { session: A as string | null | undefined } },
    );
    await act(async () => hook.result.current.toggle("device"));
    await hook.rerender({ session: null });
    expect(hook.result.current.open).toBe("device");
    expect((await renderHook(() => useOpenRow(undefined, A))).result.current.open).toBe("device");
    // A list drawn in another session opens with none, and remembers that.
    expect((await renderHook(() => useOpenRow(undefined, null))).result.current.open).toBeNull();
    expect((await renderHook(() => useOpenRow(undefined, A))).result.current.open).toBeNull();
  });
});
