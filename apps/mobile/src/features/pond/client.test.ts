import { saveSession } from "@/lib/session";
import { fetchGate, fetchPondCounter } from "./client";

// The pond as the app reads it (#54, #94): each route parsed by its
// contract, and an answer without data an ApiError with the status.

const POND = {
  id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
  slug: "suomi",
  name: "Suomi",
  nameInessive: "Suomessa",
  parentId: null,
};
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number) =>
  json({ error: { code: "x", message: "x", requestId: "r" } }, status);

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
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the pond client", () => {
  it("reads the counter with the session, which is what gives the person's pond its bar", async () => {
    const seeks = { men: 30, everyone: 20, women: 50 };
    const entry = { pond: POND, day: null, verified: null, split: null, finishing: null, seeks };
    const counter = { k: 10, ponds: [entry] };
    const seen = answering(json(counter), refusal(503));
    expect(await fetchPondCounter()).toEqual(counter);
    expect(pathOf(seen[0])).toBe("/ponds/counter");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${token("access")}`);
    await expect(fetchPondCounter()).rejects.toMatchObject({
      status: 503,
      message: "counter answered 503",
    });
  });

  it("reads whether matching is open with the session", async () => {
    const gate = { state: "open" };
    const seen = answering(json(gate), refusal(503));
    expect(await fetchGate()).toEqual(gate);
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${token("access")}`);
    await expect(fetchGate()).rejects.toMatchObject({
      status: 503,
      message: "gate answered 503",
    });
  });

  it("refuses shares that break the contract", async () => {
    const seeks = { men: 0, everyone: 20, women: 80 };
    const entry = { pond: POND, day: null, verified: null, split: null, finishing: null, seeks };
    answering(json({ k: 10, ponds: [entry] }));
    await expect(fetchPondCounter()).rejects.toThrow();
  });
});
