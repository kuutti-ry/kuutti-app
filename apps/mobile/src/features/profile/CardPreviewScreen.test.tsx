import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { CardPreviewScreen } from "./CardPreviewScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PHOTO_A = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const PHOTO_B = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02";

const card = {
  accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  displayName: "Aino",
  age: { years: 36, verifiedByBank: true },
  pond: {
    id: "5f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a00",
    slug: "espoo",
    name: "Espoo",
    nameInessive: "Espoossa",
    parentId: null,
  },
  photos: [
    { id: PHOTO_A, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", width: 1200, height: 1600 },
    { id: PHOTO_B, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", width: 1200, height: 1600 },
  ],
  fields: { languages: ["fi", "en"], intent: "long_term", campus: "Otaniemi" },
  bio: null,
  bioPreset: "photos_speak",
  prompts: [{ key: "sunday", answer: "A long breakfast." }],
};

beforeEach(async () => {
  router.back.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("CardPreviewScreen", () => {
  it("shows the card as others see it: the verified age, the photos through the photo route, the choices in words", async () => {
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === "/profile/card") {
        return json({
          card,
          completeness: { complete: false, missing: ["seeks", "age_window"] },
          tip: null,
        });
      }
      if (path.startsWith("/photos/")) {
        const variant = path.split("/").pop();
        return json({
          url: `https://media.test/media/k/${variant}.webp?Signature=s`,
          variant,
          expiresAt: "2030-01-01T00:15:00.000Z",
        });
      }
      return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
    }) as unknown as typeof fetch;

    await act(async () => {
      renderWithTheme(<CardPreviewScreen />);
      await settle();
    });
    await waitFor(() => expect(screen.getByText("Aino")).toBeTruthy());
    expect(screen.getByText("36, age verified by your bank")).toBeTruthy();
    expect(screen.getByText("Espoo")).toBeTruthy();
    expect(screen.getByText("Finnish, English")).toBeTruthy();
    expect(screen.getByText("Something long-term")).toBeTruthy();
    expect(screen.getByText("Otaniemi")).toBeTruthy();
    expect(screen.getByText("The photos say it. The rest over coffee.")).toBeTruthy();
    expect(screen.getByText("A long breakfast.")).toBeTruthy();
    expect(screen.getByText("Whom you are looking for (set in onboarding)")).toBeTruthy();
    await waitFor(() => expect(calls).toContain(`/photos/${PHOTO_A}/card`));
    expect(calls).toContain(`/photos/${PHOTO_B}/thumb`);
    expect(calls.filter((p) => p.endsWith("/full"))).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Back to your profile" }));
      await settle();
    });
    expect(router.back).toHaveBeenCalled();
  });

  it("asks for the profile first when there is no card yet", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({
        card: null,
        completeness: { complete: false, missing: ["display_name"] },
        tip: null,
      }),
    ) as unknown as typeof fetch;
    await act(async () => {
      renderWithTheme(<CardPreviewScreen />);
      await settle();
    });
    await waitFor(() => expect(screen.getByText(/Save your profile first/)).toBeTruthy());
  });
});
