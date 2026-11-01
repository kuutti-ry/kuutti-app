import type { Queryable } from "@kuutti/db";
import {
  ErrorResponse,
  GateResponse,
  HomeSummary,
  OnboardingStatus,
  ProfileResponse,
} from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, signInAs, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { HOME, openPond, people, pondNamed } from "../test/people.ts";
import { readHome } from "./home.ts";

// PUT /account/home (#514, ADR-061, features/pond/home.feature) and the gate's
// route. The other routes' figures are counter.test.ts. The database is real
// and rolled back; the one statement this file spies on is the digits' path.

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

async function appWith(ctx: TestContext, db: Queryable = ctx.client) {
  const { logger, lines } = await captureLogger();
  return { app: createApp({ config: testConfig(), logger, db }), logs: lines };
}
type App = Awaited<ReturnType<typeof appWith>>["app"];

const putHome = (app: App, headers: Record<string, string>, body: unknown) =>
  app.request("/account/home", {
    method: "PUT",
    headers: json(headers),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const homeRow = async (ctx: TestContext, accountId: string) =>
  (
    await ctx.client.query<{
      home_place: string | null;
      home_shows_area: boolean;
      pond_id: string | null;
    }>("SELECT home_place, home_shows_area, pond_id FROM account WHERE id = $1", [accountId])
  ).rows[0];

/** The database as it is, with every statement and its values kept to read back. */
function spied(db: Queryable): Queryable & { said: () => string } {
  const statements: string[] = [];
  return {
    said: () => statements.join("\n"),
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      statements.push(`${text} ${JSON.stringify(values ?? [])}`);
      return db.query<R>(text, values);
    },
  };
}

const KALLIO = { fi: "Kallio", sv: "Berghäll" };
const HELSINKI = { fi: "Helsinki", sv: "Helsingfors" };
const JOENSUU = { fi: "Joensuu", sv: "Joensuu" };

describe("the home's write", () => {
  test("keeps the area, answers in names and sets the one pond", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const res = await putHome(app, a.headers, { postalCode: "00530" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(HomeSummary.parse(JSON.parse(body))).toEqual({
      town: HELSINKI,
      area: KALLIO,
      showArea: false,
    });
    expect(body).not.toContain("00530");
    expect(await homeRow(ctx, a.accountId)).toMatchObject({
      home_place: "00530",
      home_shows_area: false,
    });
    const line = logs().find((l) => l.msg === "home set");
    expect(line).toMatchObject({ accountId: a.accountId });
    expect(JSON.stringify(line)).not.toContain("00530");
  });

  test("takes the area's name to show in the same request as the code", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const res = await putHome(app, a.headers, { postalCode: "00530", showArea: true });
    expect(HomeSummary.parse(await res.json())).toEqual({
      town: HELSINKI,
      area: KALLIO,
      showArea: true,
    });
    expect((await homeRow(ctx, a.accountId))?.home_shows_area).toBe(true);
  });

  test("changes what the card shows alone, the digits being gone by then, and back", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await putHome(app, a.headers, { postalCode: "00530" });
    const on = await putHome(app, a.headers, { showArea: true });
    expect(HomeSummary.parse(await on.json()).showArea).toBe(true);
    expect(await homeRow(ctx, a.accountId)).toMatchObject({
      home_place: "00530",
      home_shows_area: true,
    });
    const off = await putHome(app, a.headers, { showArea: false });
    expect(HomeSummary.parse(await off.json()).showArea).toBe(false);
    expect(await homeRow(ctx, a.accountId)).toMatchObject({
      home_place: "00530",
      home_shows_area: false,
    });
  });

  test("the choice alone with no home yet is refused, and writes nothing", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    for (const showArea of [true, false]) {
      const res = await putHome(app, a.headers, { showArea });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("validation_failed");
    }
    expect(await homeRow(ctx, a.accountId)).toEqual({
      home_place: null,
      home_shows_area: false,
      pond_id: null,
    });
  });

  test("the choice alone on a place that left the list is refused, and a new code is taken", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET home_place = '12345' WHERE id = $1", [a.accountId]);
    const refused = await putHome(app, a.headers, { showArea: true });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("validation_failed");
    expect((await putHome(app, a.headers, { postalCode: "00530" })).status).toBe(200);
    expect((await homeRow(ctx, a.accountId))?.home_place).toBe("00530");
  });

  test("the choice alone reads a kept place through the floor, so a raised one has no area to show", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await putHome(app, a.headers, { postalCode: "00530" });
    await withMatchingConfig(ctx.client, { home_min_inhabitants: 20000 });
    const res = await putHome(app, a.headers, { showArea: true });
    expect(HomeSummary.parse(await res.json())).toEqual({
      town: HELSINKI,
      area: null,
      showArea: false,
    });
    expect(await homeRow(ctx, a.accountId)).toMatchObject({
      home_place: "00530",
      home_shows_area: false,
    });
  });

  test("a code under a floor no municipality reaches keeps nothing", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await withMatchingConfig(ctx.client, { home_min_inhabitants: 10_000_000 });
    const res = await putHome(app, a.headers, { postalCode: "00530" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("postal_code_unknown");
    expect((await homeRow(ctx, a.accountId))?.home_place).toBeNull();
  });

  test("a body names nobody: the write is the caller's, whatever it says", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const smuggled = await putHome(app, a.headers, {
      postalCode: "00530",
      accountId: b.accountId,
    });
    expect(smuggled.status).toBe(400);
    expect(await errorCode(smuggled)).toBe("validation_failed");
    expect((await putHome(app, b.headers, { postalCode: "00530" })).status).toBe(200);
    expect((await putHome(app, a.headers, { postalCode: "83960" })).status).toBe(200);
    expect((await homeRow(ctx, a.accountId))?.home_place).toBe("422");
    expect((await homeRow(ctx, b.accountId))?.home_place).toBe("00530");
  });

  test("an erased account's write is a 404 and leaves nothing on the tombstone", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    let erased = false;
    const db: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        if (!erased && text.includes("home_moved_at FROM account") && text.includes("FOR UPDATE")) {
          erased = true;
          await ctx.client.query(
            "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
            [a.accountId],
          );
        }
        return ctx.client.query<R>(text, values);
      },
    } as Queryable;
    const { app, logs } = await appWith(ctx, db);
    const res = await putHome(app, a.headers, { postalCode: "00530" });
    expect(erased).toBe(true);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect((await homeRow(ctx, a.accountId))?.home_place).toBeNull();
    expect(logs().some((l) => l.msg === "home set")).toBe(false);
  });
});

