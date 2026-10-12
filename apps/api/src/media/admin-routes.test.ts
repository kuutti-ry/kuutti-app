import type { Queryable } from "@kuutti/db";
import { ErrorResponse, PhotoList, PhotoReviewQueue, PhotoUrlResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { TEST_MEDIA_BASE, testMediaDeps } from "../test/media.ts";

// The photo review queue (#49, features/media/moderation.feature): happy
// path, validation, unauthenticated, wrong role, and the audit row behind
// every view and decision. Photos are written straight into the transaction
// in the states moderation would leave them in.

async function appWith(ctx: TestContext) {
  await withMatchingConfig(ctx.client, { max_photos: 6 });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps();
  const app = createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps });
  return { app, logs: lines };
}

async function photoIn(
  ctx: TestContext,
  accountId: string,
  state: "pending" | "queued" | "approved" | "rejected",
  options: { key?: string; labels?: unknown[]; flagged?: string[]; ago?: number } = {},
) {
  const created = new Date(Date.now() - (options.ago ?? 0) * 1000);
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, position, created_at)
     VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, $3,
             (SELECT coalesce(max(position) + 1, 0) FROM photo WHERE account_id = $1), $4) RETURNING id`,
    [accountId, options.key ?? `k-${Math.random().toString(36).slice(2)}`, state, created],
  );
  const id = rows[0]?.id ?? "";
  if (options.labels) {
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision)
       VALUES ($1, $2::jsonb, 1, $3, now(), 'queued')`,
      [id, JSON.stringify(options.labels), options.flagged ?? []],
    );
  }
  return id;
}

