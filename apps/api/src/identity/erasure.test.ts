import { accountState } from "@kuutti/db";
import { AccountExport, AccountState, Photo } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixtureJpeg, fixturePng, testMediaDeps } from "../test/media.ts";
import { eraseAccount, exportAccount } from "./erasure.ts";
import { REREGISTER_COOLDOWN_DAYS } from "./registration.ts";

// features/identity/erasure.feature through the routes (#51, TD-7): real
// Postgres in a rolled-back transaction, a memory store standing in for the
// bucket. Photos are uploaded through the API so the objects exist.

const DAY_MS = 24 * 60 * 60 * 1000;

async function appWith(ctx: TestContext, options: { media?: false } = {}) {
  await withMatchingConfig(ctx.client, {
    max_photos: 6,
    photo_moderation_label_threshold: 60,
    photo_moderation_face_threshold: 90,
  });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps();
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    ...(options.media === false ? {} : { media: media.deps }),
  });
  return { app, store: media.store, logs: lines };
}

function multipart(bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append(
    "photo",
    new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/jpeg" }),
    "p.jpg",
  );
  return form;
}

async function upload(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  bytes: Uint8Array,
) {
  const res = await app.request("/photos", { method: "POST", headers, body: multipart(bytes) });
  expect(res.status).toBe(201);
  return Photo.parse(await res.json());
}