async function refusedCallers(ctx: TestContext) {
  const ended = await signedInAccount(ctx.client);
  await ctx.client.query("UPDATE session SET revoked_at = now() WHERE id = $1", [ended.sessionId]);
  const expired = await signedInAccount(ctx.client);
  await ctx.client.query(
    "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
    [expired.sessionId],
  );
  return [
    ["no token", {}, "unauthenticated"],
    ["a token nobody issued", { authorization: `Bearer ${"D".repeat(43)}` }, "unauthenticated"],
    ["an ended session", ended.headers, "session_revoked"],
    ["an expired access token", expired.headers, "session_expired"],
  ] as const;
}

describe("the pond routes' guard", () => {
  test("every refused caller gets its own code on the home and the gate, and nothing is written", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    for (const [what, headers, code] of await refusedCallers(ctx)) {
      for (const res of [
        await putHome(app, headers, { postalCode: "00530" }),
        await app.request("/gate", { headers }),
      ]) {
        expect(res.status, what).toBe(401);
        expect(await errorCode(res), what).toBe(code);
      }
    }
    const { rows } = await ctx.client.query(
      "SELECT count(*) AS n FROM account WHERE home_place IS NOT NULL",
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  test("the routes of the choice are gone", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    expect((await app.request("/ponds", { headers: a.headers })).status).toBe(404);
    const chosen = await app.request("/account/pond", {
      method: "PUT",
      headers: json(a.headers),
      body: JSON.stringify({ pondId: "00000000-0000-4000-8000-000000000009" }),
    });
    expect(chosen.status).toBe(404);
  });

  test("the gate is the caller's own, never cached, and says incomplete before there is a home", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const pondId = await pondNamed(ctx.client, "test-gate-route");
    const [open] = await people(ctx.client, pondId, 1, {
      complete: true,
      consented: true,
      gender: "woman",
    });
    await openPond(ctx.client, pondId);
    const theirs = await signInAs(ctx.client, open ?? "");
    const mine = await signedInAccount(ctx.client);

    const opened = await app.request("/gate", { headers: theirs.headers });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    expect(GateResponse.parse(await opened.json())).toEqual({ state: "open" });

    const incomplete = await app.request("/gate", { headers: mine.headers });
    expect(incomplete.status).toBe(200);
    expect(incomplete.headers.get("cache-control")).toBe("no-store");
    expect(GateResponse.parse(await incomplete.json())).toEqual({ state: "incomplete" });
  });
});

