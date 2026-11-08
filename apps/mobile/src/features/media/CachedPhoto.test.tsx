import { act, screen } from "@testing-library/react-native";
import { Image, type ImageRef } from "expo-image";
import { renderWithTheme, underProviders } from "@/test/render";
import { CachedPhoto } from "./CachedPhoto";

// A photo already painted, again, from the phone's image cache alone (#476):
// read under photoId/variant, never signed or fetched (ADR-008), the blurhash
// where the cache has none or its read fails, silent to a screen reader, and
// never another key's picture.

const ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
/** A picture the cache hands back; the app passes it to the image as it is. */
const pictureOf = (key: string) => ({ cached: key }) as unknown as ImageRef;

/** expo-image's host view: hidden from the accessibility tree, so found with the hidden ones. */
const host = () => screen.getByTestId(`cached-${ID}`, { includeHiddenElements: true });
const shown = () => (host().props.source as unknown[])[0];

beforeEach(() => {
  globalThis.fetch = jest.fn(async () => {
    throw new Error("nothing is fetched");
  }) as unknown as typeof fetch;
});
afterEach(() => jest.restoreAllMocks());

describe("CachedPhoto", () => {
  it("shows the photo from the phone's cache under its photoId/variant, silent, and asks the API for nothing", async () => {
    const picture = pictureOf(`${ID}/card`);
    const read = jest.spyOn(Image, "readFromCacheAsync").mockResolvedValue(picture);
    await renderWithTheme(<CachedPhoto id={ID} variant="card" blurhash={BLURHASH} />);
    await settle();
    expect(read).toHaveBeenCalledWith(`${ID}/card`);
    expect(shown()).toBe(picture);
    expect(JSON.stringify(host().props.placeholder)).toContain(BLURHASH);
    expect(host().props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["has none", () => Promise.resolve(null)],
    ["cannot be read", () => Promise.reject(new Error("the activity is gone"))],
  ])("keeps the blurhash where the cache %s", async (_, answer) => {
    jest.spyOn(Image, "readFromCacheAsync").mockImplementation(answer);
    await renderWithTheme(<CachedPhoto id={ID} variant="thumb" blurhash={BLURHASH} />);
    await settle();
    expect(shown()).toBeUndefined();
    expect(JSON.stringify(host().props.placeholder)).toContain(BLURHASH);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("never shows a picture the cache answered for a key the photo no longer has", async () => {
    const answers = new Map<string, (picture: ImageRef | null) => void>();
    jest.spyOn(Image, "readFromCacheAsync").mockImplementation(
      (key) =>
        new Promise<ImageRef | null>((resolve) => {
          answers.set(key, resolve);
        }),
    );
    const ui = (variant: "card" | "thumb") => (
      <CachedPhoto id={ID} variant={variant} blurhash={BLURHASH} />
    );
    await renderWithTheme(ui("card"));
    await act(async () => answers.get(`${ID}/card`)?.(pictureOf(`${ID}/card`)));
    expect(shown()).toEqual(pictureOf(`${ID}/card`));
    // Another variant: the card's picture goes at once, the blurhash until the thumb's read lands.
    await screen.rerender(underProviders(ui("thumb")));
    expect(shown()).toBeUndefined();
    await screen.rerender(underProviders(ui("card")));
    // The thumb's read lands after the card's second one was asked: it shows nothing.
    await act(async () => answers.get(`${ID}/thumb`)?.(pictureOf(`${ID}/thumb`)));
    expect(shown()).toEqual(pictureOf(`${ID}/card`));
    await act(async () => answers.get(`${ID}/card`)?.(null));
    expect(shown()).toBeUndefined();
  });
});
