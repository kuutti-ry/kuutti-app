import type { ChatMessage } from "@kuutti/schema";
import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ChatPhotoScreen } from "./ChatPhotoScreen";

// A conversation's photo full size (#350): read again by its place, the full
// size contained with its label, the description under it when the setting
// asks, back with one button; gone, failed with Try again, read once more
// when the URL expired.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock };
};
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

const CONVERSATION = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const MESSAGE = "00000000-0000-4000-8000-000000000004";
const PHOTO_ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const urls = (n: number) => ({
  thumb: `https://media.test/${n}/thumb.webp?sig=s`,
  full: `https://media.test/${n}/full.webp?sig=s`,
  expiresAt: "2030-01-01T00:15:00.000Z",
});
const description = {
  people: 1,
  setting: "outdoors" as const,
  scene: ["lake" as const],
  objects: ["hiking" as const, "dog" as const],
  smile: true,
  glasses: false,
  sunglasses: true,
  facialHair: false,
};
const WORDS =
  "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.";
const photoMessage = (over: Partial<ChatMessage> = {}, n = 1): ChatMessage => ({
  id: MESSAGE,
  seq: 4,
  side: "theirs",
  kind: "photo",
  body: "Mökillä",
  createdAt: "2026-10-17T11:03:00.000Z",
  clientId: null,
  photo: {
    photoId: PHOTO_ID,
    blurhash: BLURHASH,
    width: 1600,
    height: 1067,
    description: null,
    urls: urls(n),
  },
  ...over,
});

/** The API's answers in turn, the last one repeated; every query recorded. */
function api(...answers: Array<() => Response | Promise<Response>>): string[] {
  const asked: string[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    asked.push(`${url.pathname}${url.search}`);
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (!answer) throw new Error("no answer");
    return answer();
  }) as unknown as typeof fetch;
  return asked;
}
const props = { messageId: MESSAGE, conversation: CONVERSATION, seq: 4, blurhash: BLURHASH };
/** The full size's host view: what expo-image was handed. */
const full = () =>
  screen.getByTestId("photo-full").props as {
    source?: Array<{ uri?: string; cacheKey?: string }>;
    contentFit?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  };

beforeEach(async () => {
  store.clear();
  router.back.mockReset();
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("a conversation's photo full size", () => {
  it("reads the message by its place, shows the full size whole with the caption in its label, and goes back with a labelled button", async () => {
    let answer: (response: Response) => void = () => undefined;
    const asked = api(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(screen.getByText("Loading the photo…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByRole("heading", { name: "Photo" })).toBeTruthy();
    await act(async () => answer(json({ messages: [photoMessage()] })));
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
    expect(asked).toEqual([`/conversations/${CONVERSATION}/messages?before=5&limit=1`]);
    expect(full().source?.[0]?.cacheKey).toBe(`${PHOTO_ID}/full`);
    expect(full().contentFit).toBe("contain");
    expect(full().accessibilityRole).toBe("image");
    expect(screen.getByLabelText("Photo, full size. Mökillä")).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await userEvent.setup().press(screen.getByRole("button", { name: "Back to the conversation" }));
    expect(router.back).toHaveBeenCalled();
  });

  it("reads the check's description after the label, and shows it under the photo when the setting asks (#296)", async () => {
    const withDescription = photoMessage({
      body: null,
      photo: { ...(photoMessage().photo as NonNullable<ChatMessage["photo"]>), description },
    });
    api(() => json({ messages: [withDescription] }));
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(await screen.findByLabelText(`Photo, full size. ${WORDS}`)).toBeTruthy();
    expect(screen.queryByText(WORDS, { includeHiddenElements: true })).toBeNull();

    store.set("kuutti.preference.photoDescriptions", JSON.stringify({ shown: true }));
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    await waitFor(() =>
      expect(screen.getByText(WORDS, { includeHiddenElements: true })).toBeTruthy(),
    );
    // For the eye: the label says it already.
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  it.each([
    [
      "another message at its place",
      () => json({ messages: [photoMessage({ id: "00000000-0000-4000-8000-000000000005" })] }),
    ],
    ["no message at its place", () => json({ messages: [] })],
    [
      "a photo that went with its sender",
      () => json({ messages: [photoMessage({ photo: null })] }),
    ],
    ["a conversation that is not the person's", () => refusal("not_found", 404)],
    ["a link the API cannot read", () => refusal("validation_failed", 400)],
  ])("says the photo is no longer there for %s", async (_what, answer) => {
    api(answer);
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(
      (await screen.findByText("This photo is no longer available.")).props.accessibilityLiveRegion,
    ).toBe("polite");
    expect(screen.queryByTestId("photo-full")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to the conversation" })).toBeTruthy();
  });

  it.each([
    ["no sequence", { seq: 0 }],
    ["no conversation", { conversation: "" }],
    ["no message", { messageId: "" }],
  ])("asks nothing for a link with %s", async (_what, over) => {
    const asked = api(() => json({ messages: [photoMessage()] }));
    await renderWithTheme(<ChatPhotoScreen {...props} {...over} blurhash="" />);
    expect(await screen.findByText("This photo is no longer available.")).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("offers Try again when the photo did not load", async () => {
    api(
      () => refusal("internal_error", 500),
      () => json({ messages: [photoMessage()] }),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(await screen.findByText("The photo could not be loaded.")).toBeTruthy();
    await userEvent.setup().press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
  });

  it("reads the message once more when the full size's URL has expired, and only once", async () => {
    const asked = api(
      () => json({ messages: [photoMessage()] }),
      () => json({ messages: [photoMessage({}, 2)] }),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
    const expire = async () => {
      await act(async () => {
        fireEvent(screen.getByTestId("photo-full"), "error", { nativeEvent: { error: "expired" } });
      });
      await settle();
    };
    await expire();
    expect(full().source?.[0]?.uri).toBe(urls(2).full);
    await expire();
    expect(asked).toHaveLength(2);
  });
});