describe("A postal code is five digits, and anything else is refused", () => {
  test.for([
    ["four digits", { postalCode: "0053" }],
    ["six digits", { postalCode: "005300" }],
    ["five characters with a letter", { postalCode: "0053A" }],
    ["five characters with a space", { postalCode: "0053 " }],
    ["the code as a number", { postalCode: 530 }],
    ["an empty code", { postalCode: "" }],
    ["neither a code nor what to show", {}],
    ["a field the route does not know", { postalCode: "00100", street: "00530" }],
  ] as const)("%s", async ([, body], { ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET home_place = $2 WHERE id = $1", [a.accountId, HOME]);
    const res = await putHome(app, a.headers, body);
    expect(res.status).toBe(400);
    // The envelope but for its request id, random, which may hold any digits.
    const { requestId: _random, ...said } = ErrorResponse.parse(await res.json()).error;
    expect(said.code).toBe("validation_failed");
    // Nothing it sent is repeated, to the caller or to the log.
    for (const sent of Object.values(body).map(String).filter(Boolean)) {
      expect(JSON.stringify(said)).not.toContain(sent);
      expect(JSON.stringify(logs())).not.toContain(`"${sent}"`);
    }
    expect((await homeRow(ctx, a.accountId))?.home_place).toBe(HOME);
  });

  test("a body that is no JSON is refused the same way", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const res = await putHome(app, a.headers, "00530");
    expect(res.status).toBe(400);
    expect((await homeRow(ctx, a.accountId))?.home_place).toBeNull();
  });
});

