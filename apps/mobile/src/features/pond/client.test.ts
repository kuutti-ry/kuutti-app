import { saveSession } from "@/lib/session";
import { choosePond, fetchGate, fetchPonds, fetchWaitlist } from "./client";

// The pond as the app reads it (#54, #94, #174): each route parsed by its
// contract, and an answer without data an ApiError with the status.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number) =>
  json({ error: { code: "x", message: "x", requestId: "r" } }, status);

const POND = {
  id: "5f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a00",
  slug: "espoo",
  name: "Espoo",
  nameInessive: "Espoossa",
  parentId: null,
};

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

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the pond client", () => {
  it("reads the public waitlist without the session", async () => {
    const waitlist = { k: 10, ponds: [] };
    const seen = answering(json(waitlist), refusal(503));
    expect(await fetchWaitlist()).toEqual(waitlist);
    expect(pathOf(seen[0])).toBe("/waitlist");
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    await expect(fetchWaitlist()).rejects.toMatchObject({
      status: 503,
      message: "waitlist answered 503",
    });
  });

  it("reads the person's place at the gate with the session", async () => {
    const gate = { state: "open", within: null, needed: null, step: 10 };
    const seen = answering(json(gate), refusal(503));
    expect(await fetchGate()).toEqual(gate);
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${token("access")}`);
    await expect(fetchGate()).rejects.toMatchObject({
      status: 503,
      message: "gate answered 503",
    });
  });

  it("lists the ponds to choose from", async () => {
    const seen = answering(json({ ponds: [POND] }), refusal(500));
    expect(await fetchPonds()).toEqual({ ponds: [POND] });
    expect(pathOf(seen[0])).toBe("/ponds");
    await expect(fetchPonds()).rejects.toMatchObject({
      status: 500,
      message: "ponds answered 500",
    });
  });

  it("chooses a pond by its id, and fails a refusal", async () => {
    const seen = answering(new Response(null, { status: 204 }), refusal(404));
    await expect(choosePond(POND.id)).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("PUT");
    expect(pathOf(seen[0])).toBe("/account/pond");
    expect(JSON.parse(await (seen[0] as Request).text())).toEqual({ pondId: POND.id });
    await expect(choosePond(POND.id)).rejects.toMatchObject({
      status: 404,
      message: "pond answered 404",
    });
  });
});
