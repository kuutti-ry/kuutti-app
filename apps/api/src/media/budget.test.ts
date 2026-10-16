import { resolve } from "node:path";
import { createPool, migrate, withTemporaryDatabase } from "@kuutti/db";
import { Photo, type PhotoFetchBudget, type PhotoVariant } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixturePng, testMediaDeps } from "../test/media.ts";
import { dayWindow, localYearMonth, secondsUntil } from "./budget.ts";
import { findVisiblePhoto, insertPhoto, insertPhotoAccess, recordCardServed } from "./repo.ts";

// The exposure budget and the shown-record rule (#52, TD-6, ADR-008),
// features/safety/exposure.feature. Photos are uploaded through the API so
// the objects and rows exist; the budget is set per test.

const BUDGET: PhotoFetchBudget = { thumb: 3, card: 2, full: 1 };

async function appWith(ctx: TestContext, budget: PhotoFetchBudget = BUDGET) {
  await withMatchingConfig(ctx.client, { max_photos: 3, photo_fetches_per_day: budget });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps({ concurrency: 2 });
  const app = createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps });
  return { app, logs: lines };
}

type App = Awaited<ReturnType<typeof appWith>>["app"];

async function upload(app: App, headers: Record<string, string>, bytes: Buffer): Promise<Photo> {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "p.png");
  const response = await app.request("/photos", { method: "POST", headers, body: form });
  expect(response.status).toBe(201);
  return Photo.parse(await response.json());
}

const fetchUrl = (app: App, headers: Record<string, string>, id: string, variant: PhotoVariant) =>
  app.request(`/photos/${id}/${variant}`, { headers });

async function approve(ctx: TestContext, photoId: string): Promise<void> {
  await ctx.client.query("UPDATE photo SET state = 'approved' WHERE id = $1", [photoId]);
}