const errorCode = async (res: Response) => ErrorResponse.parse(await res.json()).error.code;
const decide = (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  id: string,
  body: unknown,
) =>
  app.request(`/admin/photos/${id}/decision`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("photo review queue", () => {
  test("The queue marks a photo with a sensitive label, and one the owner appealed", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const nude = await photoIn(ctx, owner.accountId, "queued", {
      labels: [{ name: "Explicit Nudity", parentName: "Explicit", confidence: 75 }],
      ago: 30,
    });
    const swim = await photoIn(ctx, owner.accountId, "queued", {
      labels: [
        {
          name: "Female Swimwear or Underwear",
          parentName: "Swimwear or Underwear",
          confidence: 99,
        },
      ],
      ago: 20,
    });
    const appealed = await photoIn(ctx, owner.accountId, "queued", { labels: [], ago: 10 });
    await ctx.client.query("UPDATE photo_review SET appealed_at = now() WHERE photo_id = $1", [
      appealed,
    ]);
    const res = await app.request("/admin/photos/queue", { headers: staff.headers });
    const queue = PhotoReviewQueue.parse(await res.json());
    const flags = Object.fromEntries(
      queue.items.map((i) => [i.photoId, { sensitive: i.sensitive, appealed: i.appealed }]),
    );
    expect(flags).toEqual({
      [nude]: { sensitive: true, appealed: false },
      [swim]: { sensitive: false, appealed: false },
      [appealed]: { sensitive: false, appealed: true },
    });
  });

  test("The queue shows queued photos oldest first with what the check saw", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const older = await photoIn(ctx, owner.accountId, "queued", {
      ago: 600,
      labels: [{ name: "Suggestive", parentName: "", confidence: 71.5 }],
      flagged: ["Suggestive"],
    });
    const newer = await photoIn(ctx, owner.accountId, "queued", {
      ago: 60,
      labels: [],
      flagged: ["no_face"],
    });
    await photoIn(ctx, owner.accountId, "approved");

    const res = await app.request("/admin/photos/queue", { headers: staff.headers });
    expect(res.status).toBe(200);
    const queue = PhotoReviewQueue.parse(await res.json());
    expect(queue.total).toBe(2);
    expect(queue.items.map((i) => i.photoId)).toEqual([older, newer]);
    expect(queue.items[0]).toMatchObject({
      accountId: owner.accountId,
      state: "queued",
      faces: 1,
      flagged: ["Suggestive"],
      labels: [{ name: "Suggestive", parentName: "", confidence: 71.5 }],
    });
    expect(queue.items[0]?.checkedAt).toBeTruthy();
    const limited = PhotoReviewQueue.parse(
      await (await app.request("/admin/photos/queue?limit=1", { headers: staff.headers })).json(),
    );
    expect(limited.items).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(
      (await app.request("/admin/photos/queue?limit=0", { headers: staff.headers })).status,
    ).toBe(400);
    // Nothing the queue returns names hetu_hmac or research_id.
    expect(JSON.stringify(queue)).not.toMatch(/hetu|research/);
  });

  test("Staff view a card through a signed URL and every view is audited", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued", { key: "abc" });
    const res = await app.request(`/admin/photos/${id}/card`, { headers: staff.headers });
    expect(res.status).toBe(200);
    const body = PhotoUrlResponse.parse(await res.json());
    expect(body.variant).toBe("card");
    expect(new URL(body.url).pathname).toBe("/media/abc/card.webp");
    const audit = await ctx.client.query(
      "SELECT actor_identity_id, action, subject_type, subject_id, detail FROM audit_log",
    );
    expect(audit.rows).toEqual([
      {
        actor_identity_id: staff.identityId,
        action: "photo.view",
        subject_type: "photo",
        subject_id: id,
        detail: { variant: "card", state: "queued" },
      },
    ]);
    // A staff view is not a fetch by the owner: no photo_access row, and the log names the staff identity.
    expect(
      Number((await ctx.client.query("SELECT count(*) AS n FROM photo_access")).rows[0]?.n),
    ).toBe(0);
    expect(logs().find((l) => l.msg === "staff photo view")).toMatchObject({
      staffIdentityId: staff.identityId,
      photoId: id,
    });
    expect(
      (
        await app.request("/admin/photos/6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b/card", {
          headers: staff.headers,
        })
      ).status,
    ).toBe(404);
    expect((await app.request("/admin/photos/nope/card", { headers: staff.headers })).status).toBe(
      400,
    );
  });

  test("A moderator approves a queued photo", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued", { labels: [], flagged: ["no_face"] });
    const res = await decide(app, staff.headers, id, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ photoId: id, state: "approved", rejectionReason: null });
    const review = await ctx.client.query(
      "SELECT decision, decided_by, decided_at, reason, flagged FROM photo_review WHERE photo_id = $1",
      [id],
    );
    expect(review.rows[0]).toMatchObject({
      decision: "approved",
      decided_by: staff.identityId,
      reason: null,
      flagged: ["no_face"],
    });
    expect(review.rows[0]?.decided_at).toBeInstanceOf(Date);
    const audit = await ctx.client.query("SELECT action, detail FROM audit_log ORDER BY at");
    expect(audit.rows).toEqual([
      { action: "photo.approve", detail: { from: "queued", to: "approved", reason: null } },
    ]);
  });

  test("A moderator rejects a queued photo with a reason and the owner is told", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    const res = await decide(app, staff.headers, id, { decision: "reject", reason: "no_person" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      photoId: id,
      state: "rejected",
      rejectionReason: "no_person",
    });
    // The list of the owner carries the reason; the owner can still fetch their own rejected photo.
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: owner.headers })).json(),
    );
    expect(list.photos[0]).toMatchObject({ id, state: "rejected", rejectionReason: "no_person" });
    expect((await app.request(`/photos/${id}/thumb`, { headers: owner.headers })).status).toBe(200);
    const audit = await ctx.client.query("SELECT action, detail FROM audit_log");
    expect(audit.rows).toEqual([
      { action: "photo.reject", detail: { from: "queued", to: "rejected", reason: "no_person" } },
    ]);
    // No label name in any log line was ever a risk here; the reason is a code, and the owner sees a text.
  });

  test("A decision is taken once, on a queued photo only, and a refused one leaves no audit row", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const queued = await photoIn(ctx, owner.accountId, "queued", { labels: [] });
    const pending = await photoIn(ctx, owner.accountId, "pending");
    const rejected = await photoIn(ctx, owner.accountId, "rejected");
    expect((await decide(app, staff.headers, queued, { decision: "approve" })).status).toBe(200);
    // The same photo again, a photo the check has not finished, and an earlier rejection.
    for (const id of [queued, pending, rejected]) {
      const res = await decide(app, staff.headers, id, { decision: "approve" });
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("photo_not_queued");
    }
    const states = await ctx.client.query<{ id: string; state: string }>(
      "SELECT id, state FROM photo WHERE id = ANY($1::uuid[])",
      [[queued, pending, rejected]],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.id, r.state]))).toEqual({
      [queued]: "approved",
      [pending]: "pending",
      [rejected]: "rejected",
    });
    const audit = await ctx.client.query("SELECT action FROM audit_log");
    expect(audit.rows).toEqual([{ action: "photo.approve" }]);
  });

  test("A rejection needs a reason from the list", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    expect((await decide(app, staff.headers, id, { decision: "reject" })).status).toBe(400);
    expect(
      (await decide(app, staff.headers, id, { decision: "reject", reason: "ugly" })).status,
    ).toBe(400);
    expect((await decide(app, staff.headers, id, { decision: "maybe" })).status).toBe(400);
    expect(
      (await decide(app, staff.headers, id, { decision: "approve", reason: "nudity" })).status,
    ).toBe(400);
    const state = await ctx.client.query("SELECT state FROM photo WHERE id = $1", [id]);
    expect(state.rows[0]?.state).toBe("queued");
    expect(Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n)).toBe(
      0,
    );
  });

  test("A researcher may not touch the photo queue", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const researcher = await staffSession(ctx.client, "researcher");
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    for (const res of [
      await app.request("/admin/photos/queue", { headers: researcher.headers }),
      await app.request(`/admin/photos/${id}/card`, { headers: researcher.headers }),
      await decide(app, researcher.headers, id, { decision: "approve" }),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("admin_forbidden");
    }
    expect(Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n)).toBe(
      0,
    );
    expect(
      (await ctx.client.query("SELECT state FROM photo WHERE id = $1", [id])).rows[0]?.state,
    ).toBe("queued");
    // whoami answers every role.
    const me = await app.request("/admin/whoami", { headers: researcher.headers });
    expect(me.status).toBe(200);
    expect((await me.json()).role).toBe("researcher");
  });

  test("The photo routes for staff refuse a product session and no session", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    for (const headers of [owner.headers, {}]) {
      for (const res of [
        await app.request("/admin/photos/queue", { headers }),
        await app.request(`/admin/photos/${id}/card`, { headers }),
        await decide(app, headers, id, { decision: "approve" }),
      ]) {
        expect(res.status).toBe(401);
        expect(await errorCode(res)).toBe("unauthenticated");
      }
    }
    expect(Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n)).toBe(
      0,
    );
    void TEST_MEDIA_BASE;
  });
});

