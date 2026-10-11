import { ApiError } from "@/lib/api";
import { saveSession } from "@/lib/session";
import {
  consentLocale,
  declareGender,
  fetchConsents,
  fetchOnboarding,
  giveConsent,
  savePreferences,
  withdrawConsent,
} from "./client";

// The onboarding routes as the app calls them (#46): what each sends, the
// contract it parses, and the API's refusal as an ApiError with its code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const STATUS = {
  state: "active",
  age: 36,
  gender: "woman",
  pond: null,
  preferences: { seeks: ["man"], ageWindow: { min: 30, max: 40 } },
  consents: { terms: "v1", privacy: "v1", specialCategory: "s1", research: null },
  currentVersions: { terms: "v1", privacy: "v1", research: "v1", special_category: "s1" },
  nextChange: { gender: null, seeks: null },
  missing: [],
  complete: true,
};
const CONSENTS = {
  consents: [
    {
      kind: "terms",
      version: "v1",
      locale: "fi",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null,
    },
  ],
  currentVersions: STATUS.currentVersions,
};

type Seen = { method: string; path: string; body: unknown };
function answering(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    const call = {
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : undefined,
    };
    seen.push(call);
    return answer(call);
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

describe("the onboarding client", () => {
  it("reads the status and parses it", async () => {
    const seen = answering(() => json(STATUS));
    expect(await fetchOnboarding()).toEqual(STATUS);
    expect(seen).toEqual([{ method: "GET", path: "/onboarding", body: undefined }]);
  });

  it("turns a refused status read into an ApiError with the code", async () => {
    answering(() => refusal("account_gone", 410));
    await expect(fetchOnboarding()).rejects.toMatchObject({
      name: "ApiError",
      status: 410,
      code: "account_gone",
      message: "onboarding answered 410",
    });
  });

  it("leaves the code out when the answer is not the error envelope", async () => {
    answering(() => new Response("Bad gateway", { status: 502 }));
    const error = await fetchOnboarding().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: undefined });
  });

  it("declares the gender, and says why the API refused one", async () => {
    const seen = answering(({ body }) =>
      (body as { gender: string }).gender === "man"
        ? refusal("gender_change_too_soon", 429)
        : new Response(null, { status: 204 }),
    );
    await expect(declareGender("woman")).resolves.toBeUndefined();
    await expect(declareGender("man")).rejects.toMatchObject({
      status: 429,
      code: "gender_change_too_soon",
    });
    expect(seen.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", "/account/gender", { gender: "woman" }],
      ["PUT", "/account/gender", { gender: "man" }],
    ]);
  });

  it("saves the preferences as given, and says why the API refused them", async () => {
    let answer = new Response(null, { status: 204 });
    const seen = answering(() => answer);
    await savePreferences({ seeks: ["woman", "non_binary"] });
    expect(seen[0]).toEqual({
      method: "PUT",
      path: "/preferences",
      body: { seeks: ["woman", "non_binary"] },
    });
    answer = refusal("seeks_change_too_soon", 429);
    await expect(savePreferences({ ageWindow: { min: 30, max: 40 } })).rejects.toMatchObject({
      status: 429,
      code: "seeks_change_too_soon",
    });
  });

  it("reads the consents, and fails on a refusal", async () => {
    let answer = json(CONSENTS);
    answering(() => answer);
    expect(await fetchConsents()).toEqual(CONSENTS);
    answer = refusal("internal_error", 500);
    await expect(fetchConsents()).rejects.toMatchObject({ status: 500, code: "internal_error" });
  });

  it("gives a consent with its version and language, and fails on a refusal", async () => {
    let answer = json(CONSENTS);
    const seen = answering(() => answer);
    expect(await giveConsent("terms", "v1", "fi")).toEqual(CONSENTS);
    expect(seen[0]).toEqual({
      method: "POST",
      path: "/consents",
      body: { kind: "terms", version: "v1", locale: "fi" },
    });
    answer = refusal("consent_version_stale", 409);
    await expect(giveConsent("terms", "v0", "fi")).rejects.toMatchObject({
      status: 409,
      code: "consent_version_stale",
    });
  });

  it("withdraws a consent by its kind in the path, and fails on a refusal", async () => {
    let answer = json({ ...CONSENTS, consents: [] });
    const seen = answering(() => answer);
    expect((await withdrawConsent("research")).consents).toEqual([]);
    expect(seen[0]).toMatchObject({ method: "DELETE", path: "/consents/research" });
    answer = refusal("not_found", 404);
    await expect(withdrawConsent("special_category")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });
});

describe("consentLocale", () => {
  it("keeps Finnish and Swedish, and reads anything else, the pseudo-locale too, as English", () => {
    expect(consentLocale("fi")).toBe("fi");
    expect(consentLocale("sv")).toBe("sv");
    expect(consentLocale("en")).toBe("en");
    expect(consentLocale("en-XA")).toBe("en");
  });
});
