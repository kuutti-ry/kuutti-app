import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { saveSession } from "@/lib/session";
import { FakeXhr } from "@/test/xhr";
import { setLocalCheck } from "./localCheck";
import { usePhotos } from "./usePhotos";

// The photos hook (#48) on its own: the list, the chain that adds a photo,
// removal, the optimistic reorder that the API may refuse, and the notices
// each outcome leaves for the screen.

const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const photo = (n: number) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 1600,
  height: 1200,
  state: "approved",
  rejectionReason: null,
  appealable: false,
  caption: null,
  description: null,
  position: n - 1,
  createdAt: "2026-09-25T12:00:00.000Z",
});
const list = (...ns: number[]) => ({
  photos: ns.map(photo),
  maxPhotos: 6,
  tips: [],
  fishSpecies: null,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

type Route = (request: Request) => Response | Promise<Response> | null;
/** Answers by method and path; records every request. */
function serve(...routes: Route[]) {
  const seen: Request[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    for (const route of routes) {
      const answer = await route(request);
      if (answer) return answer;
    }
    throw new TypeError("Network request failed");
  }) as unknown as typeof fetch;
  return seen;
}
const isList = (r: Request) => r.method === "GET" && new URL(r.url).pathname === "/photos";
const listing = (...answers: Array<() => Response>) => {
  let n = 0;
  return (r: Request) => {
    if (!isList(r)) return null;
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    return answer ? answer() : null;
  };
};
const writes = (seen: Request[]) => seen.filter((r) => r.method !== "GET");
const ids = (state: { list: { photos: Array<{ id: string; position: number }> } | null }) =>
  state.list?.photos.map((p) => [p.id, p.position]);

/** An upload the test answers itself, so each step can be seen on the way. */
class SteppedXhr extends FakeXhr {
  static current: SteppedXhr | null = null;
  override send(body: FormData | null): void {
    FakeXhr.sent.push({ method: "POST", url: "", headers: {}, body });
    SteppedXhr.current = this;
  }
  answer(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

async function ready() {
  const view = await renderHook(() => usePhotos());
  await waitFor(() => expect(view.result.current.status).not.toBe("loading"));
  return view;
}

beforeEach(async () => {
  FakeXhr.install();
  launch.mockReset();
  launch.mockResolvedValue({ canceled: true, assets: null });
  setLocalCheck(null);
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("usePhotos: the list", () => {
  it("loads the list, idle and without a notice", async () => {
    serve(listing(() => json(list(1, 2))));
    const { result } = await ready();
    expect(result.current.status).toBe("ready");
    expect(result.current.list).toEqual(list(1, 2));
    expect(result.current.busy).toEqual({ kind: "idle" });
    expect(result.current.notice).toBeNull();
  });

  it("is an error with the API's code when the list is refused", async () => {
    serve(listing(() => refusal("internal_error", 500)));
    const { result } = await ready();
    expect(result.current.status).toBe("error");
    expect(result.current.list).toBeNull();
    expect(result.current.notice).toEqual({ kind: "error", code: "internal_error" });
  });

  it("is an error without a code when the network fails", async () => {
    serve();
    const { result } = await ready();
    expect(result.current.status).toBe("error");
    expect(result.current.notice).toEqual({ kind: "error", code: undefined });
  });

  it("reports a refused photo URL as a notice, and lets the person dismiss it", async () => {
    serve(listing(() => json(list(1))));
    const { result } = await ready();
    await act(async () => result.current.reportRefusal("photo_budget_exceeded"));
    expect(result.current.notice).toEqual({ kind: "error", code: "photo_budget_exceeded" });
    await act(async () => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });
});

describe("usePhotos: adding", () => {
  it("says the photo library is not allowed when the picker cannot open", async () => {
    serve(listing(() => json(list(1))));
    launch.mockRejectedValueOnce(new Error("permission denied"));
    const { result } = await ready();
    await act(async () => result.current.add());
    expect(result.current.notice).toEqual({ kind: "permission" });
    expect(result.current.busy).toEqual({ kind: "idle" });
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it("goes back to idle without a notice when the picker is cancelled", async () => {
    serve(listing(() => json(list(1))));
    const { result } = await ready();
    await act(async () => result.current.add());
    expect(result.current.busy).toEqual({ kind: "idle" });
    expect(result.current.notice).toBeNull();
  });

  it("reports the upload's progress in whole percent, appends the new photo, then reads the list again for its tips (#287)", async () => {
    const seen = serve(
      listing(
        () => json(list(1)),
        () => json({ ...list(1, 2), tips: ["fish"], fishSpecies: "pike" }),
      ),
    );
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.jpg", width: 1200, height: 900 }],
    });
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = SteppedXhr;
    const { result } = await ready();
    let adding: Promise<void> | undefined;
    await act(async () => {
      adding = result.current.add();
    });
    await waitFor(() => expect(result.current.busy).toEqual({ kind: "uploading", percent: 0 }));
    await act(async () =>
      SteppedXhr.current?.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 }),
    );
    expect(result.current.busy).toEqual({ kind: "uploading", percent: 33 });
    await act(async () => {
      SteppedXhr.current?.answer(201, JSON.stringify(photo(2)));
      await adding;
    });
    expect(result.current.busy).toEqual({ kind: "idle" });
    expect(ids(result.current)).toEqual([
      [photo(1).id, 0],
      [photo(2).id, 1],
    ]);
    expect(seen.filter(isList)).toHaveLength(2);
    expect(result.current.list?.tips).toEqual(["fish"]);
    expect(result.current.list?.fishSpecies).toBe("pike");
  });

  it("uploads but leaves the list alone when there was none to add to", async () => {
    serve(listing(() => refusal("internal_error", 500)));
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.jpg", width: 1200, height: 900 }],
    });
    FakeXhr.answers = [{ status: 201, body: JSON.stringify(photo(2)) }];
    const { result } = await ready();
    await act(async () => result.current.dismissNotice());
    await act(async () => result.current.add());
    expect(FakeXhr.sent).toHaveLength(1);
    expect(result.current.list).toBeNull();
    expect(result.current.busy).toEqual({ kind: "idle" });
    expect(result.current.notice).toBeNull();
  });

  it("refuses a photo the on-device check could not look at, sending nothing", async () => {
    serve(listing(() => json(list(1))));
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.jpg", width: 1200, height: 900 }],
    });
    setLocalCheck(async () => {
      throw new Error("model missing");
    });
    const { result } = await ready();
    await act(async () => result.current.add());
    expect(result.current.notice).toEqual({ kind: "refused_local" });
    expect(FakeXhr.sent).toHaveLength(0);
  });
});