const auditRows = async (ctx: TestContext) =>
  Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n);

describe("photo review queue, the remaining branches", () => {
  test("An admin works the queue as a moderator does", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const admin = await staffSession(ctx.client, "admin");
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    expect((await app.request("/admin/photos/queue", { headers: admin.headers })).status).toBe(200);
    expect((await app.request(`/admin/photos/${id}/card`, { headers: admin.headers })).status).toBe(
      200,
    );
    expect((await decide(app, admin.headers, id, { decision: "approve" })).status).toBe(200);
    const audit = await ctx.client.query(
      "SELECT actor_identity_id, action FROM audit_log ORDER BY at",
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(["photo.approve", "photo.view"]);
    expect(new Set(audit.rows.map((r) => r.actor_identity_id))).toEqual(
      new Set([admin.identityId]),
    );
  });

  test("A staff session that was ended, has expired, lost its role or was never issued is refused with its own code", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    const ended = await staffSession(ctx.client);
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const expired = await staffSession(ctx.client);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const demoted = await staffSession(ctx.client);
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      demoted.identityId,
    ]);
    for (const [what, headers, code] of [
      ["a malformed token", { authorization: "Bearer nope" }, "unauthenticated"],
      ["a token nobody issued", { authorization: `Bearer ${"B".repeat(43)}` }, "unauthenticated"],
      ["an ended session", ended.headers, "session_revoked"],
      ["a role taken away", demoted.headers, "session_revoked"],
      ["an expired session", expired.headers, "session_expired"],
    ] as const) {
      for (const res of [
        await app.request("/admin/photos/queue", { headers }),
        await app.request(`/admin/photos/${id}/card`, { headers }),
        await decide(app, headers, id, { decision: "approve" }),
      ]) {
        expect(res.status, what).toBe(401);
        expect(await errorCode(res), what).toBe(code);
      }
    }
    expect(await auditRows(ctx)).toBe(0);
    expect(
      (await ctx.client.query("SELECT state FROM photo WHERE id = $1", [id])).rows[0]?.state,
    ).toBe("queued");
  });

  test("Without object storage the card is media_unavailable and no view is audited", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { max_photos: 6 });
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    const res = await app.request(`/admin/photos/${id}/card`, { headers: staff.headers });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("media_unavailable");
    expect(await auditRows(ctx)).toBe(0);
    // The queue and the decision need no storage.
    expect((await app.request("/admin/photos/queue", { headers: staff.headers })).status).toBe(200);
    expect((await decide(app, staff.headers, id, { decision: "approve" })).status).toBe(200);
  });

  test("The card of a photo nobody has audits nothing; a decision on one is a 404 and audits nothing", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const nobody = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
    expect(
      (await app.request(`/admin/photos/${nobody}/card`, { headers: staff.headers })).status,
    ).toBe(404);
    const res = await decide(app, staff.headers, nobody, { decision: "reject", reason: "nudity" });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect((await decide(app, staff.headers, "nope", { decision: "approve" })).status).toBe(400);
    expect(await auditRows(ctx)).toBe(0);
  });

  test("Of two moderators deciding at once, the one whose update finds the photo decided is refused and its audit row goes with it", async ({
    ctx,
  }) => {
    // The other moderator's decision lands between this one's read and its
    // update: the update is keyed on the queued state and finds nothing.
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    let landed = false;
    const db = {
      async query(text: string, values?: unknown[]) {
        const result = await ctx.client.query(text, values);
        // Right after this moderator's read of the photo, the other's decision commits.
        if (!landed && text.endsWith(", account_id FROM photo WHERE id = $1")) {
          landed = true;
          await ctx.client.query("UPDATE photo SET state = 'approved' WHERE id = $1", [id]);
        }
        return result;
      },
    } as Queryable;
    await withMatchingConfig(ctx.client, { max_photos: 6 });
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db, media: testMediaDeps().deps });
    const staff = await staffSession(ctx.client);
    const res = await decide(app, staff.headers, id, { decision: "reject", reason: "nudity" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("photo_not_queued");
    expect(await auditRows(ctx)).toBe(0);
    const after = await ctx.client.query(
      "SELECT p.state, p.rejection_reason, (SELECT count(*) FROM photo_review r WHERE r.photo_id = p.id) AS reviews FROM photo p WHERE p.id = $1",
      [id],
    );
    expect(after.rows[0]).toEqual({ state: "approved", rejection_reason: null, reviews: "0" });
  });

  test("A queued photo the check never recorded shows with no labels, no faces and no check time", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    const queue = PhotoReviewQueue.parse(
      await (await app.request("/admin/photos/queue", { headers: staff.headers })).json(),
    );
    expect(queue.items).toEqual([
      expect.objectContaining({
        photoId: id,
        checkedAt: null,
        labels: [],
        faces: 0,
        flagged: [],
      }),
    ]);
  });

  test("The queue answers twenty by default and refuses a limit over a hundred", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    for (let i = 0; i < 21; i += 1) await photoIn(ctx, owner.accountId, "queued", { ago: 100 - i });
    const queue = PhotoReviewQueue.parse(
      await (await app.request("/admin/photos/queue", { headers: staff.headers })).json(),
    );
    expect(queue.items).toHaveLength(20);
    expect(queue.total).toBe(21);
    for (const limit of ["101", "abc", "-1"]) {
      const res = await app.request(`/admin/photos/queue?limit=${limit}`, {
        headers: staff.headers,
      });
      expect(res.status, limit).toBe(400);
      expect(await errorCode(res), limit).toBe("validation_failed");
    }
  });
});
