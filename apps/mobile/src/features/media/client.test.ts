import { Platform } from "react-native";
import { ApiError } from "@/lib/api";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import { FakeXhr, partsOf } from "@/test/xhr";
import {
  appealPhoto,
  deletePhoto,
  fetchPhotoUrl,
  listPhotos,
  reorderPhotos,
  uploadPhoto,
} from "./client";

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const stored = {
  id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4c",
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 1600,
  height: 1200,
  state: "pending",
  rejectionReason: null,
  appealable: false,
  position: 0,
  createdAt: "2026-09-25T12:00:00.000Z",
};
const picked = {
  uri: "file:///cache/photo.jpg#resized",
  width: 1600,
  height: 1200,
  mimeType: "image/jpeg",
};

beforeEach(async () => {
  FakeXhr.install();
  await clearSession();
});

describe("uploading a photo", () => {
  it("posts the file as multipart with the session's token and reports progress", async () => {
    await saveSession(session);
    FakeXhr.answers = [{ status: 201, body: JSON.stringify(stored), progress: [25, 100] }];
    const seen: number[] = [];
    const photo = await uploadPhoto(picked, (fraction) => seen.push(fraction));
    expect(photo).toEqual(stored);
    expect(seen).toEqual([0.25, 1]);
    const sent = FakeXhr.sent[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toMatch(/\/photos$/);
    expect(sent?.headers.authorization).toBe(`Bearer ${session.accessToken}`);
    // The file reference React Native's FormData streams from disk: uri, name and type, no bytes in JavaScript.
    const parts = partsOf(sent);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      fieldName: "photo",
      uri: picked.uri,
      type: "image/jpeg",
      name: "photo.jpg",
    });
  });

  it("surfaces the API's code on a refusal", async () => {
    await saveSession(session);
    FakeXhr.answers = [
      {
        status: 409,
        body: JSON.stringify({ error: { code: "photo_limit", message: "x", requestId: "r" } }),
      },
    ];
    await expect(uploadPhoto(picked)).rejects.toMatchObject({ status: 409, code: "photo_limit" });
  });

  it("refuses to upload without a session and sends nothing", async () => {
    await expect(uploadPhoto(picked)).rejects.toMatchObject({ status: 401 });
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it("answers one 401 with one refresh and one retry", async () => {
    await saveSession(session);
    const refreshed = { ...session, accessToken: token("fresh"), refreshToken: token("fresh-r") };
    globalThis.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify(refreshed), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    FakeXhr.answers = [
      {
        status: 401,
        body: JSON.stringify({ error: { code: "session_expired", message: "x", requestId: "r" } }),
      },
      { status: 201, body: JSON.stringify(stored) },
    ];
    expect(await uploadPhoto(picked)).toEqual(stored);
    expect(FakeXhr.sent).toHaveLength(2);
    expect(FakeXhr.sent[1]?.headers.authorization).toBe(`Bearer ${refreshed.accessToken}`);
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
function answering(...answers: Response[]) {
  const seen: Request[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer prepared");
    return answer;
  }) as unknown as typeof fetch;
  return seen;
}
const pathOf = (request: Request | undefined) => new URL(request?.url ?? "").pathname;

/** An XMLHttpRequest that never answers: the network fails, or the request times out. */
class FailingXhr extends FakeXhr {
  static how: "error" | "timeout" = "error";
  override send(body: FormData | null): void {
    FakeXhr.sent.push({ method: "POST", url: "", headers: {}, body });
    setTimeout(() => (FailingXhr.how === "error" ? this.onerror?.() : this.ontimeout?.()), 0);
  }
}

/** An XMLHttpRequest whose progress events cannot say how far along they are. */
class UncountedXhr extends FakeXhr {
  override send(body: FormData | null): void {
    FakeXhr.sent.push({ method: "POST", url: "", headers: {}, body });
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: false, loaded: 10, total: 0 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 0 });
      this.status = 201;
      this.responseText = JSON.stringify(stored);
      this.onload?.();
    }, 0);
  }
}

