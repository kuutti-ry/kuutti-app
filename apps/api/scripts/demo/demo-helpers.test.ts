import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEMO_PERSONAS,
  MOCK_BANK_AMR,
  PERSONA_HISTORIES,
  type PersonaHistory,
  type PhotoAsset,
} from "@kuutti/db/demo";
import type { OnboardingStatus } from "@kuutti/schema";
import { afterAll, afterEach, it, vi } from "vitest";
import { hmacKeyFromHex } from "../../src/identity/index.ts";
import { signedInAccount } from "../../src/test/account.ts";
import { captureLogger, describe, expect, test } from "../../src/test/harness.ts";
import { fixtureJpeg, testMediaDeps } from "../../src/test/media.ts";
import { pondNamed } from "../../src/test/people.ts";
import { call, DemoError, type Fetch, loginAs, upload } from "./bank.ts";
import { giveHistory, type HistoryWriter, viaRoutes } from "./histories.ts";
import { loadAssets, uploadFaces } from "./photos.ts";
import { resetPersonas } from "./reset.ts";
import { giveStories, viaServices } from "./services.ts";

// The demo's helpers where they refuse or skip (#73, #141, #142): the answers
// of an API that is not as it should be, scripted, so each refusal is seen
// with the words it says; the database parts against the test database,
// inside the test's transaction. The walks that succeed are
// demo.mock-idp.test.ts, demo-stories.test.ts and demo-photos.test.ts.

const API = "http://localhost:3000";
const BANK = "http://127.0.0.1:8080/ftn/authorize";
const TOKEN = "T".repeat(43);
const ACCOUNT = "0b7d1f4e-3c2a-4e5f-8a9b-1c2d3e4f5a6b";
const NOWHERE_ACCOUNT = "00000000-0000-4000-8000-000000000000";
const NOW = new Date("2026-10-11T09:00:00.000Z");

const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** An API and a bank that answer by method and path; a route not named is a test's mistake. */
function scripted(overrides: Record<string, Route> = {}) {
  const calls: { route: string; init?: RequestInit }[] = [];
  const routes: Record<string, Route> = {
    "GET /auth/start": () => redirect(`${BANK}?state=state-1`),
    "POST /ftn/authorize": () => redirect(`${API}/auth/callback?code=bank-code&state=state-1`),
    "GET /auth/callback": () => redirect(`kuutti://auth?code=${"c".repeat(43)}`),
    "POST /auth/exchange": () =>
      json({
        outcome: "created",
        sessionId: "6f1c2b9e-7a4d-4c3b-9e8f-0a1b2c3d4e5f",
        accessToken: TOKEN,
        accessExpiresAt: "2026-10-11T09:15:00.000Z",
        refreshToken: "R".repeat(43),
        refreshExpiresAt: "2026-11-10T09:00:00.000Z",
      }),
    "GET /auth/session": () =>
      json({
        sessionId: "6f1c2b9e-7a4d-4c3b-9e8f-0a1b2c3d4e5f",
        accountId: ACCOUNT,
        platform: "ios",
        createdAt: "2026-10-11T09:00:00.000Z",
        refreshExpiresAt: "2026-11-10T09:00:00.000Z",
      }),
    ...overrides,
  };
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ route, ...(init ? { init } : {}) });
    const answer = routes[route];
    if (!answer) throw new Error(`nothing scripted for ${route}`);
    return answer(url, init);
  };
  return { fetch, calls, context: { api: API, fetch, now: () => NOW } };
}

