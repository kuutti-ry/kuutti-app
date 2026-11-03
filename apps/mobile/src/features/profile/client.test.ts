import type { PreferencesUpdate } from "@kuutti/schema";
import { ApiError } from "@/lib/api";
import { saveSession } from "@/lib/session";
import {
  fetchCardPreview,
  fetchDealBreakers,
  fetchOwnGender,
  fetchPreferences,
  fetchProfile,
  saveDealBreaker,
  saveGender,
  saveHome,
  savePreferences,
  saveProfile,
} from "./client";

// The profile routes as the app calls them (#47, #149, #542, #552): what each sends,
// the contract it parses, and a refusal as an ApiError with the envelope's code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const EMPTY = {
  profile: null,
  completeness: { complete: false, missing: ["photos"] },
  home: null,
};
const DEAL_BREAKERS = { dealBreakers: [], max: 3 };
const PREFERENCES = { seeks: ["woman", "non_binary"], ageWindow: { min: 30, max: 40 } };
const FROM = "2026-12-01T12:00:00.000Z";
const STATUS = {
  state: "active",
  age: 36,
  gender: "woman",
  home: null,
  preferences: PREFERENCES,
  consents: { terms: "v1", privacy: "v1", specialCategory: "s1", research: null },
  currentVersions: { terms: "v1", privacy: "v1", research: "v1", special_category: "s1" },
  nextChange: { gender: FROM },
  missing: [],
  complete: true,
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
    refreshToken: `${token("family")}.${token("refresh")}`,
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

  it("saves what the screen makes of the document stored when the save goes, and answers what the API stored (#238)", async () => {
    const update = { displayName: "Aino", bio: null, bioPreset: null, fields: {}, prompts: [] };
    const stored = {
      profile: {
        ...update,
        hiddenFields: [],
        specialCategoryConsent: null,
        updatedAt: "2026-09-26T10:00:00.000Z",
      },
      completeness: EMPTY.completeness,
      home: null,
    };
    const seen = answering(
      json(stored),
      json(EMPTY),
      json(EMPTY),
      refusal("validation_failed", 422),
    );
    const build = jest.fn(() => ({ ...update, displayName: "Aino K" }));
    expect(await saveProfile(build)).toEqual(EMPTY);
    expect(seen.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      "GET /profile",
      "PUT /profile",
    ]);
    expect(build).toHaveBeenCalledWith(stored.profile);
    expect(JSON.parse(await (seen[1] as Request).text())).toEqual({
      ...update,
      displayName: "Aino K",
    });
    // Before the first save nothing is stored, and the screen builds on nothing.
    const first = jest.fn(() => update);
    await expect(saveProfile(first)).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
      message: "profile save answered 422",
    });
    expect(first).toHaveBeenCalledWith(null);
  });

  describe("saveHome (ADR-061)", () => {
    const HOME = {
      town: { fi: "Helsinki", sv: "Helsingfors" },
      area: { fi: "Kallio", sv: "Berghäll" },
      showArea: false,
    };

    it.each([
      ["a new postal code", { postalCode: "00530" }],
      ["what the card shows", { showArea: true }],
      ["both", { postalCode: "00530", showArea: true }],
    ])(
      "sends %s in the body and nowhere else, and answers what the API kept",
      async (_what, update) => {
        const seen = answering(json(HOME));
        expect(await saveHome(update)).toEqual(HOME);
        expect(seen[0]?.method).toBe("PUT");
        expect(pathOf(seen[0])).toBe("/account/home");
        expect(new URL(seen[0]?.url ?? "").search).toBe("");
        expect(JSON.parse(await (seen[0] as Request).text())).toEqual(update);
      },
    );

    it("fails a refusal with its code, which the screens say in words", async () => {
      answering(refusal("postal_code_unknown", 400));
      await expect(saveHome({ postalCode: "99999" })).rejects.toMatchObject({
        name: "ApiError",
        status: 400,
        code: "postal_code_unknown",
        message: "home answered 400",
      });
    });

    it("never repeats the digits in what it throws", async () => {
      answering(refusal("postal_code_unknown", 400));
      const failure = await saveHome({ postalCode: "99999" }).catch((error: Error) => error);
      expect(String((failure as Error).message)).not.toContain("99999");
    });

    it("refuses an answer outside the contract", async () => {
      answering(json({ town: "Helsinki" }));
      await expect(saveHome({ showArea: true })).rejects.toThrow();
    });

    it("keeps its place in the line of saves: the list reads what was stored", async () => {
      let answer: ((response: Response) => void) | undefined;
      const paths: string[] = [];
      globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        paths.push(`${request.method} ${pathOf(request)}`);
        if (request.method === "PUT") {
          return new Promise<Response>((resolve) => {
            answer = resolve;
          });
        }
        return json(EMPTY);
      }) as unknown as typeof fetch;
      const saved = saveHome({ showArea: true });
      const read = fetchProfile();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(paths).toEqual(["PUT /account/home"]);
      answer?.(json(HOME));
      await saved;
      await read;
      expect(paths).toEqual(["PUT /account/home", "GET /profile"]);
    });

    it("leaves the line open after a refusal", async () => {
      answering(refusal("internal_error", 500), json(EMPTY));
      await expect(saveHome({ showArea: true })).rejects.toMatchObject({ status: 500 });
      expect(await fetchProfile()).toEqual(EMPTY);
    });
  });

  describe("the person's own gender (#552)", () => {
    it("reads the gender with its limit from the status, and fails a refusal with its code", async () => {
      const seen = answering(json(STATUS), refusal("internal_error", 500));
      expect(await fetchOwnGender()).toEqual({ gender: "woman", nextChange: FROM });
      expect(seen[0]?.method).toBe("GET");
      expect(pathOf(seen[0])).toBe("/onboarding");
      await expect(fetchOwnGender()).rejects.toMatchObject({
        name: "ApiError",
        status: 500,
        code: "internal_error",
        message: "onboarding answered 500",
      });
    });

    it("reads no gender yet, and no limit, as none", async () => {
      answering(json({ ...STATUS, gender: null, nextChange: { gender: null } }));
      expect(await fetchOwnGender()).toEqual({ gender: null, nextChange: null });
    });

    it("refuses a read outside the contract", async () => {
      answering(json({ ...STATUS, gender: "robot" }));
      await expect(fetchOwnGender()).rejects.toThrow();
    });

    it("saves the gender, and says why the API refused one", async () => {
      const seen = answering(new Response(null, { status: 204 }), refusal("change_too_soon", 429));
      await expect(saveGender("woman")).resolves.toBeUndefined();
      await expect(saveGender("man")).rejects.toMatchObject({
        name: "ApiError",
        status: 429,
        code: "change_too_soon",
        message: "gender answered 429",
      });
      expect(seen.map((request) => [request.method, pathOf(request)])).toEqual([
        ["PUT", "/account/gender"],
        ["PUT", "/account/gender"],
      ]);
      expect(await seen[1]?.clone().json()).toEqual({ gender: "man" });
    });

    it("leaves the line open after a refusal", async () => {
      answering(refusal("change_too_soon", 429), json(EMPTY));
      await expect(saveGender("man")).rejects.toMatchObject({ status: 429 });
      expect(await fetchProfile()).toEqual(EMPTY);
    });
  });

  describe("what one seeks (#542)", () => {
    it("reads the answers, and fails a refusal with its code", async () => {
      const seen = answering(json(PREFERENCES), refusal("internal_error", 500));
      expect(await fetchPreferences()).toEqual(PREFERENCES);
      expect(seen[0]?.method).toBe("GET");
      expect(pathOf(seen[0])).toBe("/preferences");
      await expect(fetchPreferences()).rejects.toMatchObject({
        name: "ApiError",
        status: 500,
        code: "internal_error",
        message: "preferences answered 500",
      });
    });

    it("reads no answer yet as none, for the screens to send the person to onboarding", async () => {
      answering(json({ seeks: null, ageWindow: null }));
      expect(await fetchPreferences()).toEqual({ seeks: null, ageWindow: null });
    });

    it("leaves the code out when a refused read is not the error envelope", async () => {
      answering(new Response("Bad gateway", { status: 502 }));
      const error = await fetchPreferences().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 502, code: undefined });
    });

    it("refuses a read outside the contract", async () => {
      answering(json({ seeks: ["somebody"], ageWindow: null }));
      await expect(fetchPreferences()).rejects.toThrow();
    });

    it.each<[string, PreferencesUpdate]>([
      ["whom one seeks", { seeks: ["woman", "non_binary"] }],
      ["the ages", { ageWindow: { min: 30, max: 40 } }],
      ["both", { seeks: ["man"], ageWindow: { min: 18, max: 18 } }],
    ])("saves %s as given, and answers what the API stored", async (_what, update) => {
      const seen = answering(json(PREFERENCES));
      expect(await savePreferences(update)).toEqual(PREFERENCES);
      expect(seen[0]?.method).toBe("PUT");
      expect(pathOf(seen[0])).toBe("/preferences");
      expect(JSON.parse(await (seen[0] as Request).text())).toEqual(update);
    });

    it("says why the API refused a save: the code decides what the screens do with it", async () => {
      answering(refusal("consent_required", 403));
      await expect(savePreferences({ seeks: ["man"] })).rejects.toMatchObject({
        name: "ApiError",
        status: 403,
        code: "consent_required",
        message: "preferences answered 403",
      });
    });

    it("leaves the code out when a refused save is not the error envelope", async () => {
      answering(new Response("Bad gateway", { status: 502 }));
      const error = await savePreferences({ seeks: ["man"] }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 502, code: undefined });
    });

    it("refuses a save's answer outside the contract", async () => {
      answering(json({ seeks: "man", ageWindow: null }));
      await expect(savePreferences({ seeks: ["man"] })).rejects.toThrow();
    });
  });

  it("sends nothing when the stored document cannot be read first, and fails with that read's code", async () => {
    const seen = answering(refusal("internal_error", 500));
    const build = jest.fn();
    await expect(saveProfile(build)).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      message: "profile answered 500",
    });
    expect(build).not.toHaveBeenCalled();
    expect(seen.map((request) => request.method)).toEqual(["GET"]);
  });

  it("reads a card photo's description less a key this build cannot say (#296)", async () => {
    const description = {
      people: 1,
      setting: "indoors",
      scene: ["sauna"],
      objects: [],
      smile: false,
      glasses: false,
      sunglasses: false,
      facialHair: true,
    };
    const card = {
      accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      displayName: "Aino",
      age: { years: 36, verifiedByBank: true },
      gender: null,
      place: null,
      photos: [
        {
          id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
          blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          width: 1200,
          height: 1600,
          caption: null,
          description: { ...description, scene: ["sauna", "spaceship"] },
        },
      ],
      fields: {},
      bio: null,
      bioPreset: null,
      prompts: [],
      shared: { hobbies: [], languages: [] },
    };
    answering(json({ card, completeness: { complete: true, missing: [] } }));
    expect((await fetchCardPreview()).card?.photos[0]?.description).toEqual(description);
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

  it("reads a deal-breaker on height as the contract has it (#508)", async () => {
    const height = { field: "height", accept: ["taller"], includeUnknown: true, paused: false };
    answering(json({ dealBreakers: [height], max: 6 }));
    expect(await fetchDealBreakers()).toEqual({ dealBreakers: [height], max: 6 });
  });

  describe("saveDealBreaker (#551)", () => {
    const smoking = { field: "smoking", accept: ["never"], includeUnknown: false };
    const kids = { field: "hasKids", accept: ["no"], includeUnknown: true };
    const asRead = (...rows: { field: string }[]) => ({
      dealBreakers: rows.map((row) => ({ paused: false, ...row })),
      max: 7,
    });
    const sentIn = async (request: Request | undefined) =>
      JSON.parse(await (request as Request).text()) as unknown;

    it("reads the set, then sends it with the one field in place, and answers what the API stored", async () => {
      const stored = asRead(kids, smoking);
      const seen = answering(json(asRead(smoking, kids)), json(stored));
      const filter = { accept: ["never"], includeUnknown: false };
      expect(await saveDealBreaker("smoking", filter)).toEqual(stored);
      expect(seen.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
        "GET /preferences/deal-breakers",
        "PUT /preferences/deal-breakers",
      ]);
      expect(await sentIn(seen[1])).toEqual({ dealBreakers: [kids, smoking] });
    });

    it("adds a field the set does not hold", async () => {
      const seen = answering(json(asRead(kids)), json(asRead(kids, smoking)));
      await saveDealBreaker("smoking", { accept: ["never"], includeUnknown: false });
      expect(await sentIn(seen[1])).toEqual({ dealBreakers: [kids, smoking] });
    });

    it("takes a field off with nothing accepted, the rest kept", async () => {
      const seen = answering(json(asRead(smoking, kids)), json(asRead(kids)));
      await saveDealBreaker("smoking", { accept: [], includeUnknown: true });
      expect(await sentIn(seen[1])).toEqual({ dealBreakers: [kids] });
    });

    it("sends a paused filter back as it stands: the pause is the key, never the row", async () => {
      const paused = { ...smoking, paused: true };
      const seen = answering(
        json({ dealBreakers: [paused], max: 7 }),
        json({ dealBreakers: [paused], max: 7 }),
      );
      await saveDealBreaker("hasKids", { accept: ["no"], includeUnknown: true });
      expect(await sentIn(seen[1])).toEqual({ dealBreakers: [smoking, kids] });
    });

    it("sends nothing when the set cannot be read first, and fails with that read's code", async () => {
      const seen = answering(refusal("internal_error", 500));
      await expect(
        saveDealBreaker("smoking", { accept: ["never"], includeUnknown: false }),
      ).rejects.toMatchObject({
        status: 500,
        code: "internal_error",
        message: "deal-breakers answered 500",
      });
      expect(seen).toHaveLength(1);
    });

    it("fails a refusal with its code, which the screen says in words", async () => {
      answering(json(asRead()), refusal("filter_unanswered", 409));
      await expect(
        saveDealBreaker("smoking", { accept: ["never"], includeUnknown: false }),
      ).rejects.toMatchObject({
        status: 409,
        code: "filter_unanswered",
        message: "deal-breakers save answered 409",
      });
    });

    it("refuses an answer outside the contract", async () => {
      answering(json(asRead()), json({ dealBreakers: "none" }));
      await expect(
        saveDealBreaker("smoking", { accept: ["never"], includeUnknown: false }),
      ).rejects.toThrow();
    });
  });
});

