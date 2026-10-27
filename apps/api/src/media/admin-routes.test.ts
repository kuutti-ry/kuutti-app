import type { Queryable } from "@kuutti/db";
import { ErrorResponse, PhotoList, PhotoReviewQueue, PhotoUrlResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { TEST_MEDIA_BASE, testMediaDeps } from "../test/media.ts";
import { rejectUnreviewedPhotos } from "./moderation.ts";

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
       VALUES ($1, $2::jsonb, 1, $3, now(), $4)`,
      [
        id,
        JSON.stringify(options.labels),
        options.flagged ?? [],
        state === "approved" ? "approved" : "queued",
      ],
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

  test("The queue puts first what has waited longest, an appealed photo from its appeal (#303)", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    // Uploaded first, but back in the queue only by an appeal after the second's upload.
    const appealed = await photoIn(ctx, owner.accountId, "queued", { labels: [], ago: 600 });
    await ctx.client.query(
      "UPDATE photo_review SET appealed_at = now() - interval '10 seconds' WHERE photo_id = $1",
      [appealed],
    );
    const waiting = await photoIn(ctx, owner.accountId, "queued", { labels: [], ago: 60 });
    const res = await app.request("/admin/photos/queue", { headers: staff.headers });
    const queue = PhotoReviewQueue.parse(await res.json());
    expect(queue.items.map((i) => i.photoId)).toEqual([waiting, appealed]);
  });

  test("The queue shows queued photos oldest first with what the check saw", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const older = await photoIn(ctx, owner.accountId, "queued", {
      ago: 600,
      labels: [
        { name: "Suggestive", parentName: "", confidence: 71.5 },
        // Tip signals stored beside it (#56): the owner's, never shown to a moderator.
        { name: "Bathroom", parentName: "Indoors", confidence: 46 },
        { name: "Cod", parentName: "Animal", confidence: 41 },
        { name: "Sunglasses", parentName: "Face", confidence: 99 },
        { name: "Brightness", parentName: "Face", confidence: 80 },
      ],
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

  test("An approval is taken once, on a queued photo only, and a refused one leaves no audit row", async ({
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
    // The night's reason is no moderator's to choose (#376).
    expect(
      (await decide(app, staff.headers, id, { decision: "reject", reason: "not_reviewed" })).status,
    ).toBe(400);
    // A take-down is a rejection too, with the same list (#477).
    const approved = await photoIn(ctx, owner.accountId, "approved");
    for (const body of [
      { decision: "take_down" },
      { decision: "take_down", reason: "ugly" },
      { decision: "take_down", reason: "not_reviewed" },
    ]) {
      expect((await decide(app, staff.headers, approved, body)).status).toBe(400);
    }
    const states = await ctx.client.query<{ id: string; state: string }>(
      "SELECT id, state FROM photo WHERE id = ANY($1::uuid[])",
      [[id, approved]],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.id, r.state]))).toEqual({
      [id]: "queued",
      [approved]: "approved",
    });
    expect(Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n)).toBe(
      0,
    );
  });

  test("A researcher may not touch the photo queue", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const researcher = await staffSession(ctx.client, "researcher");
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    const approved = await photoIn(ctx, owner.accountId, "approved");
    for (const res of [
      await app.request("/admin/photos/queue", { headers: researcher.headers }),
      await app.request(`/admin/photos/${id}/card`, { headers: researcher.headers }),
      await decide(app, researcher.headers, id, { decision: "approve" }),
      // Nor take an approved photo down (#477).
      await decide(app, researcher.headers, approved, { decision: "take_down", reason: "other" }),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("admin_forbidden");
    }
    expect(Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n)).toBe(
      0,
    );
    const states = await ctx.client.query<{ id: string; state: string }>(
      "SELECT id, state FROM photo WHERE id = ANY($1::uuid[])",
      [[id, approved]],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.id, r.state]))).toEqual({
      [id]: "queued",
      [approved]: "approved",
    });
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
        if (!landed && text.includes(", account_id FROM photo WHERE id = $1")) {
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

// Taking an approved photo down (#477, ADR-006 §2, features/media/moderation.feature):
// the same decision route, a rejection keyed on the approved state; not a
// sanction, and nothing of the photo deleted.
describe("taking an approved photo down", () => {
  /** The viewer was shown these photos on a card, as a served card leaves it (#84). */
  const shownTo = (ctx: TestContext, viewerAccountId: string, photoIds: string[]) =>
    ctx.client.query(
      "INSERT INTO card_shown (account_id, photo_id, at) SELECT $1, unnest($2::uuid[]), now()",
      [viewerAccountId, photoIds],
    );
  const standingOf = async (ctx: TestContext, accountId: string) =>
    (
      await ctx.client.query(
        `SELECT a.state, i.standing, i.standing_changed_at FROM account a
         JOIN identity i ON i.id = a.identity_id WHERE a.id = $1`,
        [accountId],
      )
    ).rows[0];
  const count = async (ctx: TestContext, text: string, values: unknown[]) =>
    Number((await ctx.client.query<{ n: string }>(text, values)).rows[0]?.n);

  test("A moderator takes down an approved photo with a reason, and the owner is told", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    await withMatchingConfig(ctx.client, {
      photo_fetches_per_day: { thumb: 20, card: 20, full: 20 },
    });
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const viewer = await signedInAccount(ctx.client);
    const labels = [{ name: "Smoking", parentName: "Drugs & Tobacco", confidence: 99 }];
    const taken = await photoIn(ctx, owner.accountId, "approved", { labels, key: "k-taken" });
    const kept = await photoIn(ctx, owner.accountId, "approved");
    await shownTo(ctx, viewer.accountId, [taken, kept]);
    const card = (id: string, headers: Record<string, string>) =>
      app.request(`/photos/${id}/card`, { headers });
    expect((await card(taken, viewer.headers)).status).toBe(200);
    const standing = await standingOf(ctx, owner.accountId);

    const res = await decide(app, staff.headers, taken, { decision: "take_down", reason: "other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      photoId: taken,
      state: "rejected",
      rejectionReason: "other",
    });

    // Nobody else is served it; the rest of the card still is, and the owner still has their own.
    const refused = await card(taken, viewer.headers);
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe("not_found");
    expect((await card(kept, viewer.headers)).status).toBe(200);
    expect((await card(taken, owner.headers)).status).toBe(200);
    // The owner's list says why, as after a person's rejection in the queue, with no appeal.
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: owner.headers })).json(),
    );
    expect(list.photos.map((p) => [p.id, p.state, p.rejectionReason, p.appealable])).toEqual([
      [taken, "rejected", "other", false],
      [kept, "approved", null, false],
    ]);
    const appeal = await app.request(`/photos/${taken}/appeal`, {
      method: "POST",
      headers: owner.headers,
    });
    expect(appeal.status).toBe(409);
    // The review names the moderator and keeps what the check saw; the audit row says from what.
    const review = await ctx.client.query(
      "SELECT decision, decided_by, reason, labels FROM photo_review WHERE photo_id = $1",
      [taken],
    );
    expect(review.rows).toEqual([
      { decision: "rejected", decided_by: staff.identityId, reason: "other", labels },
    ]);
    const audit = await ctx.client.query(
      "SELECT actor_identity_id, action, subject_type, subject_id, detail FROM audit_log",
    );
    expect(audit.rows).toEqual([
      {
        actor_identity_id: staff.identityId,
        action: "photo.reject",
        subject_type: "photo",
        subject_id: taken,
        detail: { from: "approved", to: "rejected", reason: "other" },
      },
    ]);
    expect(logs().find((l) => l.msg === "photo decided")).toMatchObject({
      photoId: taken,
      from: "approved",
      to: "rejected",
      reason: "other",
    });
    // Not a sanction: no sanction row and the standing as it was; no check note; nothing deleted.
    expect(
      await count(ctx, "SELECT count(*) AS n FROM sanction WHERE account_id = $1", [
        owner.accountId,
      ]),
    ).toBe(0);
    expect(await standingOf(ctx, owner.accountId)).toEqual(standing);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM photo_check_note WHERE account_id = $1", [
        owner.accountId,
      ]),
    ).toBe(0);
    expect((await ctx.client.query("SELECT key FROM photo WHERE id = $1", [taken])).rows).toEqual([
      { key: "k-taken" },
    ]);
  });

  test("A rejection from the queue never takes down a photo approved meanwhile", async ({
    ctx,
  }) => {
    // Two moderators read the same queue; one approves, and the other's
    // rejection arrives after it has committed, from the list read before.
    const { app } = await appWith(ctx);
    const first = await staffSession(ctx.client);
    const second = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued");
    expect((await decide(app, first.headers, id, { decision: "approve" })).status).toBe(200);
    for (const body of [{ decision: "reject", reason: "other" }, { decision: "approve" }]) {
      const res = await decide(app, second.headers, id, body);
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("photo_not_queued");
    }
    const after = await ctx.client.query(
      "SELECT state, rejection_reason FROM photo WHERE id = $1",
      [id],
    );
    expect(after.rows).toEqual([{ state: "approved", rejection_reason: null }]);
    const audit = await ctx.client.query("SELECT actor_identity_id, action FROM audit_log");
    expect(audit.rows).toEqual([{ actor_identity_id: first.identityId, action: "photo.approve" }]);
  });

  test("A take-down needs an approved photo, and one taken down stays down", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const queued = await photoIn(ctx, owner.accountId, "queued");
    const pending = await photoIn(ctx, owner.accountId, "pending");
    const down = await photoIn(ctx, owner.accountId, "approved");
    expect(
      (await decide(app, staff.headers, down, { decision: "take_down", reason: "minor" })).status,
    ).toBe(200);
    // A queued photo is the queue's to decide; one not yet checked and one
    // taken down already are nobody's to take down.
    for (const id of [queued, pending, down]) {
      const res = await decide(app, staff.headers, id, { decision: "take_down", reason: "nudity" });
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("photo_not_approved");
    }
    // Nor does the queue's approval bring the taken-down photo back.
    const again = await decide(app, staff.headers, down, { decision: "approve" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("photo_not_queued");
    const states = await ctx.client.query<{ id: string; state: string; reason: string | null }>(
      "SELECT id, state, rejection_reason AS reason FROM photo WHERE id = ANY($1::uuid[])",
      [[queued, pending, down]],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.id, [r.state, r.reason]]))).toEqual({
      [queued]: ["queued", null],
      [pending]: ["pending", null],
      [down]: ["rejected", "minor"],
    });
    const audit = await ctx.client.query("SELECT action, subject_id FROM audit_log");
    expect(audit.rows).toEqual([{ action: "photo.reject", subject_id: down }]);
  });

  test("A photo sent in a conversation is never taken down", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose, position)
       VALUES ($1, 'k-sent', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'approved', 'message', NULL)
       RETURNING id`,
      [owner.accountId],
    );
    const sent = rows[0]?.id ?? "";
    const res = await decide(app, staff.headers, sent, { decision: "take_down", reason: "nudity" });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    const after = await ctx.client.query(
      "SELECT state, rejection_reason FROM photo WHERE id = $1",
      [sent],
    );
    expect(after.rows).toEqual([{ state: "approved", rejection_reason: null }]);
    expect(await auditRows(ctx)).toBe(0);
  });

  test("Of two moderators taking one photo down at once, the second is refused and its audit row goes with it", async ({
    ctx,
  }) => {
    // The other moderator's take-down lands between this one's read and its
    // update: the update is keyed on the approved state and finds nothing.
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "approved");
    let landed = false;
    const db = {
      async query(text: string, values?: unknown[]) {
        const result = await ctx.client.query(text, values);
        if (!landed && text.includes(", account_id FROM photo WHERE id = $1")) {
          landed = true;
          await ctx.client.query(
            "UPDATE photo SET state = 'rejected', rejection_reason = 'other' WHERE id = $1",
            [id],
          );
        }
        return result;
      },
    } as Queryable;
    await withMatchingConfig(ctx.client, { max_photos: 6 });
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db, media: testMediaDeps().deps });
    const staff = await staffSession(ctx.client);
    const res = await decide(app, staff.headers, id, { decision: "take_down", reason: "nudity" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("photo_not_approved");
    expect(await auditRows(ctx)).toBe(0);
    const after = await ctx.client.query(
      "SELECT p.state, p.rejection_reason, (SELECT count(*) FROM photo_review r WHERE r.photo_id = p.id) AS reviews FROM photo p WHERE p.id = $1",
      [id],
    );
    expect(after.rows[0]).toEqual({ state: "rejected", rejection_reason: "other", reviews: "0" });
  });
});

