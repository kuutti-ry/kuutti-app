import { accountState, identityStanding } from "@kuutti/db";
import { AccountExport, AccountState, IdentityStanding, Photo } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { objectKey } from "../media/index.ts";
import { prunePhotoCheckNotes } from "../safety/index.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { exportOf, openExport } from "../test/export.ts";
import { captureLogger, englishT, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixtureJpeg, fixturePng, testMediaDeps } from "../test/media.ts";
import { eraseAccount, exportAccount } from "./erasure.ts";
import { REREGISTER_COOLDOWN_DAYS } from "./registration.ts";

// features/identity/erasure.feature through the routes (#51, TD-7): real
// Postgres in a rolled-back transaction, a memory store standing in for the
// bucket. Photos are uploaded through the API so the objects exist.

const DAY_MS = 24 * 60 * 60 * 1000;

async function appWith(ctx: TestContext, options: { media?: false; now?: () => Date } = {}) {
  await withMatchingConfig(ctx.client, {
    max_photos: 6,
    photo_moderation_label_threshold: 60,
    photo_moderation_face_threshold: 90,
    exports_per_day: 3,
  });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps();
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    ...(options.media === false ? {} : { media: media.deps }),
    ...(options.now ? { now: options.now } : {}),
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

  test("The export is a zip with the account, the identity's dates, the devices, the photos as files and the fetch log", async ({
    ctx,
  }) => {
    // Fixed at 23:30 in Helsinki: the file is named by the Finnish day, not UTC's.
    const at = new Date("2026-10-01T20:30:00Z");
    const { app, store } = await appWith(ctx, { now: () => at });
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
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="kuutti-data-2026-10-01.zip"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { document: body, files } = await openExport(res);
    // The document beside the photos, both named without anything about the person.
    expect([...files.keys()].sort()).toEqual(
      ["kuutti-data-2026-10-01.json", `photos/${photo.id}.webp`].sort(),
    );
    expect(body.exportedAt).toBe(at.toISOString());
    expect(body.exportedBy).toBe("0.0.0-test");
    expect(body.exports).toEqual([{ at: at.toISOString() }]);
    expect(body.account).toMatchObject({
      id: a.accountId,
      state: "active",
      birthYear: 1990,
      birthMonth: 6,
    });
    expect(body.identity.deletionCount).toBe(0);
    expect(body.identity.firstSeenAt).toBeTruthy();
    expect(body.sessions.map((s) => s.sessionId)).toEqual([a.sessionId]);
    expect(body.sessions[0]?.userAgent).toBeNull();
    expect(body.cardsShown).toEqual([]);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toMatchObject({
      id: photo.id,
      state: "approved",
      review: { decision: "approved", reason: null, decidedByStaff: true },
    });
    expect(body.photos[0]?.review?.decidedAt).toBeTruthy();
    // The file is the full variant as stored, byte for byte.
    expect(body.photos[0]?.file).toBe(`photos/${photo.id}.webp`);
    const { rows } = await ctx.client.query<{ key: string }>(
      "SELECT key FROM photo WHERE id = $1",
      [photo.id],
    );
    const stored = store.objects.get(objectKey(rows[0]?.key ?? "", "full"));
    expect(
      stored && Buffer.compare(stored, files.get(`photos/${photo.id}.webp`) ?? Buffer.alloc(0)),
    ).toBe(0);
    // One fetch before the export, plus the export's own read of the full variant.
    expect(body.photoAccessLog.map((e) => e.variant).sort()).toEqual(["full", "thumb"]);
    expect(body.photoAccessLog.every((e) => e.photoId === photo.id)).toBe(true);
    // No signed URLs in the document any more (#237), so no random signature
    // can spell a word by chance (CI, 13/10/2026): the whole document is checked.
    const text = JSON.stringify(body);
    expect(text).not.toContain(b.accountId);
    expect(text).not.toMatch(/hetu|hmac|research_id|researchId/i);
    expect(text).not.toContain(staff.identityId);
  });

  test("The export works without object storage, with no photo files", async ({ ctx }) => {
    const { app } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position) VALUES ($1, 'k', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0)`,
      [a.accountId],
    );
    const { document: body, files } = await openExport(
      await app.request("/account/export", { headers: a.headers }),
    );
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]?.file).toBeNull();
    expect(body.photos[0]?.review).toBeNull();
    expect(body.photoAccessLog).toEqual([]);
    expect([...files.keys()]).toHaveLength(1);
  });

  test("The fourth copy of the day is refused until midnight, and the export lists the day's copies", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    // Yesterday's copy does not count; the day is the Finnish one.
    await ctx.client.query(
      "INSERT INTO account_export (account_id, at) VALUES ($1, now() - interval '2 days')",
      [a.accountId],
    );
    for (const n of [1, 2, 3]) {
      const body = await exportOf(app, a.headers);
      expect(body.exports, `copy ${n}`).toHaveLength(n + 1);
    }
    const refused = await app.request("/account/export", { headers: a.headers });
    expect(refused.status).toBe(429);
    const envelope = (await refused.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("export_budget_exceeded");
    expect(envelope.error.message).toMatch(/after midnight/);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(24 * 3600);
    expect(logs().find((l) => l.msg === "export refused")).toMatchObject({
      accountId: a.accountId,
      used: 3,
      limit: 3,
      reason: "budget",
    });
    // Nothing written over the cap; the other account's day is its own.
    expect(
      await count(ctx, "SELECT count(*) AS n FROM account_export WHERE account_id = $1", [
        a.accountId,
      ]),
    ).toBe(4);
    expect((await exportOf(app, b.headers)).exports).toHaveLength(1);
  });

  test("The export requests go with the account", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    await exportOf(app, a.headers);
    await exportOf(app, b.headers);
    expect((await del(app, a.headers)).status).toBe(204);
    const of = (id: string) =>
      count(ctx, "SELECT count(*) AS n FROM account_export WHERE account_id = $1", [id]);
    expect(await of(a.accountId)).toBe(0);
    expect(await of(b.accountId)).toBe(1);
    expect(logs().find((l) => l.msg === "account erased")).toMatchObject({ exports: 1 });
  });

  test("The feedback goes with the account, and the export lists it until then", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const send = (headers: Record<string, string>, kind: string) =>
      app.request("/feedback", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          text: `a few lines about ${kind}`,
          appVersion: "0.22.0",
          platform: "android",
          locale: "sv",
        }),
      });
    expect((await send(a.headers, "idea")).status).toBe(204);
    expect((await send(b.headers, "praise")).status).toBe(204);
    const document = await exportOf(app, a.headers);
    expect(document.feedback).toEqual([
      {
        at: expect.any(String),
        kind: "idea",
        text: "a few lines about idea",
        appVersion: "0.22.0",
        platform: "android",
        locale: "sv",
        handledAt: null,
      },
    ]);
    expect(JSON.stringify(document)).not.toContain("praise");
    expect((await del(app, a.headers)).status).toBe(204);
    const of = (id: string) =>
      count(ctx, "SELECT count(*) AS n FROM feedback WHERE account_id = $1", [id]);
    expect(await of(a.accountId)).toBe(0);
    expect(await of(b.accountId)).toBe(1);
    expect(logs().find((l) => l.msg === "account erased")).toMatchObject({ feedback: 1 });
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
    const body = await exportOf(app, a.headers);
    expect(
      body.sessions
        .map((s) => ({ id: s.sessionId, platform: s.platform }))
        .sort((x, y) => x.platform.localeCompare(y.platform)),
    ).toEqual([
      { id: android?.id, platform: "android" },
      { id: a.sessionId, platform: "ios" },
    ]);
    expect(body.sessions.map((s) => s.sessionId)).not.toContain(ended?.id);
  });

  test("Erasure and export of an account that does not exist answer 404 and touch nothing", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const deps = {
      db: ctx.client,
      logger,
      now: () => new Date("2026-10-01T12:00:00Z"),
      version: "test",
    };
    const nobody = "00000000-0000-4000-8000-00000000dead";
    await expect(eraseAccount(deps, nobody)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(exportAccount(deps, nobody, englishT)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(lines().filter((l) => l.msg === "account erased")).toEqual([]);
  });
});

describe("the photo check's notes in erasure and export (#253)", () => {
  const DAY = 86_400_000;
  const note = (ctx: TestContext, accountId: string, at: Date, kind = "nudity", photoId?: string) =>
    ctx.client.query(
      "INSERT INTO photo_check_note (account_id, photo_id, kind, at) VALUES ($1, $2, $3, $4)",
      [accountId, photoId ?? null, kind, at],
    );
  const notesOf = (ctx: TestContext, accountId: string) =>
    count(ctx, "SELECT count(*) AS n FROM photo_check_note WHERE account_id = $1", [accountId]);

  test("The notes go after twelve months, and with the account", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const now = new Date();
    const photo = await upload(app, a.headers, await fixturePng(111, 111));
    await note(ctx, a.accountId, new Date(now.getTime() - 366 * DAY));
    await note(ctx, a.accountId, new Date(now.getTime() - 364 * DAY));
    await note(ctx, a.accountId, new Date(now.getTime() - DAY), "violence", photo.id);
    await note(ctx, b.accountId, new Date(now.getTime() - 400 * DAY));
    await note(ctx, b.accountId, new Date(now.getTime() - DAY));

    expect(await prunePhotoCheckNotes(ctx.client, now)).toBe(2);
    expect(await notesOf(ctx, a.accountId)).toBe(2);
    expect(await notesOf(ctx, b.accountId)).toBe(1);

    expect((await del(app, a.headers)).status).toBe(204);
    expect(await notesOf(ctx, a.accountId)).toBe(0);
    // Only the caller's: the other account keeps its own.
    expect(await notesOf(ctx, b.accountId)).toBe(1);
  });

  test("The person reads the notes in their export in plain words", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const now = Date.now();
    const first = new Date(now - 20 * DAY);
    const second = new Date(now - 9 * DAY);
    await note(ctx, a.accountId, first);
    await note(ctx, a.accountId, second, "hate");

    const fi = await app.request("/account/export", {
      headers: { ...a.headers, "accept-language": "fi" },
    });
    // The file is named in the request's language too, ASCII only.
    expect(fi.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kuutti-tiedot-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const { document: body, files } = await openExport(fi);
    expect([...files.keys()]).toEqual([expect.stringMatching(/^kuutti-tiedot-.*\.json$/)]);
    expect(body.photoCheck.about).toMatch(/^Kuutti tarkistaa jokaisen kuvan/);
    expect(body.photoCheck.photosNotShown).toEqual([
      {
        at: first.toISOString(),
        kind: "nudity",
        reason: "Saattaa näyttää enemmän kuin Kuutti sallii",
      },
      {
        at: second.toISOString(),
        kind: "hate",
        reason: "Saattaa näyttää symbolin, jota Kuutti ei salli",
      },
    ]);
    expect(body.photoCheck.carefulCheckUntil).toBe(
      new Date(second.getTime() + 30 * DAY).toISOString(),
    );

    // In English too, and in words that accuse nobody.
    const en = await exportOf(app, a.headers);
    expect(en.photoCheck.photosNotShown.map((p) => p.reason)).toEqual([
      "May show more than Kuutti allows",
      "May show a symbol Kuutti does not allow",
    ]);
    expect(JSON.stringify(en.photoCheck)).not.toMatch(/strike|flag|violat|offen[cs]e|suspic|ban/i);

    // Another account's export holds none of it.
    const theirs = await exportOf(app, b.headers);
    expect(theirs.photoCheck.photosNotShown).toEqual([]);
    expect(theirs.photoCheck.carefulCheckUntil).toBeNull();
  });
});

describe("account erasure and export: what the verification of 08/10 found (#51)", () => {
  it("IdentityStanding mirrors the database enum", () => {
    expect([...IdentityStanding.options]).toEqual([...identityStanding.enumValues]);
  });

  test("The consent rows go with the account", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    for (const who of [a, b]) {
      await ctx.client.query(
        `INSERT INTO consent (account_id, kind, version, locale_shown, given_at, withdrawn_at) VALUES
           ($1, 'terms', 'v1', 'fi', now() - interval '2 days', NULL),
           ($1, 'privacy', 'v1', 'fi', now() - interval '2 days', NULL),
           ($1, 'research', 'v1', 'fi', now() - interval '2 days', $2)`,
        [who.accountId, who === a ? new Date() : null],
      );
    }
    const consents = (id: string) =>
      count(ctx, "SELECT count(*) AS n FROM consent WHERE account_id = $1", [id]);
    expect(await consents(a.accountId)).toBe(3);
    expect((await del(app, a.headers)).status).toBe(204);
    expect(await consents(a.accountId)).toBe(0);
    expect(await consents(b.accountId)).toBe(3);
    expect(logs().find((l) => l.msg === "account erased")).toMatchObject({ consents: 3 });
  });

  test("The cards shown to the person are in the export and go with the account", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const mine = await upload(app, a.headers, await fixturePng(130, 130));
    const theirs = await upload(app, b.headers, await fixturePng(140, 140));
    await ctx.client.query(
      `INSERT INTO card_shown (account_id, photo_id, at)
       VALUES ($1, $2, now() - interval '1 day'), ($3, $4, now())`,
      [a.accountId, theirs.id, b.accountId, mine.id],
    );
    const body = await exportOf(app, a.headers);
    expect(body.cardsShown.map((c) => c.photoId)).toEqual([theirs.id]);
    expect(JSON.stringify(body)).not.toContain(b.accountId);

    const shown = (id: string) =>
      count(ctx, "SELECT count(*) AS n FROM card_shown WHERE account_id = $1", [id]);
    expect((await del(app, a.headers)).status).toBe(204);
    expect(await shown(a.accountId)).toBe(0);
    // "B" was shown "A"'s card: that row went with the photo, not with "B".
    expect(await shown(b.accountId)).toBe(0);
    expect(await count(ctx, "SELECT count(*) AS n FROM photo WHERE id = $1", [theirs.id])).toBe(1);
    expect(logs().find((l) => l.msg === "account erased")).toMatchObject({ shownRows: 1 });
  });

  test("A moderator's role and panel session survive the erasure of their own account", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client, "a");
    const { rows } = await ctx.client.query<{ identity_id: string }>(
      "SELECT identity_id FROM account WHERE id = $1",
      [a.accountId],
    );
    const identityId = rows[0]?.identity_id ?? "";
    await ctx.client.query(
      "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
      [identityId],
    );
    await ctx.client.query(
      `INSERT INTO admin_session (identity_id, role, access_hash, expires_at)
       VALUES ($1, 'moderator', 'mod-a', now() + interval '8 hours')`,
      [identityId],
    );
    expect((await del(app, a.headers)).status).toBe(204);
    for (const table of ["moderator_roles", "admin_session"]) {
      expect(
        await count(ctx, `SELECT count(*) AS n FROM ${table} WHERE identity_id = $1`, [identityId]),
        table,
      ).toBe(1);
    }
    // The identity itself stays, with the deletion counted (TD-7).
    expect(
      await count(ctx, "SELECT count(*) AS n FROM identity WHERE id = $1 AND deletion_count = 1", [
        identityId,
      ]),
    ).toBe(1);
  });

  test("The export carries the identity's standing, the refused attempts, the cooldown, the state change and each device's user agent", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { media: false });
    const a = await signedInAccount(ctx.client, "a");
    const until = new Date("2026-09-20T10:00:00Z");
    const changed = new Date("2026-10-01T08:30:00Z");
    await ctx.client.query(
      `UPDATE identity SET deletion_count = 1, refused_attempts = 2, reregister_after = $2
       WHERE id = (SELECT identity_id FROM account WHERE id = $1)`,
      [a.accountId, until],
    );
    await ctx.client.query("UPDATE account SET state_changed_at = $2 WHERE id = $1", [
      a.accountId,
      changed,
    ]);
    await ctx.client.query("UPDATE session SET user_agent = $2 WHERE id = $1", [
      a.sessionId,
      "Kuutti/0.12 (iPhone; iOS 19)",
    ]);
    const body = await exportOf(app, a.headers);
    expect(body.identity).toMatchObject({
      standing: "ok",
      standingChangedAt: null,
      deletionCount: 1,
      refusedAttempts: 2,
      reregisterAfter: until.toISOString(),
    });
    expect(body.account.stateChangedAt).toBe(changed.toISOString());
    expect(body.sessions.map((s) => s.userAgent)).toEqual(["Kuutti/0.12 (iPhone; iOS 19)"]);
  });
});

describe("the sanctions in erasure and export (#307, ADR-024 §8)", () => {
  const T = new Date("2026-10-20T09:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const after = (hours: number) => new Date(T.getTime() + hours * HOUR);

  test("The sanctions go with the account, except the open bans and suspensions, and the export lists them without who", async ({
    ctx,
  }) => {
    let clock = T;
    const { app, logs } = await appWith(ctx, { media: false, now: () => clock });
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const m = await staffSession(ctx.client, "moderator", "m");
    const n = await staffSession(ctx.client, "moderator", "n");
    const d = await staffSession(ctx.client, "admin", "d");
    const post = async (
      staff: { headers: Record<string, string> },
      path: string,
      body?: unknown,
    ): Promise<{ id: string }> => {
      const res = await app.request(path, {
        method: "POST",
        headers: { ...staff.headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, path).toBeLessThan(300);
      return (await res.json()) as { id: string };
    };
    const notes = {
      warn: "Wrote something unkind to a person who reported it",
      suspend: "Advertised a paid service in three chats",
      review: "Read the chats again: one advert, lifting early",
      ban: "A second identity's photos on this profile",
      other: "Copied profiles, by the panel's count",
    };

    // A lifted warning, a suspension lifted on review by somebody else, and an open ban.
    const warning = await post(m, `/admin/accounts/${a.accountId}/sanctions`, {
      kind: "warn",
      reason: "harassment",
      note: notes.warn,
    });
    await post(m, `/admin/accounts/${b.accountId}/sanctions`, {
      kind: "warn",
      reason: "scraping",
      note: notes.other,
    });
    clock = after(1);
    await post(m, `/admin/sanctions/${warning.id}/lift`);
    clock = after(2);
    const suspension = await post(m, `/admin/accounts/${a.accountId}/sanctions`, {
      kind: "suspend",
      reason: "commercial_use",
      note: notes.suspend,
      endsOn: "2026-10-22",
    });
    clock = after(3);
    await post(n, `/admin/sanctions/${suspension.id}/review`, {
      note: notes.review,
      outcome: "lift",
    });
    clock = after(4);
    const ban = await post(d, `/admin/accounts/${a.accountId}/bans`, {
      reason: "misrepresentation",
      note: notes.ban,
    });
    clock = after(5);

    // The ban ended A's sessions, so the export and the erasure are called as their routes call them.
    const { logger, lines } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => clock, version: "0.0.0-test" };
    const { document } = await exportAccount(deps, a.accountId, englishT);
    expect(document.sanctions).toEqual([
      {
        kind: "ban",
        kindInWords: "Banned from Kuutti",
        reason: "misrepresentation",
        reasonInWords: "Pretending to be someone else, or telling untruths about oneself",
        appliedAt: after(4).toISOString(),
        endsAt: null,
        liftedAt: null,
        lookedAtAgain: false,
      },
      {
        kind: "suspend",
        kindInWords: "Suspended until a set day",
        reason: "commercial_use",
        reasonInWords: "Selling or advertising",
        appliedAt: after(2).toISOString(),
        // The start of 22.10.2026 in Finland, summer time.
        endsAt: "2026-10-21T21:00:00.000Z",
        liftedAt: after(3).toISOString(),
        lookedAtAgain: true,
      },
      {
        kind: "warn",
        kindInWords: "A warning",
        reason: "harassment",
        reasonInWords: "Harassment",
        appliedAt: T.toISOString(),
        endsAt: null,
        liftedAt: after(1).toISOString(),
        lookedAtAgain: false,
      },
    ]);
    expect(AccountExport.safeParse(document).success).toBe(true);
    const text = JSON.stringify(document);
    for (const who of [m.identityId, n.identityId, d.identityId, b.accountId]) {
      expect(text).not.toContain(who);
    }
    for (const words of Object.values(notes)) expect(text).not.toContain(words);
    expect(text).not.toMatch(/createdBy|liftedBy|reviewedBy|reviewNote|"note"/);

    const audited = () =>
      count(ctx, "SELECT count(*) AS n FROM audit_log WHERE subject_id = $1", [a.accountId]);
    expect(await audited()).toBe(5);
    const summary = await eraseAccount(deps, a.accountId);
    expect(summary.sanctions).toBe(2);
    expect(lines().find((l) => l.msg === "account erased")).toMatchObject({ sanctions: 2 });

    const { rows: kept } = await ctx.client.query<{
      id: string;
      kind: string;
      account_id: string;
      lifted_at: Date | null;
      standing: string;
    }>(
      `SELECT s.id, s.kind, s.account_id, s.lifted_at, i.standing
       FROM sanction s JOIN identity i ON i.id = s.identity_id
       WHERE s.identity_id = (SELECT identity_id FROM account WHERE id = $1)`,
      [a.accountId],
    );
    expect(kept).toEqual([
      { id: ban.id, kind: "ban", account_id: a.accountId, lifted_at: null, standing: "banned" },
    ]);
    const { rows: theirs } = await ctx.client.query(
      "SELECT kind, reason, note, lifted_at FROM sanction WHERE account_id = $1",
      [b.accountId],
    );
    expect(theirs).toEqual([
      { kind: "warn", reason: "scraping", note: notes.other, lifted_at: null },
    ]);
    // The history stays in the audit log (ADR-024 §8), and no log line of it all carries a note.
    expect(await audited()).toBe(5);
    const logged = JSON.stringify([...logs(), ...lines()]);
    for (const words of Object.values(notes)) expect(logged).not.toContain(words);
  });
});
