import { act, renderHook } from "@testing-library/react-native";
import { clearSession, saveSession } from "@/lib/session";
import { useRefusedDraft, useSaveOnLeave } from "./useSaveOnLeave";

// A screen with no Save button (#227, #238): leaving saves once, is never held
// up, and a refusal brings the screen back with its draft. The sections' and
// What you seek's way out (#542).

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);

const { __navigation: navigation, __router: router } = jest.requireMock("expo-router") as {
  __navigation: { emit: (name: string, event: unknown) => void };
  __router: { push: jest.Mock; back: jest.Mock };
};

/** The back gesture, the back button or Android's back key, as the stack reports it. */
const leave = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};

type Draft = { bio: string };
type Save = () => Promise<Draft | null> | null;
const PATH = "/profile/section/basics";

/** The hook as a screen holds it; `rerender({ save })` is that screen's next render. */
const screenAt = (name: string, save: Save, held = false) =>
  renderHook(
    (props: { save: Save }) => useSaveOnLeave({ screen: name, path: PATH, held, ...props }),
    {
      initialProps: { save },
    },
  );

/** A save that goes, kept in `sent`, and answers `refused` or nothing to bring back. */
const sending =
  (sent: string[], what: string, refused: Draft | null = null) =>
  () => {
    sent.push(what);
    return Promise.resolve(refused);
  };

/** The draft a screen opened now would take up, and take away from the next. */
const openedAgain = (name: string) => renderHook(() => useRefusedDraft<Draft>(name));

beforeEach(async () => {
  router.push.mockClear();
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("useRefusedDraft", () => {
  it("has nothing for a screen with nothing refused", async () => {
    const { result } = await openedAgain("never refused");
    expect(result.current).toBeUndefined();
  });

  it("reads a refused draft once: the next mount gets nothing", async () => {
    await screenAt("once", sending([], "bio", { bio: "aino@example.com" }));
    await leave();
    const first = await openedAgain("once");
    expect(first.result.current).toEqual({ bio: "aino@example.com" });
    const second = await openedAgain("once");
    expect(second.result.current).toBeUndefined();
    // The screen that took it keeps it through its own renders.
    await first.rerender(undefined);
    expect(first.result.current).toEqual({ bio: "aino@example.com" });
  });

  it("keeps a draft to its own screen, so that neither undoes the other", async () => {
    await screenAt("left", sending([], "left", { bio: "left" }));
    await screenAt("right", sending([], "right", { bio: "right" }));
    await leave();
    expect((await openedAgain("right")).result.current).toEqual({ bio: "right" });
    expect((await openedAgain("left")).result.current).toEqual({ bio: "left" });
  });
});

describe("useSaveOnLeave", () => {
  it("saves once however many times the stack reports the leaving", async () => {
    const sent: string[] = [];
    await screenAt("twice", sending(sent, "bio"));
    await leave();
    await leave();
    await leave();
    expect(sent).toEqual(["bio"]);
  });

  it("never holds the leaving up: held, the native swipe on iOS bounced (#238)", async () => {
    await screenAt("swipe", sending([], "bio"));
    const event = await leave();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("saves what the latest render holds, not the first", async () => {
    const sent: string[] = [];
    const { rerender } = await screenAt("latest", sending(sent, "first"));
    await rerender({ save: sending(sent, "second") });
    await leave();
    expect(sent).toEqual(["second"]);
  });

  it("leaves it free to save later when save() answered null: there was nothing yet", async () => {
    const sent: string[] = [];
    const { rerender } = await screenAt("nothing yet", () => null);
    await leave();
    expect(sent).toEqual([]);
    await rerender({ save: sending(sent, "bio") });
    await leave();
    expect(sent).toEqual(["bio"]);
  });

  it("opens nothing again when the save is taken", async () => {
    await screenAt("taken", sending([], "bio"));
    await leave();
    expect(router.push).not.toHaveBeenCalled();
    expect((await openedAgain("taken")).result.current).toBeUndefined();
  });

  it("stores a refused draft and pushes its screen's path, once", async () => {
    await screenAt("refused", sending([], "bio", { bio: "aino@example.com" }));
    await leave();
    await leave();
    expect(router.push.mock.calls).toEqual([[PATH]]);
    expect((await openedAgain("refused")).result.current).toEqual({ bio: "aino@example.com" });
  });

  it("brings a refused screen back after it has gone: the save outlives it", async () => {
    let refuse: ((draft: Draft) => void) | undefined;
    const { unmount } = await screenAt(
      "gone",
      () =>
        new Promise<Draft>((resolve) => {
          refuse = resolve;
        }),
    );
    await leave();
    await unmount();
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => {
      refuse?.({ bio: "aino@example.com" });
      await settle();
    });
    expect(router.push).toHaveBeenCalledWith(PATH);
    expect((await openedAgain("gone")).result.current).toEqual({ bio: "aino@example.com" });
  });

  it("pushes nothing and holds nothing when the session ended on the way", async () => {
    let refuse: ((draft: Draft) => void) | undefined;
    await screenAt(
      "signed out",
      () =>
        new Promise<Draft>((resolve) => {
          refuse = resolve;
        }),
    );
    await leave();
    await act(async () => {
      await clearSession();
      refuse?.({ bio: "aino@example.com" });
      await settle();
    });
    expect(router.push).not.toHaveBeenCalled();
    expect((await openedAgain("signed out")).result.current).toBeUndefined();
  });

  it("stops listening when its screen is gone", async () => {
    const sent: string[] = [];
    const { unmount } = await screenAt("unmounted", sending(sent, "bio"));
    await unmount();
    await leave();
    expect(sent).toEqual([]);
  });

  it("asks only on a screen opened again for a refused draft", async () => {
    const plain = await screenAt("plain", () => null);
    expect(plain.result.current.asking).toBe(false);
    const held = await screenAt("held", () => null, true);
    expect(held.result.current.asking).toBe(true);
  });

  it("closes the question on keep, staying here and free to save on the way out", async () => {
    const sent: string[] = [];
    const { result } = await screenAt("keep", sending(sent, "bio"), true);
    await act(async () => result.current.keep());
    expect(result.current.asking).toBe(false);
    expect(router.back).not.toHaveBeenCalled();
    await leave();
    expect(sent).toEqual(["bio"]);
  });

  it("goes back on leave and lets the draft go: the way out saves nothing", async () => {
    const sent: string[] = [];
    const { result } = await screenAt("leave", sending(sent, "bio"), true);
    await act(async () => result.current.leave());
    expect(result.current.asking).toBe(false);
    expect(router.back).toHaveBeenCalledTimes(1);
    await leave();
    expect(sent).toEqual([]);
  });
});