async function accessRows(ctx: TestContext, accountId: string, variant?: PhotoVariant) {
  const { rows } = await ctx.client.query<{ n: string }>(
    `SELECT count(*) AS n FROM photo_access WHERE account_id = $1 AND ($2::photo_variant IS NULL OR variant = $2)`,
    [accountId, variant ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The viewer shown the subject's card, through what the card route writes; one day, a budget that never binds. */
async function showCard(ctx: TestContext, viewer: string, subject: string, photoIds: string[]) {
  return recordCardServed(ctx.client, {
    viewerAccountId: viewer,
    subjectAccountId: subject,
    photoIds,
    at: new Date("2026-10-11T09:00:00Z"),
    since: new Date("2026-10-11T00:00:00+03:00"),
    limit: 100,
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("The photo fetch budget of a day", () => {
  test.for([
    ["thumb", 3],
    ["card", 2],
    ["full", 1],
  ] as const)("%s: %i fetches, then 429", async ([variant, limit], { ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const photo = await upload(app, a.headers, await fixturePng(64, 64));
    for (let i = 0; i < limit; i += 1) {
      expect((await fetchUrl(app, a.headers, photo.id, variant)).status).toBe(200);
    }
    const refused = await fetchUrl(app, a.headers, photo.id, variant);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("photo_budget_exceeded");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await accessRows(ctx, a.accountId, variant)).toBe(limit);
  });
});

describe("exposure", () => {
  test("A refused fetch writes no fetch-log row and is counted", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, { thumb: 1, card: 1, full: 1 });
    const a = await signedInAccount(ctx.client);
    const photo = await upload(app, a.headers, await fixturePng(64, 64));
    expect((await fetchUrl(app, a.headers, photo.id, "thumb")).status).toBe(200);
    expect((await fetchUrl(app, a.headers, photo.id, "thumb")).status).toBe(429);
    expect(await accessRows(ctx, a.accountId, "thumb")).toBe(1);
    const line = logs().find((l) => l.msg === "photo refused");
    expect(line).toMatchObject({
      level: 40,
      accountId: a.accountId,
      variant: "thumb",
      reason: "budget",
      used: 1,
      limit: 1,
    });
  });

  test("Retry-After runs until midnight in Finland", async ({ ctx }) => {
    const { app } = await appWith(ctx, { thumb: 0, card: 0, full: 0 });
    const a = await signedInAccount(ctx.client);
    const photo = await upload(app, a.headers, await fixturePng(64, 64));
    const before = new Date();
    const refused = await fetchUrl(app, a.headers, photo.id, "thumb");
    expect(refused.status).toBe(429);
    const expected = secondsUntil(dayWindow(before).end, before);
    expect(Math.abs(Number(refused.headers.get("retry-after")) - expected)).toBeLessThanOrEqual(5);
  });

  test("The count resets at the day boundary", async ({ ctx }) => {
    const { app } = await appWith(ctx, { thumb: 2, card: 2, full: 2 });
    const a = await signedInAccount(ctx.client);
    const photo = await upload(app, a.headers, await fixturePng(64, 64));
    // Two days back is outside the current window whatever the clock and DST say.
    await ctx.client.query(
      `INSERT INTO photo_access (account_id, photo_id, variant, at)
       SELECT $1, $2, 'thumb', now() - interval '2 days' FROM generate_series(1, 2)`,
      [a.accountId, photo.id],
    );
    expect((await fetchUrl(app, a.headers, photo.id, "thumb")).status).toBe(200);
    expect(await accessRows(ctx, a.accountId, "thumb")).toBe(3);
  });

  test("The full variant of a photo the account was not shown is refused", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const theirs = await upload(app, b.headers, await fixturePng(64, 64));
    await approve(ctx, theirs.id);
    const refused = await fetchUrl(app, a.headers, theirs.id, "full");
    expect(refused.status).toBe(404);
    expect(await accessRows(ctx, a.accountId)).toBe(0);
    expect(logs().find((l) => l.msg === "photo refused")).toMatchObject({
      accountId: a.accountId,
      photoId: theirs.id,
      variant: "full",
      reason: "not_visible",
    });
  });

  test("A photo shown twice is one shown record", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const theirs = await upload(app, b.headers, await fixturePng(64, 64));
    expect(await showCard(ctx, a.accountId, b.accountId, [theirs.id])).toEqual({
      used: 0,
      recorded: true,
    });
    expect(await showCard(ctx, a.accountId, b.accountId, [theirs.id])).toEqual({
      used: 1,
      recorded: true,
    });
    const { rows } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM card_shown WHERE account_id = $1",
      [a.accountId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test("A photo on a card the account was shown is served", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const theirs = await upload(app, b.headers, await fixturePng(64, 64));
    await approve(ctx, theirs.id);
    await showCard(ctx, a.accountId, b.accountId, [theirs.id]);
    expect((await fetchUrl(app, a.headers, theirs.id, "card")).status).toBe(200);
    expect((await fetchUrl(app, a.headers, theirs.id, "full")).status).toBe(200);
    expect(await accessRows(ctx, a.accountId)).toBe(2);
    expect(await accessRows(ctx, b.accountId)).toBe(0);
  });

  test("A photo not yet approved is not served from a shown card", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const theirs = await upload(app, b.headers, await fixturePng(64, 64));
    await showCard(ctx, a.accountId, b.accountId, [theirs.id]);
    expect((await fetchUrl(app, a.headers, theirs.id, "card")).status).toBe(404);
    expect(await accessRows(ctx, a.accountId)).toBe(0);
  });

  test("Fetching the photos of the account itself ignores the shown record", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const mine = await upload(app, a.headers, await fixturePng(64, 64));
    expect(mine.state).toBe("pending");
    expect((await fetchUrl(app, a.headers, mine.id, "full")).status).toBe(200);
  });
});

describe("A photo held back by moderation is not served from a shown card", () => {
  // The read serves others only an approved photo (#49); a shown card is no way round it.
  test.for(["queued", "rejected"] as const)("%s", async (state, { ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const theirs = await upload(app, b.headers, await fixturePng(64, 64));
    await ctx.client.query("UPDATE photo SET state = $2 WHERE id = $1", [theirs.id, state]);
    await showCard(ctx, a.accountId, b.accountId, [theirs.id]);
    expect((await fetchUrl(app, a.headers, theirs.id, "card")).status).toBe(404);
    expect((await fetchUrl(app, a.headers, theirs.id, "full")).status).toBe(404);
    expect(await accessRows(ctx, a.accountId)).toBe(0);
    // The owner still sees their own photo, to replace it or to read why.
    expect((await fetchUrl(app, b.headers, theirs.id, "card")).status).toBe(200);
  });
});

describe("A photo of an owner who is not active is not served from a shown card", () => {
  // The card's rule (ADR-009 §6) holds for the URL too (ADR-024 §6): a
  // sanctioned or paused owner's photos stop for everyone they were shown to,
  // at once, and come back with a lift, since nothing was deleted. The owner
  // still reads their own; a suspended or banned owner only past the guard,
  // which already refuses their sessions.
  test.for([
    ["shadow_banned", true],
    ["suspended", false],
    ["banned", false],
    ["paused", true],
  ] as const)("%s", async ([state, ownerPassesGuard], { ctx }) => {
    const { app, logs } = await appWith(ctx);
    const viewer = await signedInAccount(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const theirs = await upload(app, owner.headers, await fixturePng(64, 64));
    await approve(ctx, theirs.id);
    await showCard(ctx, viewer.accountId, owner.accountId, [theirs.id]);
    await ctx.client.query("UPDATE account SET state = $2 WHERE id = $1", [owner.accountId, state]);

    expect((await fetchUrl(app, viewer.headers, theirs.id, "card")).status).toBe(404);
    expect((await fetchUrl(app, viewer.headers, theirs.id, "full")).status).toBe(404);
    expect(await accessRows(ctx, viewer.accountId)).toBe(0);
    expect(logs().find((l) => l.msg === "photo refused")).toMatchObject({
      accountId: viewer.accountId,
      photoId: theirs.id,
      reason: "not_visible",
    });
    expect(await findVisiblePhoto(ctx.client, owner.accountId, theirs.id)).toMatchObject({
      id: theirs.id,
    });
    if (ownerPassesGuard) {
      expect((await fetchUrl(app, owner.headers, theirs.id, "card")).status).toBe(200);
    }

    // The lift: the same shown record serves the photo again.
    await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [owner.accountId]);
    expect((await fetchUrl(app, viewer.headers, theirs.id, "card")).status).toBe(200);
    expect(await accessRows(ctx, viewer.accountId)).toBe(1);
  });
});

describe("the card budget across days", () => {
  test("A card seen on an earlier day counts against today once", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const viewer = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    const theirs = await upload(app, b.headers, await fixturePng(64, 64));
    const others = await upload(app, c.headers, await fixturePng(72, 72));
    const day = dayWindow(new Date());
    const serve = (subject: string, photoId: string) =>
      recordCardServed(ctx.client, {
        viewerAccountId: viewer.accountId,
        subjectAccountId: subject,
        photoIds: [photoId],
        at: new Date(),
        since: day.start,
        limit: 1,
      });
    // Seen two days ago: the row exists with an old date.
    await ctx.client.query(
      "INSERT INTO card_shown (account_id, photo_id, at) VALUES ($1, $2, now() - interval '2 days')",
      [viewer.accountId, theirs.id],
    );
    const again = await serve(b.accountId, theirs.id);
    expect(again).toEqual({ used: 0, recorded: true });
    const { rows } = await ctx.client.query<{ at: Date }>(
      "SELECT at FROM card_shown WHERE account_id = $1 AND photo_id = $2",
      [viewer.accountId, theirs.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at.getTime()).toBeGreaterThanOrEqual(day.start.getTime());
    // It used today's one card: the next subject is over the budget, the same one is free.
    expect((await serve(c.accountId, others.id)).recorded).toBe(false);
    expect(await serve(b.accountId, theirs.id)).toEqual({ used: 1, recorded: true });
  });
});

describe("the budget under load", () => {
  // The race is between connections, and one connection cannot race itself,
  // so the rows must be committed. They are committed into a database of
  // their own, migrated for the test and dropped afterwards, so no other
  // test file, however it counts its tables, ever sees them.
  it("holds against a parallel burst: exactly the limit is written", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 6, applicationName: "kuutti-burst" });
      try {
        await migrate(pool, resolve(import.meta.dirname, "../../../../packages/db/drizzle"));
        const identity = await pool.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac) VALUES ('burst') RETURNING id",
        );
        const created = await pool.query<{ id: string }>(
          "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
          [identity.rows[0]?.id],
        );
        const accountId = created.rows[0]?.id ?? "";
        const photo = await insertPhoto(pool, {
          accountId,
          key: "burst",
          blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          width: 64,
          height: 64,
          maxPhotos: 3,
        });
        if (!photo) throw new Error("photo not written");
        const since = new Date(Date.now() - 3_600_000);
        const results = await Promise.all(
          Array.from({ length: 24 }, () =>
            insertPhotoAccess(pool, {
              accountId,
              photoId: photo.id,
              variant: "thumb",
              at: new Date(),
              since,
              limit: 5,
            }),
          ),
        );
        expect(results.filter((r) => r.recorded)).toHaveLength(5);
        expect(results.every((r) => r.live)).toBe(true);
        const { rows } = await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM photo_access WHERE account_id = $1",
          [accountId],
        );
        expect(Number(rows[0]?.n)).toBe(5);
      } finally {
        await pool.end();
      }
    });
  }, 30_000);
});