describe("the features of the home", () => {
  test("A postal code the list lacks is refused by a constant, and nothing is kept", async ({
    ctx,
  }) => {
    const db = spied(ctx.client);
    const { app, logs } = await appWith(ctx, db);
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET home_place = $2 WHERE id = $1", [a.accountId, HOME]);
    const answers = [];
    for (const code of ["99999", "99998"]) {
      const res = await putHome(app, a.headers, { postalCode: code });
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("postal_code_unknown");
      expect(error).not.toHaveProperty("detail");
      answers.push(error.message);
    }
    expect(answers[0]).toBe(answers[1]);
    expect((await homeRow(ctx, a.accountId))?.home_place).toBe(HOME);
    expect(db.said()).not.toMatch(/9999[89]/);
    // The refusal's line carries no detail, and the digits are in no line.
    const refused = logs().find((l) => l.code === "postal_code_unknown");
    expect(refused).toBeDefined();
    expect(refused?.detail).toBeUndefined();
    expect(JSON.stringify(logs())).not.toMatch(/9999[89]/);
  });

  test("The digits of an area too small to keep are looked up in memory and gone", async ({
    ctx,
  }) => {
    const db = spied(ctx.client);
    const { app, logs } = await appWith(ctx, db);
    const a = await signedInAccount(ctx.client);
    const res = await putHome(app, a.headers, { postalCode: "83960" });
    expect(res.status).toBe(200);
    expect(HomeSummary.parse(await res.json())).toEqual({
      town: JOENSUU,
      area: null,
      showArea: false,
    });
    expect((await homeRow(ctx, a.accountId))?.home_place).toBe("422");
    expect(db.said()).not.toContain("83960");
    expect(JSON.stringify(logs())).not.toContain("83960");
    const row = await ctx.client.query(
      "SELECT to_jsonb(a) AS account FROM account a WHERE id = $1",
      [a.accountId],
    );
    expect(JSON.stringify(row.rows)).not.toContain("83960");
  });

  test("Where a municipality is kept there is no area to show", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await putHome(app, a.headers, { postalCode: "83960" });
    const res = await putHome(app, a.headers, { showArea: true });
    expect(res.status).toBe(200);
    expect(HomeSummary.parse(await res.json())).toEqual({
      town: JOENSUU,
      area: null,
      showArea: false,
    });
    expect((await homeRow(ctx, a.accountId))?.home_shows_area).toBe(false);
    // In the same request as the code, too.
    const both = await putHome(app, a.headers, { postalCode: "83960", showArea: true });
    expect(HomeSummary.parse(await both.json()).showArea).toBe(false);
    const preview = await app.request("/onboarding", { headers: a.headers });
    expect(OnboardingStatus.parse(await preview.json()).home).toEqual({
      town: JOENSUU,
      area: null,
      showArea: false,
    });
  });

  test("A new home starts from the town again, unless the same request says otherwise", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await putHome(app, a.headers, { postalCode: "00530", showArea: true });
    const second = await putHome(app, a.headers, { postalCode: "00100" });
    expect(HomeSummary.parse(await second.json()).showArea).toBe(false);
    expect(await homeRow(ctx, a.accountId)).toMatchObject({ home_shows_area: false });
    const third = await putHome(app, a.headers, { postalCode: "00500", showArea: true });
    expect(HomeSummary.parse(await third.json())).toMatchObject({ showArea: true });
    expect(await homeRow(ctx, a.accountId)).toMatchObject({
      home_place: "00500",
      home_shows_area: true,
    });
  });

  test("A home changes whenever the person likes, and the earlier one is gone", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const pondId = await pondNamed(ctx.client, "test-home-moves");
    const [person] = await people(ctx.client, pondId, 1, {
      complete: true,
      consented: true,
      gender: "woman",
    });
    const a = await signInAs(ctx.client, person ?? "");

    for (const postalCode of ["00100", "83960"]) {
      expect((await putHome(app, a.headers, { postalCode })).status).toBe(200);
    }

    // The account's columns are all there is of a home: only the last is held, with the time of the latest move.
    const account = await ctx.client.query<Record<string, unknown>>(
      "SELECT to_jsonb(a) AS row FROM account a WHERE id = $1",
      [person],
    );
    const row = account.rows[0]?.row as Record<string, unknown>;
    expect(row.home_place).toBe("422");
    expect(JSON.stringify(row)).not.toMatch(/00530|00100/);
    expect(Object.keys(row).filter((column) => column.includes("home"))).toEqual([
      "home_place",
      "home_moved_at",
      "home_shows_area",
    ]);
    expect(row.home_moved_at).toEqual(expect.any(String));
    expect(row.pond_id).toBe(pondId);
  });

  test("The home write sets the one pond, and reading the status sets nothing", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const first = OnboardingStatus.parse(
      await (await app.request("/onboarding", { headers: a.headers })).json(),
    );
    expect(first.pond).toBeNull();
    expect(first.missing).toContain("home");
    expect(first.missing).not.toContain("pond");
    expect((await homeRow(ctx, a.accountId))?.pond_id).toBeNull();

    expect((await putHome(app, a.headers, { postalCode: "00530" })).status).toBe(200);
    const then = OnboardingStatus.parse(
      await (await app.request("/onboarding", { headers: a.headers })).json(),
    );
    // The row matching_config's default_pond names, version 3 of it (ADR-061 §8).
    expect(then.pond).toMatchObject({ slug: "suomi" });
    expect(logs().some((l) => l.msg === "pond assigned")).toBe(false);
  });

  test("A home write that would leave the account with no pond fails loudly and keeps nothing", async ({
    ctx,
  }) => {
    const reports: unknown[] = [];
    const { logger, lines } = await captureLogger();
    const app = createApp({
      config: testConfig(),
      logger,
      db: ctx.client,
      report: (error) => reports.push(error),
    });
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    for (const value of ["nowhere", "", 7]) {
      await withMatchingConfig(ctx.client, { default_pond: value });
      const res = await putHome(app, a.headers, { postalCode: "00530" });
      expect(res.status, String(value)).toBe(500);
      expect(await errorCode(res)).toBe("internal_error");
      expect(await homeRow(ctx, a.accountId), String(value)).toEqual({
        home_place: null,
        home_shows_area: false,
        pond_id: null,
      });
      const status = OnboardingStatus.parse(
        await (await app.request("/onboarding", { headers: a.headers })).json(),
      );
      expect(status.missing).toContain("home");
    }
    expect(reports).toHaveLength(3);
    expect(lines().filter((l) => l.msg === "unhandled error")).toHaveLength(3);
    expect(lines().some((l) => l.msg === "home set")).toBe(false);
    expect(JSON.stringify(lines())).not.toContain("00530");
  });

  test("a pond held stays, whatever the config names", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const pondId = await pondNamed(ctx.client, "test-home-pond-held");
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET pond_id = $2 WHERE id = $1", [a.accountId, pondId]);
    await withMatchingConfig(ctx.client, { default_pond: "nowhere" });
    expect((await putHome(app, a.headers, { postalCode: "00530" })).status).toBe(200);
    expect((await homeRow(ctx, a.accountId))?.pond_id).toBe(pondId);
  });

  test("The home of another account is never served", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    await putHome(app, a.headers, { postalCode: "00530" });

    const status = await app.request("/onboarding", { headers: b.headers });
    expect(OnboardingStatus.parse(await status.json()).home).toBeNull();
    const profile = await app.request("/profile", { headers: b.headers });
    expect(ProfileResponse.parse(await profile.json()).home).toBeNull();

    // The owner reads their own in both.
    const own = await app.request("/onboarding", { headers: a.headers });
    expect(OnboardingStatus.parse(await own.json()).home?.area).toEqual(KALLIO);
    const mine = await app.request("/profile", { headers: a.headers });
    expect(ProfileResponse.parse(await mine.json()).home?.town).toEqual(HELSINKI);
  });
});

describe("reading a home", () => {
  test("says nothing and warns of nothing without one", async ({ ctx }) => {
    const { logger, lines } = await captureLogger();
    const a = await signedInAccount(ctx.client);
    expect(await readHome({ db: ctx.client, logger }, a.accountId)).toBeNull();
    expect(await readHome({ db: ctx.client, logger }, "00000000-0000-4000-8000-000000000009")).toBe(
      null,
    );
    expect(lines().filter((l) => l.level === 40)).toEqual([]);
  });
});
