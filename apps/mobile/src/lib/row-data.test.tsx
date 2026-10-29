import { act, renderHook } from "@testing-library/react-native";
import { useRowData } from "./row-data";

// What a row of Settings says of the setting it holds (#511): read as the
// list comes to the front, replaced by what its panel stores.

const expoRouter = jest.requireMock("expo-router") as { __focus: () => void; __blur: () => void };

/** A read the test answers when it chooses. */
function deferred<T>() {
  let answer: (value: T) => void = () => undefined;
  let refuse: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("useRowData", () => {
  it("reads as the list comes to the front, and says what the read answered", async () => {
    const read = jest.fn(async () => 3);
    const { result } = await renderHook(() => useRowData(read, true));
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe(3);
  });

  it("reads nothing while it may not, as for a device with no session", async () => {
    const read = jest.fn(async () => 3);
    const { result } = await renderHook(() => useRowData(read, false));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("says nothing after a read that failed", async () => {
    const read = jest.fn(async () => {
      throw new Error("offline");
    });
    const { result } = await renderHook(() => useRowData(read, true));
    await settle();
    expect(result.current.data).toBeUndefined();
  });

  it("takes what the panel stored in place of what it read", async () => {
    const read = async () => 3;
    const { result } = await renderHook(() => useRowData(read, true));
    await settle();
    await act(async () => result.current.stored(4));
    expect(result.current.data).toBe(4);
  });

  it("reads again each time the list is back in front", async () => {
    let reads = 0;
    const read = jest.fn(async () => {
      reads += 1;
      return reads;
    });
    const { result } = await renderHook(() => useRowData(read, true));
    await settle();
    expect(result.current.data).toBe(1);
    await act(async () => {
      expoRouter.__blur();
      expoRouter.__focus();
    });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(2);
  });

  it("leaves aside a read that answers after the list went out of sight", async () => {
    const pending = deferred<number>();
    const { result } = await renderHook(() => useRowData(() => pending.promise, true));
    await act(async () => expoRouter.__blur());
    await act(async () => pending.answer(7));
    await settle();
    expect(result.current.data).toBeUndefined();
  });
});
