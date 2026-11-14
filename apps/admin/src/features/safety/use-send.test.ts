import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Answer, codeOf, useSend } from "./use-send.ts";

describe("codeOf", () => {
  it("reads the envelope's code of a refusal", () => {
    expect(codeOf({ error: { code: "config_conflict", message: "x", requestId: "r" } })).toBe(
      "config_conflict",
    );
  });

  it.each([
    ["no answer", undefined],
    ["an envelope without a code", { error: { message: "x" } }],
    ["a body that is not the envelope", { message: "Bad Gateway" }],
  ])("reads no code from %s", (_, error) => {
    expect(codeOf(error)).toBeUndefined();
  });
});

// A confirmation owns both its in-flight request and its follow-up work.
afterEach(cleanup);
const refusals = { codes: {}, failed: "admin.sanction.error.failed" } as const;
const done = (): Answer => ({ data: true, response: new Response(null, { status: 200 }) });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((answer) => {
      resolve = answer;
    }),
    resolve: (value: T) => resolve(value),
  };
};

it("keeps Cancel and a second send inert until the result and its follow-up finish", async () => {
  const request = deferred<Answer>();
  const followup = deferred<void>();
  const onCancel = vi.fn();
  const onDone = vi.fn(() => followup.promise);
  const sendRequest = vi.fn(() => request.promise);
  const { result } = renderHook(() =>
    useSend({ answer: z.literal(true), refusals, onShell: vi.fn(), onDone, onCancel }),
  );
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.send(sendRequest);
  });
  await act(async () => undefined);
  act(() => result.current.cancel());
  expect(onCancel).not.toHaveBeenCalled();
  await act(async () => {
    request.resolve(done());
  });
  expect(onDone).toHaveBeenCalledWith(true);
  try {
    await act(async () => {
      void result.current.send(sendRequest);
    });
    act(() => result.current.cancel());
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      followup.resolve();
      await sending;
    });
  }
  act(() => result.current.cancel());
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it.each(["success", "refusal", "shell"] as const)(
  "ignores a %s arriving after the step unmounted",
  async (kind) => {
    const request = deferred<Answer>();
    const onDone = vi.fn(async () => undefined);
    const onShell = vi.fn();
    const onRefused = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSend({ answer: z.literal(true), refusals, onShell, onDone, onRefused }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send(() => request.promise);
    });
    unmount();
    request.resolve(
      kind === "success"
        ? done()
        : { response: new Response(null, { status: kind === "shell" ? 403 : 500 }) },
    );
    await sending;
    expect(onDone).not.toHaveBeenCalled();
    expect(onShell).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  },
);

it("a request that throws before returning a promise releases the step for retry", async () => {
  const onCancel = vi.fn();
  const { result } = renderHook(() =>
    useSend({ answer: z.literal(true), refusals, onShell: vi.fn(), onDone: vi.fn(), onCancel }),
  );
  await act(async () =>
    result.current.send(() => {
      throw new Error("offline");
    }),
  );
  expect(result.current.sending).toBe(false);
  expect(result.current.refused).toBe("admin.sanction.error.failed");
  act(() => result.current.cancel());
  expect(onCancel).toHaveBeenCalledTimes(1);
});