const del = (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  body: unknown = { confirm: true },
) =>
  app.request("/account/delete", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function count(ctx: TestContext, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await ctx.client.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

describe("account erasure", () => {
  test("Deleting the account removes its sessions, login attempts, photos, review rows and fetch log", async ({
    ctx,
  }) => {
    const { app, store, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const second = await signedInAccount(ctx.client, "a2");
    // The second device: another session row of the same account.
    await ctx.client.query("UPDATE session SET account_id = $1 WHERE id = $2", [
      a.accountId,
      second.sessionId,
    ]);
    await ctx.client.query("DELETE FROM account WHERE id = $1", [second.accountId]);
    await ctx.client.query(
      "INSERT INTO auth_request (state, nonce, platform, expires_at, account_id) VALUES ('s1', 'n1', 'ios', now() + interval '10 minutes', $1)",
      [a.accountId],
    );
    const one = await upload(
      app,
      a.headers,
      await fixtureJpeg({ width: 800, height: 900, exif: false }),
    );
    await upload(app, a.headers, await fixturePng(300, 300));
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision) VALUES ($1, '[]', 1, '{}', 'approved')`,
      [one.id],
    );
    expect((await app.request(`/photos/${one.id}/thumb`, { headers: a.headers })).status).toBe(200);
    expect(store.objects.size).toBe(6);

    const res = await del(app, a.headers);
    expect(res.status).toBe(204);

    for (const [table, sql] of [
      ["session", "SELECT count(*) AS n FROM session WHERE account_id = $1"],
      ["auth_request", "SELECT count(*) AS n FROM auth_request WHERE account_id = $1"],
      ["photo", "SELECT count(*) AS n FROM photo WHERE account_id = $1"],
      ["photo_access", "SELECT count(*) AS n FROM photo_access WHERE account_id = $1"],
    ] as const) {
      expect(await count(ctx, sql, [a.accountId]), table).toBe(0);
    }
    expect(await count(ctx, "SELECT count(*) AS n FROM photo_review")).toBe(0);
    expect(store.objects.size).toBe(0);
    const line = logs().find((l) => l.msg === "account erased");
    expect(line).toMatchObject({
      accountId: a.accountId,
      sessions: 2,
      authRequests: 1,
      photos: 2,
      objects: 6,
    });
  });

  test("The account row stays as an anonymised tombstone and the identity counts the deletion", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const before = Date.now();
    expect((await del(app, a.headers)).status).toBe(204);
    const account = await ctx.client.query(
      "SELECT state, deleted_at, state_changed_at, birth_year, birth_month, registered_at FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(account.rows[0]).toMatchObject({
      state: "deleted",
      birth_year: null,
      birth_month: null,
    });
    const deletedAt = account.rows[0]?.deleted_at as Date | undefined;
    expect(deletedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before - 1000);
    expect(account.rows[0]?.registered_at).toBeInstanceOf(Date);
    const identity = await ctx.client.query(
      "SELECT i.deletion_count, i.reregister_after, i.hetu_hmac FROM identity i JOIN account a ON a.identity_id = i.id WHERE a.id = $1",
      [a.accountId],
    );
    expect(identity.rows[0]?.deletion_count).toBe(1);
    const until = (identity.rows[0]?.reregister_after as Date | undefined)?.getTime() ?? 0;
    expect(until - before).toBeGreaterThan(REREGISTER_COOLDOWN_DAYS * DAY_MS - 5000);
    expect(until - before).toBeLessThanOrEqual(REREGISTER_COOLDOWN_DAYS * DAY_MS + 5000);
    expect(identity.rows[0]?.hetu_hmac).toBeTruthy(); // the identity row stays
  });

  test("A photo another account also uploaded keeps its objects", async ({ ctx }) => {
    const { app, store } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const shared = await fixtureJpeg({ width: 700, height: 700, exif: false });
    await upload(app, a.headers, shared);
    const theirs = await upload(app, b.headers, shared);
    expect(store.objects.size).toBe(3);
    expect((await del(app, a.headers)).status).toBe(204);
    expect(store.objects.size).toBe(3);
    expect(await count(ctx, "SELECT count(*) AS n FROM photo WHERE id = $1", [theirs.id])).toBe(1);
  });

  test("Deletion needs the confirmation and only touches the caller", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    await upload(app, b.headers, await fixturePng(200, 200));

    expect((await del(app, a.headers, {})).status).toBe(400);
    expect((await del(app, a.headers, { confirm: false })).status).toBe(400);
    expect((await del(app, a.headers, { confirm: "yes" })).status).toBe(400);
    const untouched = await ctx.client.query("SELECT state FROM account WHERE id = $1", [
      a.accountId,
    ]);
    expect(untouched.rows[0]?.state).toBe("active");

    expect((await del(app, a.headers)).status).toBe(204);
    expect(
      (await ctx.client.query("SELECT state FROM account WHERE id = $1", [b.accountId])).rows[0]
        ?.state,
    ).toBe("active");
    expect(
      await count(ctx, "SELECT count(*) AS n FROM session WHERE account_id = $1", [b.accountId]),
    ).toBe(1);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM photo WHERE account_id = $1", [b.accountId]),
    ).toBe(1);
    expect((await app.request("/photos", { headers: b.headers })).status).toBe(200);
  });

  test("Every token of a deleted account stops working", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    expect((await del(app, a.headers)).status).toBe(204);
    for (const path of ["/auth/session", "/photos", "/account/export"]) {
      const res = await app.request(path, { headers: a.headers });
      expect(res.status, path).toBe(401);
    }
    expect((await del(app, a.headers)).status).toBe(401);
    const refresh = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: a.refreshToken }),
    });
    expect(refresh.status).toBe(401);
  });

  test("A request that outlived the deletion writes nothing for the erased account", async ({
    ctx,
  }) => {
    // The guard is checked once per request; a login exchange can reach its
    // insert after the erasure committed. The insert itself refuses a
    // tombstone; the media inserts do the same (media/erasure.test.ts).
    const { app, store } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await upload(app, a.headers, await fixturePng(120, 120));
    expect((await del(app, a.headers)).status).toBe(204);
    const repo = await import("./repo.ts");
    expect(
      await repo.insertSession(ctx.client, {
        accountId: a.accountId,
        platform: "ios",
        userAgent: null,
        accessHash: "h1",
        accessExpiresAt: new Date(Date.now() + 60_000),
        refreshHash: "h2",
        expiresAt: new Date(Date.now() + 60_000),
        at: new Date(),
      }),
    ).toBeNull();
    // A bank login that resolved this account just before the erasure
    // publishes no code for it.
    const { rows: requests } = await ctx.client.query<{ id: string }>(
      `INSERT INTO auth_request (state, nonce, platform, locale, expires_at)
       VALUES ('st-late', 'nonce-late', 'ios', NULL, now() + interval '5 minutes') RETURNING id`,
    );
    const requestId = requests[0]?.id ?? "";
    expect(
      await repo.attachCode(ctx.client, {
        id: requestId,
        codeHash: "late-code",
        codeExpiresAt: new Date(Date.now() + 60_000),
        accountId: a.accountId,
        outcome: "resumed",
      }),
    ).toBe(false);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM auth_request WHERE account_id = $1", [
        a.accountId,
      ]),
    ).toBe(0);
    for (const table of ["photo", "photo_access", "session"]) {
      expect(
        await count(ctx, `SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [a.accountId]),
        table,
      ).toBe(0);
    }
    expect(store.objects.size).toBe(0);
  });

  it("AccountState mirrors the database enum", () => {
    expect([...AccountState.options]).toEqual([...accountState.enumValues]);
  });

  test("The audit log survives the erasure", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    const photo = await upload(app, a.headers, await fixturePng(240, 240));
    expect(
      (await app.request(`/admin/photos/${photo.id}/card`, { headers: staff.headers })).status,
    ).toBe(200);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM audit_log WHERE subject_id = $1", [photo.id]),
    ).toBe(1);
    expect((await del(app, a.headers)).status).toBe(204);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM audit_log WHERE subject_id = $1", [photo.id]),
    ).toBe(1);
    // Staff rows belong to the moderator, not to the account.
    expect(await count(ctx, "SELECT count(*) AS n FROM admin_session")).toBe(1);
  });

  test("The export lists the account, the identity's dates, the devices, the photos with URLs and the fetch log", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    await upload(app, b.headers, await fixturePng(111, 111));
    const photo = await upload(
      app,
      a.headers,
      await fixtureJpeg({ width: 600, height: 800, exif: false }),
    );
    const staff = await staffSession(ctx.client);
    await ctx.client.query("UPDATE photo SET state = 'queued' WHERE id = $1", [photo.id]);
    expect(
      (
        await app.request(`/admin/photos/${photo.id}/decision`, {
          method: "POST",
          headers: { ...staff.headers, "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(200);
    expect((await app.request(`/photos/${photo.id}/thumb`, { headers: a.headers })).status).toBe(
      200,
    );

    const res = await app.request("/account/export", { headers: a.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("kuutti-export.json");
    const body = AccountExport.parse(await res.json());
    expect(body.account).toMatchObject({
      id: a.accountId,
      state: "active",
      birthYear: 1990,
      birthMonth: 6,
    });
    expect(body.identity.deletionCount).toBe(0);
    expect(body.identity.firstSeenAt).toBeTruthy();
    expect(body.sessions.map((s) => s.sessionId)).toEqual([a.sessionId]);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toMatchObject({
      id: photo.id,
      state: "approved",
      review: { decision: "approved", reason: null, decidedByStaff: true },
    });
    expect(body.photos[0]?.review?.decidedAt).toBeTruthy();
    const urls = body.photos[0]?.urls;
    expect(urls && new URL(urls.thumb).pathname).toMatch(/\/media\/[0-9a-f]{64}\/thumb\.webp$/);
    expect(urls && new URL(urls.full).searchParams.get("Signature")).toBeTruthy();
    // One fetch before the export, plus the three URLs the export itself issued, newest first.
    expect(body.photoAccessLog).toHaveLength(4);
    expect(body.photoAccessLog.every((e) => e.photoId === photo.id)).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain(b.accountId);
    expect(text).not.toMatch(/hetu|hmac|research_id|researchId/i);
    expect(text).not.toContain(staff.identityId);
  });

  test("The export works without object storage, with no URLs", async ({ ctx }) => {
    const { app } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position) VALUES ($1, 'k', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0)`,
      [a.accountId],
    );
    const res = await app.request("/account/export", { headers: a.headers });
    expect(res.status).toBe(200);
    const body = AccountExport.parse(await res.json());
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]?.urls).toBeNull();
    expect(body.photos[0]?.review).toBeNull();
  });

  test("Deletion and export refuse without a session", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    for (const headers of [{}, staff.headers]) {
      expect((await del(app, headers)).status).toBe(401);
      expect((await app.request("/account/export", { headers })).status).toBe(401);
    }
    expect(await count(ctx, "SELECT count(*) AS n FROM account WHERE state = 'deleted'")).toBe(0);
  });
});

describe("account erasure and export: the edges", () => {
  test("The export names each device by its platform and leaves out the ended ones", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client);
    const { rows } = await ctx.client.query<{ id: string; platform: string }>(
      `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, expires_at, revoked_at)
       VALUES ($1, 'android', 'edge-a1', now() + interval '15 minutes', 'edge-r1', now() + interval '90 days', NULL),
              ($1, 'android', 'edge-a2', now() + interval '15 minutes', 'edge-r2', now() + interval '90 days', now())
       RETURNING id, platform`,
      [a.accountId],
    );
    const [android, ended] = rows;
    const res = await app.request("/account/export", { headers: a.headers });
    expect(res.status).toBe(200);
    const body = AccountExport.parse(await res.json());
    expect(
      body.sessions
        .map((s) => ({ id: s.sessionId, platform: s.platform }))
        .sort((x, y) => x.platform.localeCompare(y.platform)),
    ).toEqual([
      { id: android?.id, platform: "android" },
      { id: a.sessionId, platform: "ios" },
    ]);
    expect(body.sessions.map((s) => s.sessionId)).not.toContain(ended?.id);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("Erasure and export of an account that does not exist answer 404 and touch nothing", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => new Date("2026-10-01T12:00:00Z") };
    const nobody = "00000000-0000-4000-8000-00000000dead";
    await expect(eraseAccount(deps, nobody)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(exportAccount(deps, nobody)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(lines().filter((l) => l.msg === "account erased")).toEqual([]);
  });
});
