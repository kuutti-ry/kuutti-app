import type { PhotoUrlResponse } from "@kuutti/schema";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Image, type ImageRef } from "expo-image";
import { ApiError } from "@/lib/api";
import { attack } from "@/test/attack";
import { deferred } from "@/test/deferred";
import { renderWithTheme, underProviders } from "@/test/render";
import { CachedPhoto } from "./CachedPhoto";
import { fetchPhotoUrl } from "./client";
import { PhotoImage } from "./PhotoImage";

jest.mock("./client", () => ({ fetchPhotoUrl: jest.fn() }));
const fetchUrl = jest.mocked(fetchPhotoUrl);
const A = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const B = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02";
const BLUR = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const signed = (id: string): PhotoUrlResponse => ({
  url: `https://media.test/${id}/card.webp`,
  variant: "card",
  expiresAt: "2030-01-01T00:15:00.000Z",
});
const photo = (id: string, onRefused?: (code: string | undefined) => void) => (
  <PhotoImage
    id={id}
    variant="card"
    blurhash={BLUR}
    accessibilityLabel="Current photo"
    onRefused={onRefused}
  />
);
const image = () => screen.getByLabelText("Current photo");
const uri = () => (image().props.source as { uri: string }[])[0]?.uri;
const flush = () => act(async () => undefined);

beforeEach(() => {
  fetchUrl.mockReset();
});
afterEach(() => jest.restoreAllMocks());

async function responseAfterSwitch(replace: boolean) {
  const old = deferred<PhotoUrlResponse>();
  const current = deferred<PhotoUrlResponse>();
  fetchUrl.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await renderWithTheme(photo(A));
  expect(fetchUrl).toHaveBeenCalledWith(A, "card");
  if (replace) {
    await screen.rerender(underProviders(photo(B)));
    expect(fetchUrl).toHaveBeenCalledWith(B, "card");
    await act(async () => current.resolve(signed(B)));
    expect(uri()).toBe(signed(B).url);
  }
  await act(async () => old.resolve(signed(A)));
  return uri();
}
attack(
  "mobile photos: an old signed URL answered last is painted under the replacement photo's identity",
  {
    attempt: () => responseAfterSwitch(true),
    control: () => responseAfterSwitch(false),
    succeeds: (seen) => expect(seen).toBe(signed(A).url),
  },
);

async function waitingAfterSwitch(replace: boolean) {
  fetchUrl
    .mockResolvedValueOnce(signed(A))
    .mockReturnValueOnce(deferred<PhotoUrlResponse>().promise);
  await renderWithTheme(photo(A));
  await flush();
  expect(uri()).toBe(signed(A).url);
  if (replace) await screen.rerender(underProviders(photo(B)));
  return uri();
}
attack(
  "mobile photos: the previous photo's image remains while the replacement photo's URL waits",
  {
    attempt: () => waitingAfterSwitch(true),
    control: () => waitingAfterSwitch(false),
    succeeds: (seen) => expect(seen).toBe(signed(A).url),
  },
);

async function refusalAfterSwitch(replace: boolean) {
  const old = deferred<PhotoUrlResponse>();
  const refused = jest.fn();
  fetchUrl.mockReturnValueOnce(old.promise).mockResolvedValueOnce(signed(B));
  await renderWithTheme(photo(A, replace ? jest.fn() : refused));
  if (replace) {
    await screen.rerender(underProviders(photo(B, refused)));
    await flush();
    expect(uri()).toBe(signed(B).url);
  }
  await act(async () => old.reject(new ApiError("refused old photo", 403, "not_found")));
  return refused.mock.calls.length;
}
attack("mobile photos: a previous photo's refusal is delivered to the replacement photo's owner", {
  attempt: () => refusalAfterSwitch(true),
  control: () => refusalAfterSwitch(false),
  succeeds: (calls) => expect(calls).toBeGreaterThan(0),
});

async function repeatedImageErrors(replace: boolean) {
  fetchUrl.mockImplementation(async (id) => signed(id));
  await renderWithTheme(photo(A));
  await flush();
  await fireEvent(image(), "error", { nativeEvent: { error: "expired" } });
  await flush();
  expect(fetchUrl).toHaveBeenCalledTimes(2);
  if (replace) {
    await screen.rerender(underProviders(photo(B)));
    await flush();
  }
  await fireEvent(image(), "error", { nativeEvent: { error: "expired again" } });
  await flush();
  return fetchUrl.mock.calls.length;
}
attack("mobile photos: repeated image errors spend more than one retry on the same photo", {
  attempt: () => repeatedImageErrors(false),
  control: () => repeatedImageErrors(true),
  succeeds: (calls) => expect(calls).toBeGreaterThan(2),
});

async function cacheMiss(live: boolean) {
  jest.spyOn(Image, "readFromCacheAsync").mockResolvedValue(null);
  fetchUrl.mockResolvedValue(signed(A));
  await renderWithTheme(live ? photo(A) : <CachedPhoto id={A} variant="card" blurhash={BLUR} />);
  await flush();
  return fetchUrl.mock.calls.length;
}
attack("mobile photos: a decorative cache miss asks for a new signed URL and spends exposure", {
  attempt: () => cacheMiss(false),
  control: () => cacheMiss(true),
  succeeds: (calls) => expect(calls).toBeGreaterThan(0),
});

async function cacheAfterSwitch(replace: boolean) {
  const old = deferred<ImageRef | null>();
  const a = { cached: A } as unknown as ImageRef;
  const b = { cached: B } as unknown as ImageRef;
  jest.spyOn(Image, "readFromCacheAsync").mockReturnValueOnce(old.promise).mockResolvedValueOnce(b);
  const cached = (id: string) => <CachedPhoto id={id} variant="card" blurhash={BLUR} />;
  await renderWithTheme(cached(A));
  if (replace) {
    await screen.rerender(underProviders(cached(B)));
    await flush();
  }
  await act(async () => old.resolve(a));
  const host = screen.getByTestId(`cached-${replace ? B : A}`, { includeHiddenElements: true });
  return (host.props.source as unknown[])[0] === a;
}
attack("mobile photos: an old cache read paints the previous photo's image after the key changes", {
  attempt: () => cacheAfterSwitch(true),
  control: () => cacheAfterSwitch(false),
  succeeds: (oldShown) => expect(oldShown).toBe(true),
});

it("a photo URL refused after unmount does not notify its departed screen", async () => {
  const request = deferred<PhotoUrlResponse>();
  const refused = jest.fn();
  fetchUrl.mockReturnValueOnce(request.promise);
  await renderWithTheme(photo(A, refused));
  expect(fetchUrl).toHaveBeenCalledWith(A, "card");
  await screen.unmount();
  await act(async () => request.reject(new ApiError("gone", 403, "not_found")));
  expect(refused).not.toHaveBeenCalled();
});