const persona = DEMO_PERSONAS[0] as (typeof DEMO_PERSONAS)[number];
const historyOf = (key: string): PersonaHistory => {
  const found = PERSONA_HISTORIES.find((h) => h.key === key);
  if (!found) throw new Error(`no history ${key}`);
  return found;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the walk to the bank, when the API does not answer as it should", () => {
  it("an API without bank identification is said to be one, before anything goes to a bank", async () => {
    const api = scripted({ "GET /auth/start": () => json({ error: {} }, 503) });
    await expect(loginAs(persona, api.context)).rejects.toThrow(
      "the API has no bank identification: is the mock bank running, and are OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI and HETU_HMAC_KEY set for it?",
    );
    expect(api.calls.map((c) => c.route)).toEqual(["GET /auth/start"]);
  });

  it.each([
    ["an answer that is no redirect", () => json({ ok: true }, 200), "got 200"],
    ["a redirect without a location", () => redirect(null), "got 302"],
    ["a 400", () => json({}, 400), "got 400"],
  ])("%s at the start is refused by name", async (_, answer, said) => {
    const api = scripted({ "GET /auth/start": answer });
    await expect(loginAs(persona, api.context)).rejects.toThrow(
      `/auth/start: expected a redirect, ${said}`,
    );
  });

  it("a deep link with neither a code nor an error is refused", async () => {
    const api = scripted({ "GET /auth/callback": () => redirect("kuutti://auth?state=state-1") });
    await expect(loginAs(persona, api.context)).rejects.toThrow(
      "/auth/callback: no code and no error in kuutti:",
    );
  });

  it("an exchange the API refuses says its status, never its body", async () => {
    const api = scripted({
      "POST /auth/exchange": () => json({ error: { code: "auth_code_used", detail: "x" } }, 400),
    });
    await expect(loginAs(persona, api.context)).rejects.toThrow(/^\/auth\/exchange: 400$/);
  });

  it("a refusal at the callback comes back as the refusal, with its date when there is one", async () => {
    const api = scripted({
      "GET /auth/callback": () =>
        redirect("kuutti://auth?error=auth_cooldown&until=2026-12-01T00:00:00.000Z"),
    });
    expect(await loginAs(persona, api.context)).toEqual({
      kind: "refused",
      error: "auth_cooldown",
      until: "2026-12-01T00:00:00.000Z",
    });
  });

  it.each([
    ["no Retry-After", {}],
    ["a Retry-After that is no number", { "retry-after": "soon" }],
    ["a Retry-After of zero", { "retry-after": "0" }],
    ["a Retry-After past the window", { "retry-after": "600" }],
  ])(
    "a 429 with %s waits the longest a window lasts, 65 s, and tries once more",
    async (_, headers) => {
      let starts = 0;
      const api = scripted({
        "GET /auth/start": () => {
          starts += 1;
          return starts === 1
            ? new Response(null, { status: 429, headers })
            : redirect(`${BANK}?state=state-1`);
        },
      });
      const slept: number[] = [];
      const context = { ...api.context, sleep: async (ms: number) => void slept.push(ms) };
      expect((await loginAs(persona, context)).kind).toBe("session");
      expect(slept).toEqual([65_000]);
      expect(starts).toBe(2);
    },
  );

  it("without a sleep of its own it waits on the clock", async () => {
    vi.useFakeTimers();
    let starts = 0;
    const api = scripted({
      "GET /auth/start": () => {
        starts += 1;
        return starts === 1
          ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
          : redirect(`${BANK}?state=state-1`);
      },
    });
    const walked = loginAs(persona, api.context);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(starts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await walked).kind).toBe("session");
    expect(starts).toBe(2);
  });
});

describe("one call of the API as the persona", () => {
  it("a 204 is nothing, and an error is its envelope's code, or unreadable when there is none", async () => {
    const api = scripted({
      "DELETE /photos/1": () => new Response(null, { status: 204 }),
      "GET /profile": () =>
        json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404),
      "GET /ponds": () => new Response("<html>bad gateway</html>", { status: 502 }),
      "POST /consents": () => new Response(null, { status: 500 }),
    });
    expect(await call(api.context, TOKEN, "DELETE", "/photos/1")).toBeNull();
    await expect(call(api.context, TOKEN, "GET", "/profile")).rejects.toThrow(
      "GET /profile: 404 not_found",
    );
    await expect(call(api.context, TOKEN, "GET", "/ponds")).rejects.toThrow(
      "GET /ponds: 502 unreadable",
    );
    await expect(call(api.context, TOKEN, "POST", "/consents", { kind: "terms" })).rejects.toThrow(
      "POST /consents: 500 unreadable",
    );
    // The token goes in the header, and a body only with its content type.
    const [deleted, , , posted] = api.calls;
    expect(new Headers(deleted?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(deleted?.init?.headers).get("content-type")).toBeNull();
    expect(new Headers(posted?.init?.headers).get("content-type")).toBe("application/json");
    expect(posted?.init?.body).toBe(JSON.stringify({ kind: "terms" }));
  });
});

