import { ApiError } from "@/lib/api";
import { saveSession } from "@/lib/session";
import {
  fetchCardPreview,
  fetchDealBreakers,
  fetchProfile,
  saveDealBreakers,
  saveProfile,
} from "./client";

// The profile routes as the app calls them (#47, #149): what each sends, the
// contract it parses, and a refusal as an ApiError with the envelope's code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const EMPTY = { profile: null, completeness: { complete: false, missing: ["photos"] }, tips: [] };
const DEAL_BREAKERS = { dealBreakers: [], max: 3 };

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

describe("the profile client", () => {
  it("reads the profile, and fails a refusal with its code", async () => {
    answering(json(EMPTY), refusal("internal_error", 500));
    expect(await fetchProfile()).toEqual(EMPTY);
    await expect(fetchProfile()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      code: "internal_error",
      message: "profile answered 500",
    });
  });

  it("saves the document and answers what the API stored", async () => {
    const update = { displayName: "Aino", bio: null, bioPreset: null, fields: {}, prompts: [] };
    const seen = answering(json(EMPTY), refusal("validation_failed", 422));
    expect(await saveProfile(update)).toEqual(EMPTY);
    expect(seen[0]?.method).toBe("PUT");
    expect(JSON.parse(await (seen[0] as Request).text())).toEqual(update);
    await expect(saveProfile(update)).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
      message: "profile save answered 422",
    });
  });

  it("reads the card preview, and fails a refusal", async () => {
    const preview = { card: null, completeness: { complete: false, missing: ["photos"] } };
    const seen = answering(json(preview), new Response("Bad gateway", { status: 502 }));
    expect(await fetchCardPreview()).toEqual(preview);
    expect(pathOf(seen[0])).toBe("/profile/card");
    const error = await fetchCardPreview().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    // Not the envelope: the status alone.
    expect(error).toMatchObject({ status: 502, code: undefined });
  });

  it("reads the deal-breakers, and fails a refusal", async () => {
    const seen = answering(json(DEAL_BREAKERS), refusal("internal_error", 500));
    expect(await fetchDealBreakers()).toEqual(DEAL_BREAKERS);
    expect(pathOf(seen[0])).toBe("/preferences/deal-breakers");
    await expect(fetchDealBreakers()).rejects.toMatchObject({
      status: 500,
      message: "deal-breakers answered 500",
    });
  });

  it("saves the deal-breakers, and fails a refusal with its code", async () => {
    const seen = answering(json(DEAL_BREAKERS), refusal("deal_breakers_limit", 422));
    expect(await saveDealBreakers({ dealBreakers: [] })).toEqual(DEAL_BREAKERS);
    expect(seen[0]?.method).toBe("PUT");
    expect(JSON.parse(await (seen[0] as Request).text())).toEqual({ dealBreakers: [] });
    await expect(saveDealBreakers({ dealBreakers: [] })).rejects.toMatchObject({
      status: 422,
      code: "deal_breakers_limit",
      message: "deal-breakers save answered 422",
    });
  });
});
