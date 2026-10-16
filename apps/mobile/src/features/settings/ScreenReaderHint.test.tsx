import * as Sentry from "@sentry/react-native";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo } from "react-native";
import { api } from "@/lib/api";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ScreenReaderHint } from "./ScreenReaderHint";

// The one-time hint for a screen-reader user (#296 part 3): shown on the
// first launch with a screen reader active, once; and the screen-reader state
// stays on the device, never in a request, a report or a stored value that
// says what it is.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const SEEN = "kuutti.preference.photoDescriptionsHintSeen";
const { __router: router } = jest.requireMock("expo-router") as { __router: { push: jest.Mock } };
const BODY = /^It seems you use a screen reader/;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

/** The phone's screen reader, on or off at start, and switched while the app runs. */
function screenReader(initial: boolean) {
  const listeners = new Set<(enabled: boolean) => void>();
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(initial);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation((event: string, handler) => {
    const listener = handler as unknown as (enabled: boolean) => void;
    if (event === "screenReaderChanged") listeners.add(listener);
    return { remove: () => listeners.delete(listener) } as never;
  });
  return {
    change: async (enabled: boolean) => {
      await act(async () => {
        for (const listener of listeners) listener(enabled);
      });
    },
  };
}

beforeEach(() => {
  store.clear();
  router.push.mockReset();
  (Sentry.captureException as jest.Mock).mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe("the screen-reader hint", () => {
  it("shows nothing without a screen reader", async () => {
    screenReader(false);
    await renderWithTheme(<ScreenReaderHint />);
    await settle();
    expect(screen.queryByText(BODY)).toBeNull();
    expect(store.has(SEEN)).toBe(false);
  });

  it("says, once, that photos are read with a description and where the setting is, with every control labelled", async () => {
    screenReader(true);
    await renderWithTheme(<ScreenReaderHint />);
    expect(await screen.findByText(BODY)).toBeTruthy();
    expect(screen.getByText("Photo descriptions")).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Got it" }));
    await settle();
    expect(screen.queryByText(BODY)).toBeNull();
    await waitFor(() => expect(store.get(SEEN)).toBe("true"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("opens the setting from its first button, and is not shown again on the next launch", async () => {
    const reader = screenReader(true);
    await renderWithTheme(<ScreenReaderHint />);
    await fireEvent.press(await screen.findByRole("button", { name: "Open the setting" }));
    expect(router.push).toHaveBeenCalledWith("/settings/photo-descriptions");
    await waitFor(() => expect(store.get(SEEN)).toBe("true"));
    // The screen reader switched off and on again this launch: nothing more.
    await reader.change(false);
    await reader.change(true);
    expect(screen.queryByText(BODY)).toBeNull();
    // The next launch, with the reader on.
    await renderWithTheme(<ScreenReaderHint />);
    await settle();
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("appears when the screen reader is switched on while the app runs, and closes for good from its close control", async () => {
    const reader = screenReader(false);
    await renderWithTheme(<ScreenReaderHint />);
    await settle();
    expect(screen.queryByText(BODY)).toBeNull();
    await reader.change(true);
    expect(await screen.findByText(BODY)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await settle();
    expect(screen.queryByText(BODY)).toBeNull();
    await waitFor(() => expect(store.get(SEEN)).toBe("true"));
  });

  it("speaks Finnish and Swedish", async () => {
    screenReader(true);
    store.set("kuutti.preference.locale", "fi");
    await renderWithTheme(<ScreenReaderHint />);
    expect(await screen.findByText(/^Näytät käyttävän ruudunlukijaa/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Avaa asetus" })).toBeTruthy();
    store.set("kuutti.preference.locale", "sv");
    await renderWithTheme(<ScreenReaderHint />);
    expect(await screen.findByText(/^Det verkar som att du använder en skärmläsare/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Uppfattat" })).toBeTruthy();
  });

  it("keeps the screen-reader state on the device: no request carries it, no report, and the device holds only that the hint was seen", async () => {
    screenReader(true);
    const calls: Request[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request.clone());
      return new Response(JSON.stringify({ photos: [], maxPhotos: 6, tips: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await saveSession({
      sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      accessToken: `access${"x".repeat(37)}`,
      accessExpiresAt: "2030-01-01T00:15:00.000Z",
      refreshToken: `refresh${"x".repeat(36)}`,
      refreshExpiresAt: "2030-04-01T00:00:00.000Z",
    });
    await renderWithTheme(<ScreenReaderHint />);
    await fireEvent.press(await screen.findByRole("button", { name: "Got it" }));
    await waitFor(() => expect(store.get(SEEN)).toBe("true"));
    // The hint itself sends nothing; a request after it, through the typed
    // client, carries the session and nothing about the screen reader.
    expect(calls).toHaveLength(0);
    await api.GET("/photos");
    expect(calls).toHaveLength(1);
    for (const request of calls) {
      const wire = [
        request.url,
        JSON.stringify([...request.headers.entries()]),
        await request.text(),
      ].join("\n");
      expect(wire).not.toMatch(/screen|reader|voiceover|talkback|accessib|a11y|hint/i);
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
    // What the device holds says only that the hint was seen, not why.
    const held = [...store.entries()].filter(([key]) => !key.includes("session"));
    expect(held).toEqual([[SEEN, "true"]]);
    expect(SEEN).not.toMatch(/screen|reader/i);
  });
});