describe("the Finnish day", () => {
  const iso = (d: Date) => d.toISOString();

  it("runs from local midnight to local midnight, summer time", () => {
    const w = dayWindow(new Date("2026-07-15T10:00:00Z"));
    expect([iso(w.start), iso(w.end)]).toEqual([
      "2026-07-14T21:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
    ]);
  });

  it("runs from local midnight to local midnight, winter time", () => {
    const w = dayWindow(new Date("2026-01-15T10:00:00Z"));
    expect([iso(w.start), iso(w.end)]).toEqual([
      "2026-01-14T22:00:00.000Z",
      "2026-01-15T22:00:00.000Z",
    ]);
  });

  it("is a second long a second before midnight", () => {
    const at = new Date("2026-07-15T20:59:59Z");
    const w = dayWindow(at);
    expect(iso(w.end)).toBe("2026-07-15T21:00:00.000Z");
    expect(secondsUntil(w.end, at)).toBe(1);
  });

  it("is 25 hours long on the autumn change and 23 on the spring change", () => {
    const autumn = dayWindow(new Date("2026-10-25T10:00:00Z"));
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
    const spring = dayWindow(new Date("2026-03-29T10:00:00Z"));
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
  });

  it("never announces a wait under one second", () => {
    const at = new Date("2026-07-15T20:59:59.900Z");
    expect(secondsUntil(dayWindow(at).end, at)).toBe(1);
    expect(secondsUntil(at, new Date(at.getTime() + 5_000))).toBe(1);
  });
});

describe("a budget row that is not a budget", () => {
  test.for([
    ["a number", 300],
    ["a variant missing", { thumb: 3, card: 2 }],
    ["a negative count", { thumb: 3, card: -1, full: 1 }],
  ] as const)("%s fails closed: no URL, no fetch-log row", async ([, value], { ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const photo = await upload(app, a.headers, await fixturePng(64, 64));
    await withMatchingConfig(ctx.client, { photo_fetches_per_day: value });
    const res = await fetchUrl(app, a.headers, photo.id, "thumb");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("Signature");
    expect(await accessRows(ctx, a.accountId)).toBe(0);
  });
});

describe("the Finnish year and month", () => {
  it("is already the next month in Finland while it is still the last evening of the old one in UTC", () => {
    const newYearsEve = new Date("2026-12-31T22:30:00Z"); // 00:30 on 1 January in Helsinki
    expect(localYearMonth(newYearsEve)).toEqual({ year: 2027, month: 1 });
    expect(localYearMonth(newYearsEve, "UTC")).toEqual({ year: 2026, month: 12 });
  });
});
