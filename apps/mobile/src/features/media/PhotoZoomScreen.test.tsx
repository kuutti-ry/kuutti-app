import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { PhotoZoomScreen } from "./PhotoZoomScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";

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

describe("PhotoZoomScreen", () => {
  it("is the one place that asks for the full variant, and goes back with a labelled button", async () => {
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

  it("says the generic line for a refusal it has no words of its own for, and nothing before", async () => {
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
    expect(screen.queryByText("The photo could not be uploaded. Try again.")).toBeNull();
    // A gateway's page, not the API's envelope: a refusal without a code.
    await act(async () => {
      answer?.(new Response("<html>Bad gateway</html>", { status: 502 }));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByText("The photo could not be uploaded. Try again.")).toBeTruthy();
    expect(
      screen.queryByText("That is enough photos for today. They load again after midnight."),
    ).toBeNull();
  });
});
