import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { PhotoZoomScreen } from "./PhotoZoomScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(async () => {
  router.back.mockReset();
  store.delete("kuutti.preference.photoDescriptions");
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("PhotoZoomScreen", () => {
  it("asks for the full variant of one's own photo, and goes back with a labelled button", async () => {
    const calls: Request[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      calls.push(req);
      return new Response(
        JSON.stringify({
          url: "https://media.test/media/k/full.webp?Signature=s",
          variant: "full",
          expiresAt: "2030-01-01T00:15:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await act(async () => {
      renderWithTheme(
        <PhotoZoomScreen id={ID} blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj" position={2} total={3} />,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(new URL(calls[0]?.url ?? "").pathname).toBe(`/photos/${ID}/full`);
    expect(screen.getByLabelText("Photo 2 / 3, full size")).toBeTruthy();

    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await fireEvent.press(screen.getByRole("button", { name: "Back to your photos" }));
    expect(router.back).toHaveBeenCalled();
  });

  it("reads the owner's caption with the photo when it has one (#296)", async () => {
    globalThis.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: "https://media.test/media/k/full.webp?Signature=s",
            variant: "full",
            expiresAt: "2030-01-01T00:15:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    await act(async () => {
      renderWithTheme(
        <PhotoZoomScreen
          id={ID}
          blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj"
          position={1}
          total={2}
          caption="travelling"
        />,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByLabelText("Photo 1 / 2, full size. Travelling")).toBeTruthy();
  });

  it("reads the check's description after the caption, and shows it under the photo when the setting asks (#296)", async () => {
    globalThis.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: "https://media.test/media/k/full.webp?Signature=s",
            variant: "full",
            expiresAt: "2030-01-01T00:15:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
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
    const words =
      "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.";
    const zoom = (
      <PhotoZoomScreen
        id={ID}
        blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj"
        position={1}
        total={2}
        caption="travelling"
        description={description}
      />
    );
    await act(async () => {
      renderWithTheme(zoom);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByLabelText(`Photo 1 / 2, full size. Travelling. ${words}`)).toBeTruthy();
    // Not under the photo until the setting asks.
    expect(screen.queryByText(words, { includeHiddenElements: true })).toBeNull();

    store.set("kuutti.preference.photoDescriptions", JSON.stringify({ shown: true, face: false }));
    await act(async () => {
      renderWithTheme(zoom);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    // The face part off: neither spoken nor shown; the text is there for the eye and not an element of its own.
    const without = "Automatic description: One person, outdoors, by a lake. Hiking, with a dog.";
    expect(
      await screen.findByLabelText(`Photo 1 / 2, full size. Travelling. ${without}`),
    ).toBeTruthy();
    expect(screen.getByText(without, { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText(without)).toBeNull();
  });

  it("says so when the API refused the URL for the day's budget (#52)", async () => {
    globalThis.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "photo_budget_exceeded", message: "later", requestId: "r1" },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "3600" } },
        ),
    ) as unknown as typeof fetch;

    await act(async () => {
      renderWithTheme(
        <PhotoZoomScreen id={ID} blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj" position={1} total={1} />,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    await waitFor(() =>
      expect(
        screen.getByText("That is enough photos for today. They load again after midnight."),
      ).toBeTruthy(),
    );
  });

  it("says the photo could not be shown for a refusal it has no words of its own for, and nothing before (#235)", async () => {
    let answer: ((response: Response) => void) | undefined;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ) as unknown as typeof fetch;
    await act(async () => {
      renderWithTheme(
        <PhotoZoomScreen id={ID} blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj" position={1} total={1} />,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByText("The photo could not be shown.")).toBeNull();
    // A gateway's page, not the API's envelope: a refusal without a code.
    await act(async () => {
      answer?.(new Response("<html>Bad gateway</html>", { status: 502 }));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    // The person was looking at the photo, not uploading it.
    expect(screen.getByText("The photo could not be shown.")).toBeTruthy();
    expect(screen.queryByText(/uploaded/)).toBeNull();
    expect(
      screen.queryByText("That is enough photos for today. They load again after midnight."),
    ).toBeNull();
  });
});