// The queue's limit (#376, ADR-006 §2, features/media/moderation.feature): the
// night rejects a photo nobody decided within photo_queue_reject_days, counted
// as the queue counts it, and leaves everything else alone.
describe("the queue's limit", () => {
  const DAY_S = 86_400;
  const night = (ctx: TestContext, at = new Date()) =>
    rejectUnreviewedPhotos({ db: ctx.client, now: () => at });
  const stateOf = async (ctx: TestContext, id: string) =>
    (
      await ctx.client.query<{
        state: string;
        rejection_reason: string | null;
        appealable: boolean;
      }>("SELECT state, rejection_reason, appealable FROM photo WHERE id = $1", [id])
    ).rows[0];

  test("A photo nobody decided within photo_queue_reject_days is rejected as not reviewed", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    await withMatchingConfig(ctx.client, { photo_queue_reject_days: 14 });
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    // One the check sent to a person, and one from where no check runs and no review row exists.
    const checked = await photoIn(ctx, owner.accountId, "queued", { labels: [], ago: 15 * DAY_S });
    const unchecked = await photoIn(ctx, owner.accountId, "queued", { ago: 15 * DAY_S });
    const at = new Date();
    expect(await night(ctx, at)).toEqual({ rejected: 2 });
    for (const id of [checked, unchecked]) {
      expect(await stateOf(ctx, id)).toEqual({
        state: "rejected",
        rejection_reason: "not_reviewed",
        appealable: false,
      });
    }
    const reviews = await ctx.client.query(
      "SELECT decision, reason, decided_by, decided_at FROM photo_review WHERE photo_id = ANY($1) ORDER BY photo_id",
      [[checked, unchecked]],
    );
    expect(reviews.rows).toEqual([
      { decision: "rejected", reason: "not_reviewed", decided_by: null, decided_at: at },
      { decision: "rejected", reason: "not_reviewed", decided_by: null, decided_at: at },
    ]);
    // The owner reads why and keeps the photo; asking a person again is not offered.
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: owner.headers })).json(),
    );
    expect(list.photos.map((p) => [p.state, p.rejectionReason, p.appealable])).toEqual([
      ["rejected", "not_reviewed", false],
      ["rejected", "not_reviewed", false],
    ]);
    const appeal = await app.request(`/photos/${checked}/appeal`, {
      method: "POST",
      headers: owner.headers,
    });
    expect(appeal.status).toBe(409);
    expect(await errorCode(appeal)).toBe("photo_not_appealable");
    // The queue is empty, and nobody is named in an audit row for what nobody did.
    const queue = PhotoReviewQueue.parse(
      await (await app.request("/admin/photos/queue", { headers: staff.headers })).json(),
    );
    expect(queue.total).toBe(0);
    expect(Number((await ctx.client.query("SELECT count(*) AS n FROM audit_log")).rows[0]?.n)).toBe(
      0,
    );
    // The next night finds nothing more to do.
    expect(await night(ctx, at)).toEqual({ rejected: 0 });
  });

  test("The limit counts an appealed photo from its appeal, and leaves every other photo alone", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { photo_queue_reject_days: 14 });
    const owner = await signedInAccount(ctx.client);
    const at = new Date();
    // Either side of fourteen days, by a minute.
    const late = await photoIn(ctx, owner.accountId, "queued", { ago: 14 * DAY_S + 60 });
    const inTime = await photoIn(ctx, owner.accountId, "queued", { ago: 14 * DAY_S - 60 });
    // Uploaded long ago, appealed three days ago: it waits from the appeal.
    const appealed = await photoIn(ctx, owner.accountId, "queued", {
      labels: [],
      ago: 40 * DAY_S,
    });
    await ctx.client.query("UPDATE photo_review SET appealed_at = $2 WHERE photo_id = $1", [
      appealed,
      new Date(at.getTime() - 3 * DAY_S * 1000),
    ]);
    // Old photos in every other state are not the queue's.
    const others: string[] = [];
    for (const state of ["pending", "approved", "rejected"] as const) {
      others.push(await photoIn(ctx, owner.accountId, state, { ago: 40 * DAY_S }));
    }
    // A photo sent in a conversation is stored queued with no human queue (ADR-031 §10).
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose, created_at)
       VALUES ($1, 'k-message', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'queued', 'message', $2)
       RETURNING id`,
      [owner.accountId, new Date(at.getTime() - 40 * DAY_S * 1000)],
    );
    const message = rows[0]?.id ?? "";

    expect(await night(ctx, at)).toEqual({ rejected: 1 });
    expect((await stateOf(ctx, late))?.state).toBe("rejected");
    for (const id of [inTime, appealed, message])
      expect((await stateOf(ctx, id))?.state).toBe("queued");
    const after: Array<string | undefined> = [];
    for (const id of others) after.push((await stateOf(ctx, id))?.state);
    expect(after).toEqual(["pending", "approved", "rejected"]);
    // A rejection of any other kind keeps its own reason.
    expect((await stateOf(ctx, others[2] ?? ""))?.rejection_reason).toBeNull();
  });

  test("A moderator's decision and the night's limit on one photo: the first one stands", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    await withMatchingConfig(ctx.client, { photo_queue_reject_days: 14 });
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const decidedFirst = await photoIn(ctx, owner.accountId, "queued", { ago: 20 * DAY_S });
    const lateFirst = await photoIn(ctx, owner.accountId, "queued", { ago: 20 * DAY_S });

    // A moderator approves one just before the night: the night leaves it approved.
    expect((await decide(app, staff.headers, decidedFirst, { decision: "approve" })).status).toBe(
      200,
    );
    expect(await night(ctx)).toEqual({ rejected: 1 });
    expect((await stateOf(ctx, decidedFirst))?.state).toBe("approved");
    const review = await ctx.client.query(
      "SELECT decision, decided_by FROM photo_review WHERE photo_id = $1",
      [decidedFirst],
    );
    expect(review.rows).toEqual([{ decision: "approved", decided_by: staff.identityId }]);

    // The night got to the other first: a moderator's late decision is refused, with no audit row.
    const res = await decide(app, staff.headers, lateFirst, { decision: "approve" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("photo_not_queued");
    expect(await stateOf(ctx, lateFirst)).toMatchObject({
      state: "rejected",
      rejection_reason: "not_reviewed",
    });
    const audit = await ctx.client.query("SELECT action, subject_id FROM audit_log");
    expect(audit.rows).toEqual([{ action: "photo.approve", subject_id: decidedFirst }]);
  });

  test("photo_queue_reject_days at 0 switches the limit off", async ({ ctx }) => {
    const owner = await signedInAccount(ctx.client);
    const id = await photoIn(ctx, owner.accountId, "queued", { ago: 400 * DAY_S });
    await withMatchingConfig(ctx.client, { photo_queue_reject_days: 0 });
    expect(await night(ctx)).toEqual({ rejected: 0 });
    expect((await stateOf(ctx, id))?.state).toBe("queued");
    // Switched on again with a number, the same photo goes the next night.
    await withMatchingConfig(ctx.client, { photo_queue_reject_days: 14 });
    expect(await night(ctx)).toEqual({ rejected: 1 });
  });

  test("the limit fails loudly when its number is not a number", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { photo_queue_reject_days: "two weeks" });
    await expect(night(ctx)).rejects.toThrow(/photo_queue_reject_days is not a number/);
  });
});
