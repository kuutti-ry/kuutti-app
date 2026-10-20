import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import type * as React from "react";
import { AccessibilityInfo } from "react-native";
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
/** A screen reader's choice of one of a tile's actions (#179). */
const action = async (tile: ReturnType<typeof screen.getByRole>, name: string) => {
  await fireEvent(tile, "accessibilityAction", { nativeEvent: { actionName: name } });
  await act(settle);
};
const tile = (position: number) => screen.getByRole("button", { name: `Open photo ${position}` });
const slot = (position: number) => screen.getByTestId(`photo-tile-${position}`);
/** The grid as the tiles report it: two columns of 100-point squares with a 12-point gap. */
const layOut = async (...positions: number[]) => {
  for (const position of positions) {
    const index = position - 1;
    await fireEvent(slot(position), "layout", {
      nativeEvent: {
        layout: { x: (index % 2) * 112, y: Math.floor(index / 2) * 112, width: 100, height: 100 },
      },
    });
  }
};
const touch = (x: number, y: number) => ({ nativeEvent: { pageX: x, pageY: y } });
/** Whether the slot would take the touch from the tile's pressable now: true only while the tile is lifted. */
const lifted = (position: number): boolean =>
  slot(position).props.onMoveShouldSetResponderCapture() === true;
/** The order of every PUT /photos/order, answered as asked. */
const ordering = (orders: string[][]) => (req: Request) =>
  req.method === "PUT" && new URL(req.url).pathname === "/photos/order"
    ? req.json().then((body: { order: string[] }) => {
        orders.push(body.order);
        return json({
          photos: body.order.map((id, position) => ({ ...photo(1), id, position })),
          maxPhotos: 3,
          tips: [],
        });
      })
    : null;

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

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
  appealable: false,
  position: n - 1,
  createdAt: "2026-09-25T12:00:00.000Z",
  caption: null,
});
const list = (n: number, maxPhotos = 3) => ({
  photos: Array.from({ length: n }, (_, i) => photo(i + 1)),
  maxPhotos,
  tips: [],
});
/** Every photo approved: each one others see, so each but the first can be made the main one. */
const approvedList = (n: number, maxPhotos = 3) => ({
  photos: Array.from({ length: n }, (_, i) => ({ ...photo(i + 1), state: "approved" })),
  maxPhotos,
  tips: [],
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
/** The list as it stands after each change, the last one again after that: the screen reads it again for its tips (#287). */
const answersLists = (...bodies: unknown[]) => {
  let reads = 0;
  return (req: Request) => {
    if (req.method !== "GET" || new URL(req.url).pathname !== "/photos") return null;
    const body = bodies[Math.min(reads, bodies.length - 1)];
    reads += 1;
    return json(body);
  };
};

beforeEach(async () => {
  FakeXhr.install();
  launch.mockReset();
  router.push.mockReset();
  router.back.mockReset();
  setLocalCheck(null);
  // Which tips were said for which main photo lives on the device (#297): each test starts with none said.
  store.delete("kuutti.preference.photoTipsSeen");
  // The photo descriptions setting too (#296): each test starts from the defaults.
  store.delete("kuutti.preference.photoDescriptions");
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
    // Each photo: open, caption (#296), remove. Plus add and done. The moves are the tiles' actions, not buttons (#179).
    expect(found).toHaveLength(8);
    expect(screen.queryByRole("button", { name: "Move later" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make main photo" })).toBeNull();
    const tiles = screen.getAllByRole("button", { name: /^Open photo/ });
    expect(tiles).toHaveLength(2);
    for (const each of tiles) {
      expect(each.props.accessibilityActions).toEqual([
        { name: "moveEarlier", label: "Move earlier" },
        { name: "moveLater", label: "Move later" },
        { name: "makeMain", label: "Make main photo" },
      ]);
    }
  });

  it("calls the first approved photo the main one, the one the card leads with, not one still in review (#239)", async () => {
    fetchMock([
      answersList({
        photos: [
          { ...photo(1), state: "queued" },
          { ...photo(2), state: "approved" },
          { ...photo(3), state: "approved" },
        ],
        maxPhotos: 3,
        tips: [],
      }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    await screen.findByText("Being reviewed");
    expect(
      screen
        .getAllByText(/^(Main photo|Being reviewed|Visible to others)$/)
        .map((node) => node.props.children),
    ).toEqual(["Being reviewed", "Main photo", "Visible to others", "Visible to others"]);
  });

  it("marks a photo in review on the photo itself, hidden from a screen reader, which hears the words under it (#376)", async () => {
    fetchMock([
      answersList({
        photos: [
          { ...photo(1), state: "pending" },
          { ...photo(2), state: "queued", position: 1 },
          { ...photo(3), state: "approved", position: 2 },
          { ...photo(4), state: "rejected", rejectionReason: "no_person", position: 3 },
        ],
        maxPhotos: 6,
        tips: [],
      }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    await screen.findByText("Being reviewed");
    expect(screen.getByText("Waiting for review")).toBeTruthy();
    // The sign is on the two in review only, and a screen reader is not sent to it.
    for (const position of [1, 2]) {
      const sign = screen.getByTestId(`photo-in-review-${position}`, {
        includeHiddenElements: true,
      });
      expect(sign.props.importantForAccessibility).toBe("no-hide-descendants");
      expect(sign.props.accessibilityElementsHidden).toBe(true);
      expect(screen.queryByTestId(`photo-in-review-${position}`)).toBeNull();
    }
    for (const position of [3, 4]) {
      expect(
        screen.queryByTestId(`photo-in-review-${position}`, { includeHiddenElements: true }),
      ).toBeNull();
    }
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });

  it("a photo nobody reviewed in time says so, and that it can be added again (#376)", async () => {
    fetchMock([
      answersList({
        photos: [{ ...photo(1), state: "rejected", rejectionReason: "not_reviewed" }],
        maxPhotos: 3,
        tips: [],
      }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    expect(
      await screen.findByText(
        "Not accepted. Nobody reviewed this photo in time; you can add it again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ask a person/ })).toBeNull();
  });

  it("a rejected photo says why in words, never a label name", async () => {
    fetchMock([
      answersList({
        photos: [{ ...photo(1), state: "rejected", rejectionReason: "no_person" }],
        maxPhotos: 3,
        tips: [],
      }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByText(/A profile photo has to show you/)).toBeTruthy();
    expect(screen.queryByText("Not accepted")).toBeNull();
    // Shown to nobody, so no main photo (#250).
    expect(screen.queryByText("Main photo")).toBeNull();
  });

  it("offers to ask a person to look at the check's rejection, and shows it queued again (#253)", async () => {
    const rejected = {
      ...photo(2),
      state: "rejected",
      rejectionReason: "no_person",
      appealable: true,
    };
    const queued = { ...rejected, state: "queued", rejectionReason: null, appealable: false };
    const { calls } = fetchMock([
      answersLists(
        { photos: [photo(1), rejected], maxPhotos: 3, tips: [] },
        { photos: [photo(1), queued], maxPhotos: 3, tips: [] },
      ),
      answersUrls,
      (req) =>
        req.method === "POST" && new URL(req.url).pathname === `/photos/${rejected.id}/appeal`
          ? json(queued)
          : null,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByText(/A profile photo has to show you/)).toBeTruthy();
    const ask = screen.getByRole("button", { name: "Ask a person to look at photo 2" });
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
    await press(ask);
    expect(
      calls.some((c) => c.method === "POST" && /\/appeal$/.test(new URL(c.url).pathname)),
    ).toBe(true);
    expect(await screen.findByText("Being reviewed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ask a person to look/ })).toBeNull();
  });

  it("names each appeal by its photo's place, so several rejected photos do not sound alike (#217)", async () => {
    const rejected = (n: number) => ({
      ...photo(n),
      state: "rejected",
      rejectionReason: "no_person",
      appealable: true,
    });
    const { calls } = fetchMock([
      answersList({ photos: [rejected(1), photo(2), rejected(3)], maxPhotos: 3, tips: [] }),
      answersUrls,
      (req) =>
        req.method === "POST" && /\/appeal$/.test(new URL(req.url).pathname)
          ? json({ ...rejected(3), state: "queued", rejectionReason: null, appealable: false })
          : null,
    ]);
    await show(<PhotosScreen />);
    const asks = await screen.findAllByRole("button", { name: /^Ask a person to look/ });
    expect(asks.map((ask) => ask.props.accessibilityLabel)).toEqual([
      "Ask a person to look at photo 1",
      "Ask a person to look at photo 3",
    ]);
    // The label begins with the words the button shows, for voice control.
    expect(screen.getAllByText("Ask a person to look")).toHaveLength(2);
    await press(screen.getByRole("button", { name: "Ask a person to look at photo 3" }));
    expect(
      calls
        .filter((c) => c.method === "POST" && /\/appeal$/.test(new URL(c.url).pathname))
        .map((c) => new URL(c.url).pathname),
    ).toEqual([`/photos/${photo(3).id}/appeal`]);
  });

  it("offers no appeal where the API says there is none, and says so when the ask is refused", async () => {
    const sure = { ...photo(1), state: "rejected", rejectionReason: "nudity", appealable: false };
    const stale = {
      ...photo(2),
      state: "rejected",
      rejectionReason: "no_person",
      appealable: true,
    };
    fetchMock([
      answersList({ photos: [sure, stale], maxPhotos: 3, tips: [] }),
      answersUrls,
      (req) =>
        req.method === "POST" && /\/appeal$/.test(new URL(req.url).pathname)
          ? json({ error: { code: "photo_not_appealable", message: "x", requestId: "r" } }, 409)
          : null,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findAllByRole("button", { name: /^Ask a person to look/ })).toHaveLength(1);
    await press(screen.getByRole("button", { name: "Ask a person to look at photo 2" }));
    expect(
      await screen.findByText(
        "A person cannot be asked to look at this photo. Remove it and try another one.",
      ),
    ).toBeTruthy();
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

  it("reads the check's description after the caption in a photo's label, shows it under the photo when the setting asks, and hands it to the zoom screen (#296)", async () => {
    const description = {
      people: 1,
      setting: "outdoors",
      scene: ["lake"],
      objects: ["hiking", "dog"],
      smile: true,
      glasses: false,
      sunglasses: true,
      facialHair: false,
    };
    const words =
      "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.";
    const photos = [{ ...photo(1), caption: "travelling", description }, photo(2)];
    fetchMock([answersList({ photos, maxPhotos: 3, tips: [] }), answersUrls]);
    await show(<PhotosScreen />);
    expect(await screen.findByLabelText(`Photo 1 / 2. Travelling. ${words}`)).toBeTruthy();
    expect(screen.getByLabelText("Photo 2 / 2")).toBeTruthy();
    expect(screen.queryByText(words, { includeHiddenElements: true })).toBeNull();
    await press(screen.getByRole("button", { name: "Open photo 1" }));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/photos/[id]",
      params: expect.objectContaining({ description: JSON.stringify(description) }),
    });

    store.set(
      "kuutti.preference.photoDescriptions",
      JSON.stringify({ shown: true, objects: false }),
    );
    fetchMock([answersList({ photos, maxPhotos: 3, tips: [] }), answersUrls]);
    await show(<PhotosScreen />);
    const withoutObjects =
      "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses.";
    expect(await screen.findByLabelText(`Photo 1 / 2. Travelling. ${withoutObjects}`)).toBeTruthy();
    expect(screen.getByText(withoutObjects, { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText(withoutObjects)).toBeNull();
  });

  it("says the onboarding's step when opened from it, as every other step does, and none otherwise (#146)", async () => {
    fetchMock([answersList(list(2)), answersUrls]);
    await show(<PhotosScreen progress={{ step: 8, total: 10 }} />);
    expect(await screen.findByText("Step 8 of 10")).toBeTruthy();
    expect(screen.getByText("Step 8 of 10").props.accessibilityLiveRegion).toBe("polite");
    await show(<PhotosScreen />);
    expect(await screen.findByText("2 photos, at most 3")).toBeTruthy();
    expect(screen.queryByText(/^Step /)).toBeNull();
  });

  it("Done returns to where the person came from, since no header offers a way back", async () => {
    fetchMock([answersList(list(2)), answersUrls]);
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Done" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("the move-later action sends the new order and renumbers", async () => {
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
              tips: [],
            })
          : null,
    ]);
    await show(<PhotosScreen />);
    await screen.findByText("2 photos, at most 3");
    await action(tile(1), "moveLater");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(await (put as Request).text())).toEqual({
      order: [photo(2).id, photo(1).id],
    });
  });

  it("removes a photo only after the confirmation", async () => {
    const { calls } = fetchMock([
      answersLists(list(1), list(0)),
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
    fetchMock([answersLists(list(1), list(2)), answersUrls]);
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

  it("says so when the photo library cannot be opened", async () => {
    fetchMock([answersList(list(1)), answersUrls]);
    launch.mockRejectedValueOnce(new Error("permission denied"));
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    expect(
      await screen.findByText(
        "Kuutti could not open your photos. Allow access in the phone's settings and try again.",
      ),
    ).toBeTruthy();
  });

  it("gives a refusal it has no words of its own for the generic line", async () => {
    fetchMock([answersList(list(1)), answersUrls]);
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.jpg", width: 3000, height: 2000 }],
    });
    FakeXhr.answers = [{ status: 502, body: "<html>Bad gateway</html>" }];
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    expect(await screen.findByText("The photo could not be uploaded. Try again.")).toBeTruthy();
  });

  it("says it is choosing a photo while the picker is open, and holds the buttons and the moves", async () => {
    const { calls } = fetchMock([answersList(approvedList(2)), answersUrls]);
    launch.mockReturnValueOnce(new Promise(() => undefined));
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Add a photo" }));
    expect(screen.getByText("Choosing a photo…")).toBeTruthy();
    for (const remove of screen.getAllByRole("button", { name: "Remove" })) {
      expect(remove.props.accessibilityState?.disabled).toBe(true);
    }
    expect(
      screen.getByRole("button", { name: "Add a photo" }).props.accessibilityState?.disabled,
    ).toBe(true);
    await action(tile(2), "makeMain");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    // Nor does a tile lift while the screen is busy.
    await fireEvent(tile(2), "longPress");
    expect(lifted(2)).toBe(false);
  });

  const refusingThumbs = (code: string, status: number) => (req: Request) =>
    /\/thumb$/.test(new URL(req.url).pathname)
      ? json({ error: { code, message: "x", requestId: "r" } }, status)
      : null;

  it("tells the person when the day's budget hides the thumbs", async () => {
    fetchMock([answersList(list(1)), refusingThumbs("photo_budget_exceeded", 429)]);
    await show(<PhotosScreen />);
    expect(
      await screen.findByText("That is enough photos for today. They load again after midnight."),
    ).toBeTruthy();
  });

  it("stays quiet about a thumb refused for another reason", async () => {
    const { calls } = fetchMock([answersList(list(1)), refusingThumbs("not_found", 404)]);
    await show(<PhotosScreen />);
    expect(await screen.findByText("1 photo, at most 3")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => /\/thumb$/.test(c.url))).toBe(true));
    await act(settle);
    expect(screen.queryByRole("button", { name: "OK" })).toBeNull();
  });

  it("removes nothing when the person keeps the photo or closes the question", async () => {
    const { calls } = fetchMock([answersList(list(1)), answersUrls]);
    await show(<PhotosScreen />);
    await press(await screen.findByRole("button", { name: "Remove" }));
    await press(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText("Remove this photo?")).toBeNull();
    await press(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove this photo?")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Remove this photo?")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText("1 photo, at most 3")).toBeTruthy();
  });

  it("gives a photo a caption from the list (#296): the dialog's lines, the choice sent and shown, No caption clears it", async () => {
    const sent: unknown[] = [];
    fetchMock([
      answersList(list(2)),
      answersUrls,
      (req) =>
        req.method === "PUT" && /\/caption$/.test(new URL(req.url).pathname)
          ? req.json().then((body: { caption: string | null }) => {
              sent.push(body.caption);
              const id = new URL(req.url).pathname.split("/")[2];
              return json({ ...photo(1), id, caption: body.caption });
            })
          : null,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findAllByRole("button", { name: /^Caption of photo/ })).toHaveLength(2);
    expect(screen.getAllByText("Add a caption")).toHaveLength(2);
    const button = () => screen.getByRole("button", { name: "Caption of photo 1" });
    expect(button().props.accessibilityValue).toEqual({ text: "No caption" });

    await press(button());
    expect(await screen.findByText("A caption for photo 1")).toBeTruthy();
    // Every line of the list and none, each a radio; none chosen yet but "No caption"; every control labelled.
    expect(screen.getAllByRole("radio")).toHaveLength(17);
    expect(
      screen.getByRole("radio", { name: "✓ No caption" }).props.accessibilityState,
    ).toMatchObject({ checked: true });
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);

    await press(screen.getByRole("radio", { name: "An old favourite" }));
    await waitFor(() => expect(sent).toEqual(["old_favourite"]));
    expect(screen.queryByText("A caption for photo 1")).toBeNull();
    expect(await screen.findByText("An old favourite")).toBeTruthy();
    expect(button().props.accessibilityValue).toEqual({ text: "An old favourite" });
    // The photo's own label says the line; the second photo keeps none.
    expect(screen.getByLabelText("Photo 1 / 2. An old favourite")).toBeTruthy();
    expect(screen.getByLabelText("Photo 2 / 2")).toBeTruthy();
    expect(screen.getAllByText("Add a caption")).toHaveLength(1);

    // Opened again, the chosen line is marked; No caption takes it off.
    await press(button());
    expect(await screen.findByRole("radio", { name: "✓ An old favourite" })).toBeTruthy();
    await press(screen.getByRole("radio", { name: "No caption" }));
    await waitFor(() => expect(sent).toEqual(["old_favourite", null]));
    expect(await screen.findAllByText("Add a caption")).toHaveLength(2);
    expect(screen.getByLabelText("Photo 1 / 2")).toBeTruthy();
  });

  it("opens the photo full size with its caption, and says so when a caption could not be saved", async () => {
    fetchMock([
      answersList({ photos: [{ ...photo(1), caption: "travelling" }], maxPhotos: 3, tips: [] }),
      answersUrls,
      (req) =>
        req.method === "PUT" && /\/caption$/.test(new URL(req.url).pathname)
          ? json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404)
          : null,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByLabelText("Photo 1 / 1. Travelling")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Open photo 1" }));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/photos/[id]",
      params: expect.objectContaining({ id: photo(1).id, caption: "travelling" }),
    });

    await press(screen.getByRole("button", { name: "Caption of photo 1" }));
    await press(await screen.findByRole("radio", { name: "No caption" }));
    expect(await screen.findByText("The caption could not be saved. Try again.")).toBeTruthy();
    // The photo keeps the line it had.
    expect(screen.getByText("Travelling")).toBeTruthy();
    expect(screen.getByLabelText("Photo 1 / 1. Travelling")).toBeTruthy();
  });

  it("says what state each photo is in, a rejection without a reason as not accepted", async () => {
    fetchMock([
      answersList({
        photos: [
          { ...photo(1), state: "queued" },
          { ...photo(2), state: "rejected", rejectionReason: null },
        ],
        maxPhotos: 3,
        tips: [],
      }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByText("Being reviewed")).toBeTruthy();
    expect(screen.getByText("Not accepted")).toBeTruthy();
  });

  it("the actions make a photo the main one and move the last one a step towards the front; a name it does not know changes nothing", async () => {
    const orders: string[][] = [];
    fetchMock([answersList(approvedList(3)), answersUrls, ordering(orders)]);
    await show(<PhotosScreen />);
    await screen.findByText("3 photos, at most 3");
    await action(tile(3), "makeMain");
    await waitFor(() => expect(orders).toHaveLength(1));
    // Photo 1 is the last tile now; its move earlier swaps it with photo 2.
    await action(tile(3), "moveEarlier");
    await waitFor(() => expect(orders).toHaveLength(2));
    await action(tile(1), "swapWithTheNeighbour");
    expect(orders).toEqual([
      [photo(3).id, photo(1).id, photo(2).id],
      [photo(3).id, photo(2).id, photo(1).id],
    ]);
  });

  it("shows one tip at a time by the photos; a dismissed one gives way to the next and is not said again (#287, #297)", async () => {
    const withTips = { ...approvedList(2), tips: ["sunglasses", "few_photos"] };
    fetchMock([answersList(withTips), answersUrls]);
    await show(<PhotosScreen />);
    expect(await screen.findByText("A tip for your photos")).toBeTruthy();
    expect(screen.getByText(/without sunglasses/)).toBeTruthy();
    expect(screen.queryByText(/fuller picture/)).toBeNull();
    expect(screen.queryAllByText(/^profile\.tip\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await press(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/without sunglasses/)).toBeNull();
    expect(screen.getByText(/fuller picture/)).toBeTruthy();
    // The photos opened again: the dismissal is remembered on the device.
    fetchMock([answersList(withTips), answersUrls]);
    await show(<PhotosScreen />);
    expect(await screen.findByText(/fuller picture/)).toBeTruthy();
    expect(screen.queryByText(/without sunglasses/)).toBeNull();
    await press(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("A tip for your photos")).toBeNull();
  });

  it("names the fish of the fish tip when the API is sure of it (#253)", async () => {
    fetchMock([
      answersList({ ...approvedList(1), tips: ["fish"], fishSpecies: "pike" }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByText(/Is that a pike\?/)).toBeTruthy();
  });

  it("says the plain fish tip when the API names no fish, and nothing with no tip", async () => {
    fetchMock([answersList({ ...approvedList(1), tips: ["fish"] }), answersUrls]);
    await show(<PhotosScreen />);
    expect(await screen.findByText(/A fish in the main photo is a classic/)).toBeTruthy();
    expect(screen.queryByText(/Is that/)).toBeNull();
    fetchMock([answersList(approvedList(1)), answersUrls]);
    await show(<PhotosScreen />);
    expect(await screen.findByText("Main photo")).toBeTruthy();
    expect(screen.queryByText("A tip for your photos")).toBeNull();
  });

  it("leaves out a tip this build does not know, and loads the rest", async () => {
    // A newer API names a tip kind this app has no words for yet.
    // mirror_selfie: a kind no earlier test dismisses for the app's run.
    fetchMock([
      answersList({ ...approvedList(1), tips: ["a_kind_from_a_later_api", "mirror_selfie"] }),
      answersUrls,
    ]);
    await show(<PhotosScreen />);
    expect(await screen.findByText("Try a photo that is not a mirror selfie.")).toBeTruthy();
  });

  describe("dragging a tile (#179)", () => {
    /** A motion-off phone: the lift, the slides and the settling take no time, so a drop saves at once. */
    let motion: jest.SpyInstance;
    beforeEach(() => {
      motion = jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    });
    afterEach(() => motion.mockRestore());

    const grid = () => {
      const orders: string[][] = [];
      const { calls } = fetchMock([answersList(approvedList(3)), answersUrls, ordering(orders)]);
      return { orders, calls };
    };
    const shown = async () => {
      await show(<PhotosScreen />);
      await screen.findByText("3 photos, at most 3");
    };
    /** The whole page tree, for what is not a button: the scroll view. */
    const scrollEnabled = (): unknown => {
      const find = (node: HostNode | string): HostNode | null => {
        if (typeof node === "string") return null;
        if (node.type === "RCTScrollView") return node;
        for (const child of node.children ?? []) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      return find(screen.toJSON() as HostNode)?.props.scrollEnabled;
    };

    it("a tile dragged to the first slot becomes the main photo, and the order is saved once, on drop", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      expect(lifted(3)).toBe(false);
      expect(scrollEnabled()).toBe(true);
      await fireEvent(tile(3), "longPress");
      expect(lifted(3)).toBe(true);
      expect(lifted(1)).toBe(false);
      expect(scrollEnabled()).toBe(false);
      // The slot holds the touch from the first move on, and blocks the scroll view's.
      expect(await fireEvent(slot(3), "responderGrant", touch(50, 400))).toBe(true);
      // Up a row: the tile's centre is over the first slot.
      await fireEvent(slot(3), "responderMove", touch(50, 340));
      await fireEvent(slot(3), "responderMove", touch(50, 288));
      await fireEvent(slot(3), "responderRelease", touch(50, 288));
      await act(settle);
      expect(orders).toEqual([[photo(3).id, photo(1).id, photo(2).id]]);
      expect(lifted(3)).toBe(false);
      expect(scrollEnabled()).toBe(true);
      expect(screen.getAllByText("Main photo")).toHaveLength(1);
    });

    it("keeps the last tile crossed when the finger rests in a gap, and saves that", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      await fireEvent(tile(1), "longPress");
      await fireEvent(slot(1), "responderGrant", touch(50, 50));
      await fireEvent(slot(1), "responderMove", touch(60, 50)); // still over its own slot
      await fireEvent(slot(1), "responderMove", touch(162, 50)); // over the second
      await fireEvent(slot(1), "responderMove", touch(105, 50)); // the gap between the two
      await fireEvent(slot(1), "responderRelease", touch(105, 50));
      await act(settle);
      expect(orders).toEqual([[photo(2).id, photo(1).id, photo(3).id]]);
    });

    it("a drop on the tile's own slot saves nothing", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      await fireEvent(tile(2), "longPress");
      await fireEvent(slot(2), "responderGrant", touch(160, 50));
      await fireEvent(slot(2), "responderMove", touch(170, 60));
      await fireEvent(slot(2), "responderRelease", touch(170, 60));
      await act(settle);
      expect(orders).toEqual([]);
      expect(lifted(2)).toBe(false);
    });

    it("a drag the system cuts short saves nothing and puts the tile down", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      await fireEvent(tile(1), "longPress");
      await fireEvent(slot(1), "responderGrant", touch(50, 50));
      await fireEvent(slot(1), "responderMove", touch(162, 50));
      await fireEvent(slot(1), "responderTerminate", touch(162, 50));
      expect(lifted(1)).toBe(false);
      expect(scrollEnabled()).toBe(true);
      await act(settle);
      expect(orders).toEqual([]);
    });

    it("a long press without a move puts the tile down again", async () => {
      grid();
      await shown();
      await layOut(1, 2, 3);
      await fireEvent(tile(1), "longPress");
      expect(lifted(1)).toBe(true);
      await act(async () => {
        await fireEvent(tile(1), "pressOut");
        await settle();
      });
      expect(lifted(1)).toBe(false);
      expect(scrollEnabled()).toBe(true);
    });

    it("a touch that was never a long press moves nothing", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      expect(await fireEvent(slot(1), "responderGrant", touch(50, 50))).toBe(false);
      await fireEvent(slot(1), "responderMove", touch(162, 50));
      await fireEvent(slot(1), "responderRelease", touch(162, 50));
      await act(settle);
      expect(orders).toEqual([]);
    });

    it("only the lifted tile's slot takes the touch, and a second long press meanwhile is ignored", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      await fireEvent(tile(1), "longPress");
      await fireEvent(tile(2), "longPress");
      expect(lifted(2)).toBe(false);
      // Nor does another view's request for the touch take it from the lifted one.
      expect(slot(1).props.onResponderTerminationRequest()).toBe(false);
      expect(await fireEvent(slot(2), "responderGrant", touch(160, 50))).toBe(false);
      await fireEvent(slot(2), "responderMove", touch(50, 50));
      await fireEvent(slot(2), "responderRelease", touch(50, 50));
      await act(settle);
      expect(orders).toEqual([]);
      expect(lifted(1)).toBe(true);
    });

    it("finds no slot before the grid is laid out, and a drop then saves nothing", async () => {
      const { orders } = grid();
      await shown();
      await fireEvent(tile(1), "longPress");
      await fireEvent(slot(1), "responderGrant", touch(50, 50));
      await fireEvent(slot(1), "responderMove", touch(162, 50));
      await fireEvent(slot(1), "responderRelease", touch(162, 50));
      await act(settle);
      expect(orders).toEqual([]);
      expect(lifted(1)).toBe(false);
    });

    it("slides past a tile that has not been laid out, and still saves the drop", async () => {
      const { orders } = grid();
      await shown();
      await layOut(1, 3);
      await fireEvent(tile(1), "longPress");
      await fireEvent(slot(1), "responderGrant", touch(50, 50));
      // Over the third slot: the second would step aside, but it has no place to go yet.
      await fireEvent(slot(1), "responderMove", touch(50, 162));
      await fireEvent(slot(1), "responderRelease", touch(50, 162));
      await act(settle);
      expect(orders).toEqual([[photo(2).id, photo(3).id, photo(1).id]]);
    });

    it("with motion on, the order is saved once the tile has settled into its slot", async () => {
      motion.mockResolvedValue(false);
      const { orders } = grid();
      await shown();
      await layOut(1, 2, 3);
      jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
      try {
        await fireEvent(tile(1), "longPress");
        await fireEvent(slot(1), "responderGrant", touch(50, 50));
        await fireEvent(slot(1), "responderMove", touch(162, 50));
        await fireEvent(slot(1), "responderRelease", touch(162, 50));
        expect(orders).toEqual([]); // settling takes 150 ms
        await act(async () => {
          jest.advanceTimersByTime(300);
        });
        expect(orders).toEqual([[photo(2).id, photo(1).id, photo(3).id]]);
      } finally {
        jest.useRealTimers();
      }
      await act(settle);
    });
  });
});