describe("the photo routes", () => {
  beforeEach(async () => {
    await saveSession(session);
  });

  it("lists the photos, and fails a refusal with its code", async () => {
    const list = { photos: [stored], maxPhotos: 6 };
    answering(json(list), refusal("internal_error", 500));
    expect(await listPhotos()).toEqual(list);
    await expect(listPhotos()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      code: "internal_error",
      message: "photos answered 500",
    });
  });

  it("asks a person to look at a photo by its id, and fails a refusal with its code (#253)", async () => {
    const queued = { ...stored, state: "queued" };
    const seen = answering(json(queued), refusal("photo_not_appealable", 409));
    expect(await appealPhoto(stored.id)).toEqual(queued);
    expect(seen[0]?.method).toBe("POST");
    expect(pathOf(seen[0])).toBe(`/photos/${stored.id}/appeal`);
    await expect(appealPhoto(stored.id)).rejects.toMatchObject({
      status: 409,
      code: "photo_not_appealable",
      message: "photo appeal answered 409",
    });
  });

  it("removes a photo by its id, and fails a refusal", async () => {
    const seen = answering(new Response(null, { status: 204 }), refusal("not_found", 404));
    await expect(deletePhoto(stored.id)).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("DELETE");
    expect(pathOf(seen[0])).toBe(`/photos/${stored.id}`);
    await expect(deletePhoto(stored.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("sends a new order, answers the renumbered list, and fails a refusal", async () => {
    const list = { photos: [stored], maxPhotos: 6 };
    const seen = answering(json(list), refusal("photo_order_invalid", 422));
    expect(await reorderPhotos([stored.id])).toEqual(list);
    expect(JSON.parse(await (seen[0] as Request).text())).toEqual({ order: [stored.id] });
    await expect(reorderPhotos([stored.id])).rejects.toMatchObject({
      status: 422,
      code: "photo_order_invalid",
    });
  });

  it("asks for one variant's URL, and fails the day's budget with its code", async () => {
    const url = {
      url: "https://media.test/media/k/thumb.webp?Signature=s",
      variant: "thumb",
      expiresAt: "2030-01-01T00:15:00.000Z",
    };
    const seen = answering(json(url), refusal("photo_budget_exceeded", 429));
    expect(await fetchPhotoUrl(stored.id, "thumb")).toEqual(url);
    expect(pathOf(seen[0])).toBe(`/photos/${stored.id}/thumb`);
    await expect(fetchPhotoUrl(stored.id, "full")).rejects.toMatchObject({
      status: 429,
      code: "photo_budget_exceeded",
    });
  });

  it("has no code for a refusal that is not the error envelope", async () => {
    answering(new Response("Bad gateway", { status: 502 }));
    const error = await listPhotos().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: undefined });
  });
});

describe("uploading a photo, the rest of the way", () => {
  afterEach(() => jest.restoreAllMocks());

  it("refreshes an access token about to expire before it sends", async () => {
    await saveSession({ ...session, accessExpiresAt: new Date(Date.now() + 5000).toISOString() });
    const refreshed = { ...session, accessToken: token("fresh") };
    answering(json(refreshed));
    FakeXhr.answers = [{ status: 201, body: JSON.stringify(stored) }];
    expect(await uploadPhoto(picked)).toEqual(stored);
    expect(FakeXhr.sent[0]?.headers.authorization).toBe(`Bearer ${refreshed.accessToken}`);
  });

  it("sends nothing when the refresh before it signs the device out", async () => {
    await saveSession({ ...session, accessExpiresAt: new Date(Date.now() + 5000).toISOString() });
    answering(refusal("session_revoked", 401));
    await expect(uploadPhoto(picked)).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    expect(FakeXhr.sent).toHaveLength(0);
    expect(currentSession()).toBeNull();
  });

  it("gives up as signed out when the refresh after a 401 is refused, without a second upload", async () => {
    await saveSession(session);
    answering(refusal("session_revoked", 401));
    FakeXhr.answers = [
      {
        status: 401,
        body: JSON.stringify({ error: { code: "session_expired", message: "x", requestId: "r" } }),
      },
    ];
    await expect(uploadPhoto(picked)).rejects.toMatchObject({
      status: 401,
      code: "session_revoked",
    });
    expect(FakeXhr.sent).toHaveLength(1);
  });

  it("fails when the network fails or the request times out", async () => {
    await saveSession(session);
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FailingXhr;
    FailingXhr.how = "error";
    await expect(uploadPhoto(picked)).rejects.toMatchObject({ message: "photo upload failed" });
    FailingXhr.how = "timeout";
    await expect(uploadPhoto(picked)).rejects.toMatchObject({
      message: "photo upload timed out",
    });
  });

  it("reports no progress it cannot count", async () => {
    await saveSession(session);
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = UncountedXhr;
    const seen: number[] = [];
    expect(await uploadPhoto(picked, (fraction) => seen.push(fraction))).toEqual(stored);
    expect(seen).toEqual([]);
  });

  it("uploads without a progress listener", async () => {
    await saveSession(session);
    FakeXhr.answers = [{ status: 201, body: JSON.stringify(stored), progress: [100] }];
    expect(await uploadPhoto(picked)).toEqual(stored);
  });

  it("has no code for a refusal with an empty body or one that is not JSON", async () => {
    await saveSession(session);
    FakeXhr.answers = [
      { status: 413, body: "" },
      { status: 502, body: "<html>Bad gateway</html>" },
    ];
    await expect(uploadPhoto(picked)).rejects.toMatchObject({
      status: 413,
      code: undefined,
      message: "photo upload answered 413",
    });
    await expect(uploadPhoto(picked)).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it("on the web preview, sends the picked file's bytes rather than a file reference", async () => {
    await saveSession(session);
    jest.replaceProperty(Platform, "OS", "web");
    const seen = answering(new Response(new Blob(["jpeg bytes"], { type: "image/jpeg" })));
    FakeXhr.answers = [{ status: 201, body: JSON.stringify(stored) }];
    expect(await uploadPhoto({ ...picked, uri: "blob:http://localhost/1" })).toEqual(stored);
    expect(seen[0]?.url).toBe("blob:http://localhost/1");
    const parts = partsOf(FakeXhr.sent[0]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ fieldName: "photo" });
    expect(parts[0]?.uri).not.toBe(picked.uri);
  });
});