describe("the profile client: a save on its way (#238)", () => {
  const update = { displayName: "Aino", bio: null, bioPreset: null, fields: {}, prompts: [] };
  /** A fetch that answers only when the test says, so the order of the requests shows. */
  function holding() {
    const waiting: Array<{ request: Request; answer: (response: Response) => void }> = [];
    globalThis.fetch = jest.fn((input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new Promise<Response>((answer) => waiting.push({ request, answer }));
    }) as unknown as typeof fetch;
    return waiting;
  }
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const sent = (waiting: ReturnType<typeof holding>) =>
    waiting.map(({ request }) => `${request.method} ${pathOf(request)}`);

  it("holds a read of the profile, the card or the deal-breakers until the save before it has landed", async () => {
    const waiting = holding();
    const save = saveProfile(() => update);
    const reads = [fetchProfile(), fetchCardPreview(), fetchDealBreakers()];
    await flush();
    expect(sent(waiting)).toEqual(["GET /profile"]);
    waiting[0]?.answer(json(EMPTY));
    await flush();
    expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile"]);
    waiting[1]?.answer(json(EMPTY));
    expect(await save).toEqual(EMPTY);
    await flush();
    expect(sent(waiting)).toEqual([
      "GET /profile",
      "PUT /profile",
      "GET /profile",
      "GET /profile/card",
      "GET /preferences/deal-breakers",
    ]);
    for (const { answer } of waiting.slice(2)) answer(refusal("internal_error", 500));
    for (const read of reads) await expect(read).rejects.toBeInstanceOf(ApiError);
  });

  it("reads for a second save only once the first has its answer, and a refused one holds up nothing after it", async () => {
    const waiting = holding();
    const first = saveProfile(() => update);
    const second = saveProfile(() => ({ ...update, displayName: "Aino K" }));
    await flush();
    expect(sent(waiting)).toEqual(["GET /profile"]);
    waiting[0]?.answer(json(EMPTY));
    await flush();
    expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile"]);
    waiting[1]?.answer(refusal("text_contact_details", 400));
    await expect(first).rejects.toMatchObject({ code: "text_contact_details" });
    await flush();
    // The second reads what is stored after the first: it builds on that, never on what was before.
    expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile", "GET /profile"]);
    waiting[2]?.answer(json(EMPTY));
    await flush();
    expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile", "GET /profile", "PUT /profile"]);
    expect(JSON.parse(await (waiting[3] as (typeof waiting)[number]).request.text())).toMatchObject(
      {
        displayName: "Aino K",
      },
    );
    waiting[3]?.answer(json(EMPTY));
    expect(await second).toEqual(EMPTY);
    const read = fetchProfile();
    await flush();
    waiting[4]?.answer(json(EMPTY));
    expect(await read).toEqual(EMPTY);
  });

  it("lets a read through at once when a save failed on the network", async () => {
    const waiting = holding();
    const save = saveProfile(() => update);
    await flush();
    globalThis.fetch = jest.fn(async () => json(EMPTY)) as unknown as typeof fetch;
    waiting[0]?.answer(Promise.reject(new TypeError("Network request failed")) as never);
    await expect(save).rejects.toBeInstanceOf(TypeError);
    expect(await fetchProfile()).toEqual(EMPTY);
  });

  describe("a deal-breaker, in the same line (#551)", () => {
    const smoking = { field: "smoking", accept: ["never"], includeUnknown: true };
    const empty = { dealBreakers: [], max: 7 };

    it("waits for a save before it, and reads the set only when its turn comes", async () => {
      const waiting = holding();
      const first = saveProfile(() => update);
      const second = saveDealBreaker("smoking", { accept: ["never"], includeUnknown: true });
      await flush();
      expect(sent(waiting)).toEqual(["GET /profile"]);
      waiting[0]?.answer(json(EMPTY));
      await flush();
      waiting[1]?.answer(json(EMPTY));
      await first;
      await flush();
      expect(sent(waiting).slice(2)).toEqual(["GET /preferences/deal-breakers"]);
      waiting[2]?.answer(json(empty));
      await flush();
      expect(sent(waiting).slice(3)).toEqual(["PUT /preferences/deal-breakers"]);
      waiting[3]?.answer(json({ dealBreakers: [{ ...smoking, paused: false }], max: 7 }));
      await second;
    });

    it("holds every read until it has landed, so the list shows what was stored", async () => {
      const waiting = holding();
      const save = saveDealBreaker("smoking", { accept: ["never"], includeUnknown: true });
      const read = fetchDealBreakers();
      const profile = fetchProfile();
      await flush();
      expect(sent(waiting)).toEqual(["GET /preferences/deal-breakers"]);
      waiting[0]?.answer(json(empty));
      await flush();
      expect(sent(waiting).slice(1)).toEqual(["PUT /preferences/deal-breakers"]);
      const stored = { dealBreakers: [{ ...smoking, paused: false }], max: 7 };
      waiting[1]?.answer(json(stored));
      await save;
      await flush();
      expect(sent(waiting).slice(2).sort()).toEqual([
        "GET /preferences/deal-breakers",
        "GET /profile",
      ]);
      for (const { answer, request } of waiting.slice(2)) {
        answer(pathOf(request) === "/profile" ? json(EMPTY) : json(stored));
      }
      expect(await read).toEqual(stored);
      await profile;
    });

    it("never waits for itself: its own read goes straight through", async () => {
      const waiting = holding();
      const save = saveDealBreaker("smoking", { accept: ["never"], includeUnknown: true });
      await flush();
      expect(sent(waiting)).toEqual(["GET /preferences/deal-breakers"]);
      waiting[0]?.answer(json(empty));
      await flush();
      waiting[1]?.answer(json(empty));
      await save;
    });

    it("holds up nothing after it when it is refused", async () => {
      const waiting = holding();
      const save = saveDealBreaker("smoking", { accept: ["never"], includeUnknown: true });
      const read = fetchDealBreakers();
      await flush();
      waiting[0]?.answer(refusal("internal_error", 500));
      await expect(save).rejects.toBeInstanceOf(ApiError);
      await flush();
      expect(sent(waiting).slice(1)).toEqual(["GET /preferences/deal-breakers"]);
      waiting[1]?.answer(json(empty));
      expect(await read).toEqual(empty);
    });

    it("lets a later save go after it, two saves never landing out of order", async () => {
      const waiting = holding();
      const first = saveDealBreaker("smoking", { accept: ["never"], includeUnknown: true });
      const second = saveDealBreaker("hasKids", { accept: ["no"], includeUnknown: true });
      await flush();
      expect(sent(waiting)).toEqual(["GET /preferences/deal-breakers"]);
      waiting[0]?.answer(json(empty));
      await flush();
      const one = { dealBreakers: [{ ...smoking, paused: false }], max: 7 };
      waiting[1]?.answer(json(one));
      await first;
      await flush();
      expect(sent(waiting).slice(2)).toEqual(["GET /preferences/deal-breakers"]);
      waiting[2]?.answer(json(one));
      await flush();
      expect(JSON.parse((await waiting[3]?.request.text()) as string)).toEqual({
        dealBreakers: [smoking, { field: "hasKids", accept: ["no"], includeUnknown: true }],
      });
      waiting[3]?.answer(json(one));
      await second;
    });
  });

  describe("the gender, in the same line (#552)", () => {
    it("holds a read of the gender until a save has landed: the row shows what was stored", async () => {
      const waiting = holding();
      const save = saveGender("man");
      const read = fetchOwnGender();
      await flush();
      expect(sent(waiting)).toEqual(["PUT /account/gender"]);
      waiting[0]?.answer(new Response(null, { status: 204 }));
      await save;
      await flush();
      expect(sent(waiting)).toEqual(["PUT /account/gender", "GET /onboarding"]);
      waiting[1]?.answer(json({ ...STATUS, gender: "man" }));
      expect((await read).gender).toBe("man");
    });

    it("holds every read of the profile until the gender has landed, as the API takes a word with it", async () => {
      const waiting = holding();
      const save = saveGender("woman");
      const read = fetchProfile();
      await flush();
      expect(sent(waiting)).toEqual(["PUT /account/gender"]);
      waiting[0]?.answer(new Response(null, { status: 204 }));
      await save;
      await flush();
      expect(sent(waiting)).toEqual(["PUT /account/gender", "GET /profile"]);
      waiting[1]?.answer(json(EMPTY));
      await read;
    });

    it("waits for a save before it", async () => {
      const waiting = holding();
      const first = saveProfile(() => update);
      const second = saveGender("man");
      await flush();
      expect(sent(waiting)).toEqual(["GET /profile"]);
      waiting[0]?.answer(json(EMPTY));
      await flush();
      waiting[1]?.answer(json(EMPTY));
      await first;
      await flush();
      expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile", "PUT /account/gender"]);
      waiting[2]?.answer(new Response(null, { status: 204 }));
      await second;
    });
  });

  describe("what one seeks, in the same line (#542)", () => {
    const bodyOf = async (waiting: ReturnType<typeof holding>, index: number) =>
      JSON.parse(await (waiting[index] as (typeof waiting)[number]).request.text());

    it("holds a read of the answers until a section's save has landed: the list shows what was stored", async () => {
      const waiting = holding();
      const save = saveProfile(() => update);
      const read = fetchPreferences();
      await flush();
      expect(sent(waiting)).toEqual(["GET /profile"]);
      waiting[0]?.answer(json(EMPTY));
      await flush();
      expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile"]);
      waiting[1]?.answer(json(EMPTY));
      await save;
      await flush();
      expect(sent(waiting)).toEqual(["GET /profile", "PUT /profile", "GET /preferences"]);
      waiting[2]?.answer(json(PREFERENCES));
      expect(await read).toEqual(PREFERENCES);
    });

    it("holds every read until a save of the answers has landed", async () => {
      const waiting = holding();
      const save = savePreferences({ seeks: ["man"] });
      const reads = [fetchPreferences(), fetchProfile(), fetchCardPreview(), fetchDealBreakers()];
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences"]);
      waiting[0]?.answer(json(PREFERENCES));
      expect(await save).toEqual(PREFERENCES);
      await flush();
      expect(sent(waiting).slice(1).sort()).toEqual([
        "GET /preferences",
        "GET /preferences/deal-breakers",
        "GET /profile",
        "GET /profile/card",
      ]);
      for (const { answer } of waiting.slice(1)) answer(refusal("internal_error", 500));
      for (const read of reads) await expect(read).rejects.toBeInstanceOf(ApiError);
    });

    it("lands two saves in the order they were made, the second only once the first has its answer", async () => {
      const waiting = holding();
      const first = savePreferences({ seeks: ["man"] });
      const second = savePreferences({ ageWindow: { min: 30, max: 40 } });
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences"]);
      expect(await bodyOf(waiting, 0)).toEqual({ seeks: ["man"] });
      waiting[0]?.answer(json(PREFERENCES));
      await first;
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences", "PUT /preferences"]);
      expect(await bodyOf(waiting, 1)).toEqual({ ageWindow: { min: 30, max: 40 } });
      waiting[1]?.answer(json(PREFERENCES));
      expect(await second).toEqual(PREFERENCES);
    });

    it("takes its turn among a section's saves, whichever goes first", async () => {
      const waiting = holding();
      const preferences = savePreferences({ seeks: ["man"] });
      const section = saveProfile(() => update);
      const after = savePreferences({ ageWindow: { min: 30, max: 40 } });
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences"]);
      waiting[0]?.answer(json(PREFERENCES));
      await preferences;
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences", "GET /profile"]);
      waiting[1]?.answer(json(EMPTY));
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences", "GET /profile", "PUT /profile"]);
      waiting[2]?.answer(json(EMPTY));
      await section;
      await flush();
      expect(sent(waiting).at(-1)).toBe("PUT /preferences");
      waiting[3]?.answer(json(PREFERENCES));
      expect(await after).toEqual(PREFERENCES);
    });

    it("lets the next save and the read after it through when one is refused", async () => {
      const waiting = holding();
      const refused = savePreferences({ seeks: ["man"] });
      const next = savePreferences({ seeks: ["woman"] });
      const read = fetchPreferences();
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences"]);
      waiting[0]?.answer(refusal("consent_required", 403));
      await expect(refused).rejects.toMatchObject({ code: "consent_required" });
      await flush();
      expect(sent(waiting)).toEqual(["PUT /preferences", "PUT /preferences"]);
      expect(await bodyOf(waiting, 1)).toEqual({ seeks: ["woman"] });
      waiting[1]?.answer(json(PREFERENCES));
      expect(await next).toEqual(PREFERENCES);
      await flush();
      waiting[2]?.answer(json(PREFERENCES));
      expect(await read).toEqual(PREFERENCES);
      expect(sent(waiting)).toEqual(["PUT /preferences", "PUT /preferences", "GET /preferences"]);
    });

    it("lets the next through when one failed on the network", async () => {
      const waiting = holding();
      const lost = savePreferences({ seeks: ["man"] });
      await flush();
      globalThis.fetch = jest.fn(async () => json(PREFERENCES)) as unknown as typeof fetch;
      waiting[0]?.answer(Promise.reject(new TypeError("Network request failed")) as never);
      await expect(lost).rejects.toBeInstanceOf(TypeError);
      expect(await savePreferences({ seeks: ["woman"] })).toEqual(PREFERENCES);
      expect(await fetchPreferences()).toEqual(PREFERENCES);
    });
  });
});
