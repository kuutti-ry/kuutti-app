import { act, fireEvent, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { saveSession } from "@/lib/session";
import { renderWithTheme, underProviders } from "@/test/render";
import { PhotoImage } from "./PhotoImage";

// One photo (rules/mobile.md Images): its variant's signed URL fetched on
// mount, cached under photoId/variant and never the URL, the blurhash meanwhile,
// one more fetch if the image fails to load, and a refusal handed to the screen.

const ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signed = (n: number) =>
  json({
    url: `https://media.test/media/k/thumb.webp?Signature=${n}`,
    variant: "thumb",
    expiresAt: "2030-01-01T00:15:00.000Z",
  });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

function answering(...answers: Array<() => Response>) {
  const seen: string[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(input);
    seen.push(new URL(request.url).pathname);
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (!answer) throw new Error("no answer prepared");
    return answer();
  }) as unknown as typeof fetch;
  return seen;
}

const image = () => screen.getByLabelText("Photo 1 of 2");
const sourceOf = () => (image().props.source as Array<{ uri: string; cacheKey: string }>)[0];

async function show(onRefused?: (code: string | undefined) => void) {
  await renderWithTheme(
    <PhotoImage
      id={ID}
      variant="thumb"
      blurhash={BLURHASH}
      accessibilityLabel="Photo 1 of 2"
      onRefused={onRefused}
    />,
  );
  await settle();
}

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("PhotoImage", () => {
  it("shows its variant under the photoId/variant cache key, the blurhash meanwhile, as a labelled image", async () => {
    const seen = answering(() => signed(1));
    await show();
    expect(seen).toEqual([`/photos/${ID}/thumb`]);
    expect(sourceOf()).toEqual({
      uri: "https://media.test/media/k/thumb.webp?Signature=1",
      cacheKey: `${ID}/thumb`,
    });
    expect(JSON.stringify(image().props.placeholder)).toContain(BLURHASH);
    expect(image().props.accessibilityRole).toBe("image");
    expect(image().props.transition).toMatchObject({ duration: 200 });
  });

  it("fetches a fresh URL once when the image fails to load, and not again", async () => {
    const seen = answering(
      () => signed(1),
      () => signed(2),
    );
    await show();
    await fireEvent(image(), "error", { nativeEvent: { error: "expired" } });
    await settle();
    expect(sourceOf()?.uri).toMatch(/Signature=2$/);
    await fireEvent(image(), "error", { nativeEvent: { error: "expired" } });
    await settle();
    expect(seen).toHaveLength(2);
  });

  it("keeps the blurhash and hands the API's refusal to the screen", async () => {
    answering(() =>
      json({ error: { code: "photo_budget_exceeded", message: "x", requestId: "r" } }, 429),
    );
    const refused = jest.fn();
    await show(refused);
    expect(refused).toHaveBeenCalledWith("photo_budget_exceeded");
    expect(image().props.source).toEqual([]);
  });

  it("keeps the blurhash and tells the screen nothing when the network fails", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    const refused = jest.fn();
    await show(refused);
    expect(refused).not.toHaveBeenCalled();
    expect(image().props.source).toEqual([]);
  });

  it("does not fetch again when the screen re-renders it with a new handler", async () => {
    const seen = answering(() => signed(1));
    const view = await renderWithTheme(
      <PhotoImage id={ID} variant="thumb" blurhash={BLURHASH} accessibilityLabel="Photo 1 of 2" />,
    );
    await settle();
    await view.rerender(
      underProviders(
        <PhotoImage
          id={ID}
          variant="thumb"
          blurhash={BLURHASH}
          accessibilityLabel="Photo 1 of 2"
          onRefused={() => undefined}
        />,
      ),
    );
    await settle();
    expect(seen).toHaveLength(1);
  });

  it("appears at once under reduce motion", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    answering(() => signed(1));
    await show();
    expect(image().props.transition).toMatchObject({ duration: 0 });
  });
});
