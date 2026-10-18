import { saveSession } from "@/lib/session";
import { fetchChoices, fetchNotices, markNoticeRead, saveChoice } from "./client";

// The notifications routes as the app calls them (#176): methods, paths, the
// body, the answers parsed, and a refusal as an ApiError with its code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const CHOICES = {
  choices: [
    { kind: "round", enabled: true },
    { kind: "message", enabled: false },
    { kind: "match", enabled: true },
    { kind: "moderation", enabled: true },
  ],
};
const NOTICE = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "warning",
  at: "2026-10-18T09:00:00.000Z",
  readAt: null,
  reason: "other",
};

type Seen = { method: string; path: string; body: unknown };
function answering(...answers: Response[]): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : null,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("no answer prepared");
    return answer;
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the notifications client", () => {
  it("reads and saves the choices, the kind in the path and the state in the body", async () => {
    const seen = answering(json(CHOICES), json(CHOICES), refusal("not_found", 404));
    expect(await fetchChoices()).toEqual(CHOICES);
    expect(await saveChoice("message", false)).toEqual(CHOICES);
    expect(seen).toEqual([
      { method: "GET", path: "/account/notifications", body: null },
      { method: "PUT", path: "/account/notifications/message", body: { enabled: false } },
    ]);
    await expect(saveChoice("match", true)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("reads the notices and marks one read, and fails a refusal with its code", async () => {
    const seen = answering(
      json({ notices: [NOTICE] }),
      new Response(null, { status: 204 }),
      refusal("not_found", 404),
      new Response("Bad Gateway", { status: 502 }),
      new Response("Bad Gateway", { status: 502 }),
    );
    expect(await fetchNotices()).toEqual({ notices: [NOTICE] });
    await expect(markNoticeRead(NOTICE.id)).resolves.toBeUndefined();
    expect(seen[1]).toEqual({ method: "POST", path: `/notices/${NOTICE.id}/read`, body: null });
    await expect(markNoticeRead(NOTICE.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(fetchNotices()).rejects.toMatchObject({ status: 502, code: undefined });
    await expect(fetchChoices()).rejects.toMatchObject({ status: 502 });
  });
});
