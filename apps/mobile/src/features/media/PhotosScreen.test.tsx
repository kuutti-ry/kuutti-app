import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { FakeXhr, partsOf } from "@/test/xhr";
import { setLocalCheck } from "./localCheck";
import { PhotosScreen } from "./PhotosScreen";

/**
 * The screen's work happens in promise chains and one macrotask (the upload's
 * XMLHttpRequest answers on a timer); rendering and pressing inside act() and
 * letting those settle keeps every state update inside a scope React knows about.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await settle();
  });
const press = async (element: ReturnType<typeof screen.getByRole>) => {
  await fireEvent.press(element);
  await act(settle);
};

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};

const photo = (n: number) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 1600,
  height: 1200,
  state: n === 1 ? "approved" : "pending",
  rejectionReason: null,
  position: n - 1,
  createdAt: "2026-09-25T12:00:00.000Z",
});
const list = (n: number, maxPhotos = 3) => ({
  photos: Array.from({ length: n }, (_, i) => photo(i + 1)),
  maxPhotos,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const url = (id: string, variant: string) => ({
  url: `https://media.test/media/k/${variant}.webp?Signature=s`,
  variant,
  expiresAt: "2030-01-01T00:15:00.000Z",
  id,
});

/** The typed client's requests, answered by path: the list, then a URL per photo, then whatever the test adds. */
function fetchMock(handlers: Array<(req: Request) => Response | Promise<Response> | null>) {
  const calls: Request[] = [];
  const mock = jest.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    calls.push(req);
    for (const handler of handlers) {
      const res = await handler(req);
      if (res) return res;
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return { calls, mock };
}
const answersUrls = (req: Request) => {
  const m = /\/photos\/([^/]+)\/(thumb|card|full)$/.exec(new URL(req.url).pathname);
  return m && req.method === "GET" ? json(url(m[1] ?? "", m[2] ?? "")) : null;
};
const answersList = (body: unknown) => (req: Request) =>
  req.method === "GET" && new URL(req.url).pathname === "/photos" ? json(body) : null;

beforeEach(async () => {
  FakeXhr.install();
  launch.mockReset();
  router.push.mockReset();
  router.back.mockReset();
  setLocalCheck(null);
  await saveSession(session);
});

describe("PhotosScreen", () => {
  it("lists the photos as thumbs with their state, the main photo first, and every control labelled", async () => {
    const { calls } = fetchMock([answersList(list(2)), answersUrls]);
    await show(<PhotosScreen />);
    expect(await screen.findByRole("heading", { name: "Your photos" })).toBeTruthy();
    expect(await screen.findByText("2 photos, at most 3")).toBeTruthy();
    expect(screen.getByText("Main photo")).toBeTruthy();
    expect(screen.getByText("Visible to others")).toBeTruthy();
    expect(screen.getByText("Waiting for review")).toBeTruthy();
    // thumb for the grid; never card or full here (rules/mobile.md Images).
    await waitFor(() =>
      expect(calls.filter((c) => /\/thumb$/.test(new URL(c.url).pathname))).toHaveLength(2),
    );
    expect(calls.some((c) => /\/(card|full)$/.test(new URL(c.url).pathname))).toBe(false);

    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    // Photo 1: open, move later, remove. Photo 2: open, make main, move earlier, remove. Plus add and done.
    expect(found).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Move later" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make main photo" })).toBeTruthy();
  });

  it("a rejected photo says why in words, never a label name", async () => {
    fetchMock([
      answersList({
        photos: [{ ...photo(1), state: "rejected", rejectionReason: "no_person" }],
        maxPhotos: 3,
      }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByText(/A profile photo has to show you/)).toBeTruthy();
    expect(screen.queryByText("Not accepted")).toBeNull();
  });

  it("opens the zoom screen for a tapped photo with what its label needs", async () => {
    fetchMock([answersList(list(2)), answersUrls]);
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Open photo 2" }));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/photos/[id]",
      params: { id: photo(2).id, blurhash: photo(2).blurhash, position: "2", total: "2" },
    });
  });

  it("Done returns to where the person came from, since no header offers a way back", async () => {
    fetchMock([answersList(list(2)), answersUrls]);
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Done" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("reorders with buttons: move later sends the new order and renumbers", async () => {
    const { calls } = fetchMock([
      answersList(list(2)),
      answersUrls,
      (req) =>
        req.method === "PUT" && new URL(req.url).pathname === "/photos/order"
          ? json({
              photos: [
                { ...photo(2), position: 0 },
                { ...photo(1), position: 1 },
              ],
              maxPhotos: 3,
            })
          : null,
    ]);
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Move later" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(await (put as Request).text())).toEqual({
      order: [photo(2).id, photo(1).id],
    });
  });

  it("removes a photo only after the confirmation", async () => {
    const { calls } = fetchMock([
      answersList(list(1)),
      answersUrls,
      (req) => (req.method === "DELETE" ? new Response(null, { status: 204 }) : null),
    ]);
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove this photo?")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);

    await press(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("No photos yet.")).toBeTruthy();
  });

  it("adds a photo: picker, on-device check, pre-resize, upload with progress, then the grid grows", async () => {
    fetchMock([answersList(list(1)), answersUrls]);
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.heic", width: 4032, height: 3024 }],
    });
    const checked: string[] = [];
    setLocalCheck(async (uri) => {
      checked.push(uri);
      return "allow";
    });
    FakeXhr.answers = [{ status: 201, body: JSON.stringify({ ...photo(2), state: "pending" }) }];

    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    await waitFor(() => expect(screen.getByText("2 photos, at most 3")).toBeTruthy());
    expect(checked).toEqual(["file:///a.heic"]); // the picked file, before the resize
    const sent = FakeXhr.sent[0];
    const parts = partsOf(sent);
    expect(parts[0]).toMatchObject({ uri: "file:///a.heic#resized", type: "image/jpeg" });
    expect(screen.getAllByText("Waiting for review")).toHaveLength(1);
  });

  it("a photo the on-device check refuses is never sent, and the person is told in one line", async () => {
    fetchMock([answersList(list(1)), answersUrls]);
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///nude.jpg", width: 3000, height: 2000 }],
    });
    setLocalCheck(async () => "refuse");
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    expect(await screen.findByText("This photo cannot be used.")).toBeTruthy();
    expect(FakeXhr.sent).toHaveLength(0);
    expect(screen.getByText("1 photo, at most 3")).toBeTruthy();
  });

  it("shows the API's refusal in its own words and lets the person dismiss it", async () => {
    fetchMock([answersList(list(1)), answersUrls]);
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.jpg", width: 3000, height: 2000 }],
    });
    FakeXhr.answers = [
      {
        status: 409,
        body: JSON.stringify({ error: { code: "photo_limit", message: "x", requestId: "r" } }),
      },
    ];
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    expect(await screen.findByText(/maximum number of photos/)).toBeTruthy();
    await press(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText(/maximum number of photos/)).toBeNull();
  });

  it("disables adding at max_photos", async () => {
    fetchMock([answersList(list(3)), answersUrls]);
    await show(<PhotosScreen />);
    const add = await screen.findByRole("button", { name: "Add a photo" });
    expect(add.props.accessibilityState?.disabled).toBe(true);
  });

  it("a cancelled picker changes nothing", async () => {
    fetchMock([answersList(list(1)), answersUrls]);
    launch.mockResolvedValueOnce({ canceled: true, assets: null });
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    await waitFor(() => expect(launch).toHaveBeenCalled());
    expect(screen.getByText("1 photo, at most 3")).toBeTruthy();
    expect(FakeXhr.sent).toHaveLength(0);
  });
});