describe("usePhotos: appealing (#253)", () => {
  it("puts the photo back as the API answers it, queued, in its place", async () => {
    const queued = { ...photo(2), state: "queued" };
    const seen = serve(
      listing(
        () => json(list(1, 2)),
        () => json({ ...list(1, 2), photos: [photo(1), queued] }),
      ),
      (r) => (r.method === "POST" && r.url.endsWith("/appeal") ? json(queued) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.appeal(photo(2).id));
    expect(writes(seen).map((r) => new URL(r.url).pathname)).toEqual([
      `/photos/${photo(2).id}/appeal`,
    ]);
    expect(result.current.list?.photos.map((p) => p.state)).toEqual([photo(1).state, "queued"]);
    expect(result.current.busy).toEqual({ kind: "idle" });
    // Read again, for the tips a photo in review changes (#287).
    expect(seen.filter(isList)).toHaveLength(2);
  });

  it("keeps the photo and says why when the ask is refused", async () => {
    serve(
      listing(() => json(list(1, 2))),
      (r) => (r.method === "POST" ? refusal("photo_not_appealable", 409) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.appeal(photo(2).id));
    expect(result.current.notice).toEqual({ kind: "error", code: "photo_not_appealable" });
    expect(result.current.list).toEqual(list(1, 2));
  });

  it("appeals with no list to update when the list never loaded", async () => {
    serve(
      listing(() => refusal("internal_error", 500)),
      (r) => (r.method === "POST" ? json({ ...photo(1), state: "queued" }) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.appeal(photo(1).id));
    expect(result.current.list).toBeNull();
    expect(result.current.busy).toEqual({ kind: "idle" });
  });
});

describe("usePhotos: removing", () => {
  it("removes a photo and renumbers the rest", async () => {
    const after = {
      ...list(2, 3),
      photos: [
        { ...photo(2), position: 0 },
        { ...photo(3), position: 1 },
      ],
    };
    const seen = serve(
      listing(
        () => json({ ...list(1, 2, 3), tips: ["fish"] }),
        () => json(after),
      ),
      (r) => (r.method === "DELETE" ? new Response(null, { status: 204 }) : null),
    );
    const { result } = await ready();
    expect(result.current.list?.tips).toEqual(["fish"]);
    await act(async () => result.current.remove(photo(1).id));
    expect(writes(seen).map((r) => new URL(r.url).pathname)).toEqual([`/photos/${photo(1).id}`]);
    expect(ids(result.current)).toEqual([
      [photo(2).id, 0],
      [photo(3).id, 1],
    ]);
    expect(result.current.busy).toEqual({ kind: "idle" });
    // The fish went with its photo: the list read again says so (#287).
    expect(seen.filter(isList)).toHaveLength(2);
    expect(result.current.list?.tips).toEqual([]);
  });

  it("keeps a newer order when the read after a removal answers last (#287)", async () => {
    // The read after the removal is held; meanwhile a photo is moved and the
    // move is answered. The held read, answering last, must not put the old order back.
    let reads = 0;
    let answerStale: (response: Response) => void = () => {};
    const stale = new Promise<Response>((resolve) => {
      answerStale = resolve;
    });
    serve(
      (r) => {
        if (!isList(r)) return null;
        reads += 1;
        return reads === 1 ? json(list(1, 2, 3)) : stale;
      },
      (r) => (r.method === "DELETE" ? new Response(null, { status: 204 }) : null),
      (r) =>
        r.method === "PUT"
          ? r.json().then((body: { order: string[] }) =>
              json({
                ...list(),
                photos: body.order.map((id, position) => ({ ...photo(1), id, position })),
              }),
            )
          : null,
    );
    const { result } = await ready();
    let removing: Promise<void> | undefined;
    await act(async () => {
      removing = result.current.remove(photo(1).id);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(reads).toBe(2);
    await act(async () => result.current.moveTo(1, 0));
    expect(ids(result.current)).toEqual([
      [photo(3).id, 0],
      [photo(2).id, 1],
    ]);
    await act(async () => {
      answerStale(json(list(2, 3)));
      await removing;
    });
    expect(ids(result.current)).toEqual([
      [photo(3).id, 0],
      [photo(2).id, 1],
    ]);
  });

  it.each([
    ["a cancelled picker", "cancelled"],
    ["a refused removal", "refused"],
  ] as const)(
    "applies the read after a removal when %s ends meanwhile (#287)",
    async (_what, how) => {
      // The read after the removal is held; meanwhile another change starts and
      // ends without touching the list. The held read must still land: it is
      // the one that takes the fish tip away with its photo.
      let reads = 0;
      let answerHeld: (response: Response) => void = () => {};
      const held = new Promise<Response>((resolve) => {
        answerHeld = resolve;
      });
      serve(
        (r) => {
          if (!isList(r)) return null;
          reads += 1;
          return reads === 1 ? json({ ...list(1, 2, 3), tips: ["fish"] }) : held;
        },
        (r) => {
          if (r.method !== "DELETE") return null;
          // The first removal goes through; the second, of photo 2, is refused.
          return r.url.endsWith(photo(1).id)
            ? new Response(null, { status: 204 })
            : refusal("media_unavailable", 503);
        },
      );
      const { result } = await ready();
      let removing: Promise<void> | undefined;
      await act(async () => {
        removing = result.current.remove(photo(1).id);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
      expect(reads).toBe(2);
      await act(async () =>
        how === "cancelled" ? result.current.add() : result.current.remove(photo(2).id),
      );
      await act(async () => {
        answerHeld(
          json({
            ...list(2, 3),
            photos: [
              { ...photo(2), position: 0 },
              { ...photo(3), position: 1 },
            ],
            tips: [],
          }),
        );
        await removing;
      });
      expect(result.current.list?.tips).toEqual([]);
      expect(ids(result.current)).toEqual([
        [photo(2).id, 0],
        [photo(3).id, 1],
      ]);
    },
  );

  it("keeps the list as it is when the read after a removal fails", async () => {
    serve(
      listing(
        () => json(list(1, 2)),
        () => refusal("internal_error", 500),
      ),
      (r) => (r.method === "DELETE" ? new Response(null, { status: 204 }) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.remove(photo(1).id));
    expect(ids(result.current)).toEqual([[photo(2).id, 0]]);
    expect(result.current.status).toBe("ready");
    expect(result.current.notice).toBeNull();
  });

  it("keeps the photo and says why when the removal is refused", async () => {
    serve(
      listing(() => json(list(1, 2))),
      (r) => (r.method === "DELETE" ? refusal("media_unavailable", 503) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.remove(photo(2).id));
    expect(result.current.notice).toEqual({ kind: "error", code: "media_unavailable" });
    expect(result.current.list).toEqual(list(1, 2));
  });

  it("removes with no list to update when the list never loaded", async () => {
    serve(
      listing(() => refusal("internal_error", 500)),
      (r) => (r.method === "DELETE" ? new Response(null, { status: 204 }) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.remove(photo(1).id));
    expect(result.current.list).toBeNull();
    expect(result.current.busy).toEqual({ kind: "idle" });
  });
});

describe("usePhotos: the order", () => {
  const ordered = (r: Request) =>
    r.method === "PUT"
      ? r.json().then((body: { order: string[] }) =>
          json({
            photos: body.order.map((id, position) => ({ ...photo(1), id, position })),
            maxPhotos: 6,
            tips: [],
          }),
        )
      : null;

  it("moves a photo one step either way", async () => {
    const seen = serve(
      listing(() => json(list(1, 2, 3))),
      ordered,
    );
    const { result } = await ready();
    await act(async () => result.current.move(photo(3).id, -1));
    expect(ids(result.current)?.map(([id]) => id)).toEqual([photo(1).id, photo(3).id, photo(2).id]);
    await act(async () => result.current.move(photo(1).id, 1));
    expect(ids(result.current)?.map(([id]) => id)).toEqual([photo(3).id, photo(1).id, photo(2).id]);
    expect(writes(seen)).toHaveLength(2);
  });

  it("does nothing for a step past either end or a photo it does not have", async () => {
    const seen = serve(
      listing(() => json(list(1, 2))),
      ordered,
    );
    const { result } = await ready();
    await act(async () => result.current.move(photo(1).id, -1));
    await act(async () => result.current.move(photo(2).id, 1));
    await act(async () => result.current.move(photo(9).id, 1));
    expect(writes(seen)).toHaveLength(0);
    expect(result.current.list).toEqual(list(1, 2));
  });

  it("makes another photo the main one, and does nothing for the main one or an unknown one", async () => {
    const seen = serve(
      listing(() => json(list(1, 2, 3))),
      ordered,
    );
    const { result } = await ready();
    await act(async () => result.current.makeMain(photo(1).id));
    await act(async () => result.current.makeMain(photo(9).id));
    expect(writes(seen)).toHaveLength(0);
    await act(async () => result.current.makeMain(photo(3).id));
    expect(ids(result.current)?.map(([id]) => id)).toEqual([photo(3).id, photo(1).id, photo(2).id]);
  });

  it("places a photo at a position; nothing for a position past either end, a photo it does not have, or its own place", async () => {
    const seen = serve(
      listing(() => json(list(1, 2, 3))),
      ordered,
    );
    const { result } = await ready();
    await act(async () => result.current.moveTo(0, 2));
    expect(ids(result.current)?.map(([id]) => id)).toEqual([photo(2).id, photo(3).id, photo(1).id]);
    await act(async () => result.current.moveTo(1, 1));
    await act(async () => result.current.moveTo(3, 0));
    await act(async () => result.current.moveTo(0, 3));
    await act(async () => result.current.moveTo(0, -1));
    expect(writes(seen)).toHaveLength(1);
  });

  it("takes the order back from the API when it refuses the new one, and says why", async () => {
    const seen = serve(
      listing(() => json(list(1, 2))),
      (r) => (r.method === "PUT" ? refusal("photo_order_invalid", 422) : null),
    );
    const { result } = await ready();
    await act(async () => result.current.makeMain(photo(2).id));
    expect(result.current.notice).toEqual({ kind: "error", code: "photo_order_invalid" });
    expect(result.current.list).toEqual(list(1, 2));
    expect(seen.filter(isList)).toHaveLength(2);
    expect(result.current.busy).toEqual({ kind: "idle" });
  });

  it("does nothing to the order while there is no list", async () => {
    const seen = serve(
      listing(() => refusal("internal_error", 500)),
      ordered,
    );
    const { result } = await ready();
    await act(async () => result.current.move(photo(1).id, 1));
    await act(async () => result.current.makeMain(photo(2).id));
    expect(writes(seen)).toHaveLength(0);
  });
});