describe("one upload as the persona", () => {
  const photo = {
    id: "5e0c1d2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
    blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    width: 1200,
    height: 1600,
    state: "queued",
    rejectionReason: null,
    appealable: false,
    position: 0,
    createdAt: "2026-10-11T09:00:00.000Z",
    caption: null,
  };

  it("sends the bytes as the app does, in the photo field, and reads the photo back", async () => {
    let sent: FormData | undefined;
    const api = scripted({
      "POST /photos": (_, init) => {
        sent = init?.body as FormData;
        return json(photo, 201);
      },
    });
    expect(await upload(api.context, TOKEN, new Uint8Array([1, 2, 3]))).toEqual(photo);
    const file = sent?.get("photo") as File;
    expect(file.type).toBe("image/jpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Headers(api.calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("a refused upload says its status and its envelope's code, or unreadable", async () => {
    const refused = scripted({
      "POST /photos": () =>
        json({ error: { code: "photo_limit", message: "x", requestId: "r" } }, 409),
    });
    await expect(upload(refused.context, TOKEN, new Uint8Array([1]))).rejects.toThrow(
      "POST /photos: 409 photo_limit",
    );
    const broken = scripted({ "POST /photos": () => new Response("oops", { status: 502 }) });
    await expect(upload(broken.context, TOKEN, new Uint8Array([1]))).rejects.toThrow(
      "POST /photos: 502 unreadable",
    );
  });
});

describe("the local hands, before and after a login", () => {
  test("nothing is asked of the API for an account that has not logged in", async ({ ctx }) => {
    const api = scripted();
    const writer = viaRoutes({ ...api.context, db: ctx.client });
    await expect(writer.currentVersions(ACCOUNT)).rejects.toThrow(
      `no session for ${ACCOUNT}: the login comes first`,
    );
    await expect(writer.photos(ACCOUNT, [new Uint8Array([1])])).rejects.toThrow(
      `no session for ${ACCOUNT}: the login comes first`,
    );
    expect(api.calls).toEqual([]);
    expect(writer.assets).toBeUndefined();
  });

  test("a login the bank refuses is the refusal, and leaves no session", async ({ ctx }) => {
    const api = scripted({
      "GET /auth/callback": () => redirect("kuutti://auth?error=auth_banned"),
    });
    const writer = viaRoutes({ ...api.context, db: ctx.client });
    expect(await writer.login(persona, "fi")).toEqual({ refused: "auth_banned" });
    await expect(writer.status(ACCOUNT)).rejects.toThrow(DemoError);
  });

  test("after the login: a pond the API does not list is refused, and pictures go up one by one", async ({
    ctx,
  }) => {
    let uploads = 0;
    const api = scripted({
      "GET /ponds": () => json({ ponds: [] }),
      "POST /photos": () => {
        uploads += 1;
        return json(
          {
            id: `5e0c1d2f-3a4b-4c5d-8e6f-7a8b9c0d1e2${uploads}`,
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
            width: 1200,
            height: 1600,
            state: "queued",
            rejectionReason: null,
            appealable: false,
            position: uploads - 1,
            createdAt: "2026-10-11T09:00:00.000Z",
          },
          201,
        );
      },
    });
    const assets = { dir: "/nowhere", manifest: [] };
    const writer = viaRoutes({ ...api.context, db: ctx.client, assets });
    expect(writer.assets).toBe(assets);
    expect(await writer.login(persona, "fi")).toEqual({ accountId: ACCOUNT, outcome: "created" });
    await expect(writer.pond(ACCOUNT, "paakaupunkiseutu")).rejects.toThrow(
      "no pond paakaupunkiseutu: run the seed first",
    );
    expect(await writer.photos(ACCOUNT, [new Uint8Array([1]), new Uint8Array([2])])).toEqual([
      "5e0c1d2f-3a4b-4c5d-8e6f-7a8b9c0d1e21",
      "5e0c1d2f-3a4b-4c5d-8e6f-7a8b9c0d1e22",
    ]);
  });

  test("the look a moderator gives goes to the database, for the account named", async ({
    ctx,
  }) => {
    const { accountId } = await signedInAccount(ctx.client);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1200, 1600, 'queued', 0) RETURNING id`,
      [accountId, "d".repeat(64)],
    );
    const writer = viaRoutes({ ...scripted().context, db: ctx.client });
    await writer.approve(
      accountId,
      rows.map((r) => r.id),
    );
    const after = await ctx.client.query("SELECT state FROM photo WHERE account_id = $1", [
      accountId,
    ]);
    expect(after.rows).toEqual([{ state: "approved" }]);
  });
});

/** A writer that does what it is told and says what it was asked; `status` and `login` are the test's. */
function fakeWriter(overrides: Partial<HistoryWriter>): HistoryWriter {
  const nothing = async () => undefined;
  return {
    db: { query: () => Promise.reject(new Error("no direct write in this test")) },
    now: () => NOW,
    login: async () => ({ accountId: ACCOUNT, outcome: "created" }),
    currentVersions: async () => ({ terms: "t1", privacy: "p1", special_category: "s1" }),
    consent: nothing,
    gender: nothing,
    preferences: nothing,
    pond: nothing,
    profile: nothing,
    photos: async () => [],
    approve: nothing,
    status: async () => ({ state: "active", missing: [] }) as unknown as OnboardingStatus,
    deleteAccount: nothing,
    logout: nothing,
    whoIs: () => ({ clause: "true", params: [] }),
    ...overrides,
  };
}

describe("a history given", () => {
  it("a refusal its own ending does not explain stops it: the personas want a reset", async () => {
    // Sanna's story ends in nothing: a ban at her login is somebody else's doing.
    const writer = fakeWriter({ login: async () => ({ refused: "auth_banned" }) });
    await expect(giveHistory(historyOf("sanna"), writer)).rejects.toThrow(
      "sanna is refused at the login (auth_banned): reset the personas first",
    );
    // Tapio's ends in a ban, and Ilona's in a deletion: the other refusal is still not theirs.
    const cooled = fakeWriter({ login: async () => ({ refused: "auth_cooldown" }) });
    await expect(giveHistory(historyOf("tapio"), cooled)).rejects.toThrow(/tapio is refused/);
    const banned = fakeWriter({ login: async () => ({ refused: "auth_banned" }) });
    await expect(giveHistory(historyOf("ilona"), banned)).rejects.toThrow(/ilona is refused/);
  });

  it("an onboarding the API does not finish is said with what is missing", async () => {
    const writer = fakeWriter({
      status: async () =>
        ({ state: "registered", missing: ["photos", "bio"] }) as unknown as OnboardingStatus,
    });
    await expect(giveHistory(historyOf("sanna"), writer)).rejects.toThrow(
      "sanna did not become active: photos, bio",
    );
  });

  it("without the release nobody gets a photo, and a story with none asks for none", async () => {
    const asked: string[] = [];
    const writer = fakeWriter({
      photos: async () => {
        asked.push("photos");
        return [];
      },
    });
    expect(await giveHistory(historyOf("onni"), writer)).toMatchObject({
      key: "onni",
      photos: 0,
      onboarded: false,
      profile: false,
      login: "created",
    });
    const withRelease = fakeWriter({
      assets: { dir: "/nowhere", manifest: [] },
      photos: async () => {
        asked.push("photos");
        return [];
      },
    });
    // Onni's story has neither faces nor negatives: the release is not opened for him.
    expect((await giveHistory(historyOf("onni"), withRelease)).photos).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe("the staging hands where they refuse", () => {
  const hmacKey = hmacKeyFromHex("1f".repeat(32));

  test("preferences, a pond and pictures each refuse an account or a world that is not there", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const writer = viaServices({ db: ctx.client, logger, now: () => NOW, hmacKey });
    await expect(
      writer.preferences(NOWHERE_ACCOUNT, { seeks: ["woman"], ageWindow: { min: 25, max: 40 } }),
    ).rejects.toThrow(`${NOWHERE_ACCOUNT}: no live account for the preferences`);
    await expect(writer.pond(NOWHERE_ACCOUNT, "lib-demo-nowhere")).rejects.toThrow(
      "no pond lib-demo-nowhere: run the seed first",
    );
    await pondNamed(ctx.client, "lib-demo-pond");
    await expect(writer.pond(NOWHERE_ACCOUNT, "lib-demo-pond")).rejects.toThrow(
      `${NOWHERE_ACCOUNT}: the pond could not be set`,
    );
    await expect(writer.photos(NOWHERE_ACCOUNT, [new Uint8Array([1])])).rejects.toThrow(
      "no object store is configured, and the stories have pictures",
    );
    // Nobody logged in yet: the direct writes have no identity to name.
    expect(() => writer.whoIs(historyOf("kerttu"))).toThrow("kerttu: no login before the history");
  });

  test("the stories leave alone every persona they are told to", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const writer = viaServices({ db: ctx.client, logger, now: () => NOW, hmacKey });
    const login = vi.spyOn(writer, "login");
    expect(
      await giveStories(
        writer,
        PERSONA_HISTORIES.map((h) => h.key),
      ),
    ).toEqual([]);
    expect(login).not.toHaveBeenCalled();
  });
});

describe("the release's pictures where they are not all there", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("names five of the problems and says there are more", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuutti-short-release-"));
    dirs.push(dir);
    const manifest: PhotoAsset[] = Array.from({ length: 7 }, (_, i) => ({
      path: `faces/pool/00${i}.jpg`,
      sha256: "0".repeat(64),
      purpose: "pool",
    })) as PhotoAsset[];
    const error = (() => {
      try {
        loadAssets(dir, manifest);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(DemoError);
    expect(error?.message).toContain(
      "faces/pool/000.jpg missing, faces/pool/001.jpg missing, faces/pool/002.jpg missing, faces/pool/003.jpg missing, faces/pool/004.jpg missing, …): run pnpm demo:assets",
    );
    expect(error?.message).not.toContain("005.jpg");
    expect(loadAssets(dir, [])).toBeNull();
  });

  test("a person with no faces is skipped, and where a check decides nothing is approved by hand", async ({
    ctx,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "kuutti-faces-"));
    dirs.push(dir);
    mkdirSync(join(dir, "faces", "pool"), { recursive: true });
    writeFileSync(join(dir, "faces/pool/001.jpg"), await fixtureJpeg({ exif: false }));
    const face = { path: "faces/pool/001.jpg", sha256: "", purpose: "pool" } as PhotoAsset;
    const media = testMediaDeps({ concurrency: 1 });
    const { logger } = await captureLogger();
    const someone = await signedInAccount(ctx.client);
    const nobody = await signedInAccount(ctx.client);
    const deps = { ...media.deps, db: ctx.client, logger, now: () => NOW };
    const faces = new Map<string, readonly PhotoAsset[]>([
      [nobody.accountId, []],
      [someone.accountId, [face]],
    ]);
    expect(await uploadFaces(deps, { dir, manifest: [face] }, faces, { approve: false })).toEqual({
      people: 1,
      photos: 1,
      approved: 0,
    });
    const { rows } = await ctx.client.query<{ account_id: string; state: string }>(
      "SELECT account_id, state FROM photo WHERE account_id = ANY($1)",
      [[someone.accountId, nobody.accountId]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account_id).toBe(someone.accountId);
    expect(rows[0]?.state).not.toBe("approved");
  });
});

describe("the reset where there is nobody, or the store says nothing useful", () => {
  test("with no persona in the database it forgets nobody and says so", async ({ ctx }) => {
    const { logger } = await captureLogger();
    expect(await resetPersonas({ db: ctx.client, logger, now: () => NOW })).toEqual({
      identities: 0,
      erased: 0,
      objects: 0,
      spared: [],
    });
  });

  test("a store that fails with something that is not an error is said not to answer", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const identity = await ctx.client.query<{ id: string }>(
      `INSERT INTO identity (hetu_hmac, broker_subject, acr, amr)
       VALUES ('a hash for aino in helpers', 'aino', 'x', ARRAY[$1]) RETURNING id`,
      [MOCK_BANK_AMR],
    );
    const account = await ctx.client.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, birth_year, birth_month)
       VALUES ($1, 'active', 1997, 3) RETURNING id`,
      [identity.rows[0]?.id],
    );
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1200, 1600, 0)`,
      [account.rows[0]?.id, "e".repeat(64)],
    );
    const store = {
      get: () => Promise.reject("connection reset"),
    };
    await expect(
      resetPersonas({
        db: ctx.client,
        logger,
        now: () => NOW,
        media: { store } as unknown as Parameters<typeof resetPersonas>[0]["media"],
      }),
    ).rejects.toThrow(/does not answer \(unknown\).* Nobody was erased/);
  });
});
