import type { Queryable } from "@kuutti/db";
import { InvitationCreated, Invitations, normaliseInvitationCode } from "@kuutti/schema";
import type { App } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { isComplete } from "../jobs/pool.ts";
import { signedInAccount } from "../test/account.ts";
import { openExport } from "../test/export.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { completed, consented, earnedUnits, hashOf } from "../test/invitations.ts";
import { countInvitations } from "./invitations.ts";

// Invitations in erasure and the export (#107, ADR-044 §10, ADR-007,
// features/identity/erasure.feature): the inviter's open ones go, and their
// units and notices with the account, while a redeemed one stays for its
// redeemer, the link cut, and never counts; the redeemer's goes until it
// counts and then stays for its inviter without them; a row that would name
// nobody goes; the export carries each side's own and never a code or the
// other person.

type Person = Awaited<ReturnType<typeof signedInAccount>>;

/** 04:00 in Finland, the night of the count. */
const NIGHT = new Date("2026-10-23T01:00:00.000Z");

const erase = async (ctx: TestContext, who: Person) =>
  eraseAccount(
    { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
    who.accountId,
  );

const countTonight = async (db: Queryable) =>
  countInvitations({
    db,
    logger: (await captureLogger()).logger,
    now: () => NIGHT,
    complete: (tx, accountId) => isComplete(tx, accountId, NIGHT),
  });

async function makeOne(app: App, who: Person): Promise<InvitationCreated> {
  const answer = await app.request("/invitations", { method: "POST", headers: who.headers });
  expect(answer.status).toBe(201);
  return InvitationCreated.parse(await answer.json());
}

async function use(app: App, who: Person, code: string) {
  const answer = await app.request("/invitations/redeem", {
    method: "POST",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(answer.status).toBe(204);
}

/** "A", whose profile is complete, with an open invitation, and "B", who used A's second one and whose profile is complete since, counted tonight. */
async function invitedAndCounted(ctx: TestContext) {
  const a = await signedInAccount(ctx.client);
  await completed(ctx.client, a.accountId);
  const open = await makeOne(ctx.app, a);
  const used = await makeOne(ctx.app, a);
  const b = await signedInAccount(ctx.client, undefined, { state: "registered" });
  await consented(ctx.client, b.accountId);
  await use(ctx.app, b, used.code);
  await completed(ctx.client, b.accountId);
  expect(await countTonight(ctx.client)).toEqual({ counted: 1, fish: 1, likes: 0 });
  return { a, b, open, used };
}

const rowsOf = async (db: Queryable, sql: string, accountId: string) =>
  (await db.query(sql, [accountId])).rows;

const invitationsOf = async (app: App, who: Person) => {
  const answer = await app.request("/invitations", { headers: who.headers });
  expect(answer.status).toBe(200);
  return Invitations.parse(await answer.json());
};

const usedOf = async (app: App, who: Person) =>
  (await openExport(await app.request("/account/export", { headers: who.headers }))).document
    .invitations.used;

/** `invitedAndCounted`, and "C", who used a third invitation of A's and has not finished. */
async function invitedCountedAndWaiting(ctx: TestContext) {
  const cast = await invitedAndCounted(ctx);
  const pending = await makeOne(ctx.app, cast.a);
  const c = await signedInAccount(ctx.client, undefined, { state: "registered" });
  await consented(ctx.client, c.accountId);
  await use(ctx.app, c, pending.code);
  return { ...cast, c, pending };
}

describe("invitations in erasure", () => {
  test("An erased inviter's open invitations go, their units and notices with the account, and the redeemed ones stay for their redeemers", async ({
    ctx,
  }) => {
    const { a, b, c, open, used, pending } = await invitedCountedAndWaiting(ctx);
    const before = { b: await usedOf(ctx.app, b), c: await usedOf(ctx.app, c) };
    expect(before.b).toEqual({ redeemedAt: expect.any(String), countedAt: NIGHT.toISOString() });
    expect(before.c).toEqual({ redeemedAt: expect.any(String), countedAt: null });

    expect(await erase(ctx, a)).toMatchObject({
      madeInvitationsDeleted: 1,
      madeInvitationsKept: 2,
      rewardUnits: 1,
      notices: 1,
      usedInvitationsDeleted: 0,
      usedInvitationsKept: 0,
    });
    expect(await rowsOf(ctx.client, "SELECT 1 FROM invitation WHERE id = $1", open.id)).toEqual([]);
    expect(
      await rowsOf(
        ctx.client,
        "SELECT 1 FROM invitation WHERE inviter_account_id = $1",
        a.accountId,
      ),
    ).toEqual([]);
    expect(
      await rowsOf(ctx.client, "SELECT 1 FROM reward WHERE account_id = $1", a.accountId),
    ).toEqual([]);
    expect(
      await rowsOf(ctx.client, "SELECT 1 FROM notice WHERE account_id = $1", a.accountId),
    ).toEqual([]);
    // B's and C's stay theirs, naming no inviter, B's with its count.
    const kept = await ctx.client.query(
      `SELECT id, inviter_account_id, redeemed_by_account_id, counted_at FROM invitation
        WHERE id = ANY($1::uuid[]) ORDER BY counted_at NULLS LAST`,
      [[used.id, pending.id]],
    );
    expect(kept.rows).toEqual([
      {
        id: used.id,
        inviter_account_id: null,
        redeemed_by_account_id: b.accountId,
        counted_at: NIGHT,
      },
      {
        id: pending.id,
        inviter_account_id: null,
        redeemed_by_account_id: c.accountId,
        counted_at: null,
      },
    ]);
    // Nothing of B's or C's changes: neither may type another code, and each export says what it said.
    for (const who of [b, c]) {
      expect(await invitationsOf(ctx.app, who)).toMatchObject({ redeemable: false });
    }
    const another = await makeOne(ctx.app, b);
    const refused = await ctx.app.request("/invitations/redeem", {
      method: "POST",
      headers: { ...c.headers, "content-type": "application/json" },
      body: JSON.stringify({ code: another.code }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "invitation_not_for_you" } });
    expect(await usedOf(ctx.app, b)).toEqual(before.b);
    expect(await usedOf(ctx.app, c)).toEqual(before.c);
    expect(
      await rowsOf(ctx.client, "SELECT state FROM account WHERE id = $1", b.accountId),
    ).toEqual([{ state: "active" }]);
  });

  test("An invitation whose inviter was erased never counts", async ({ ctx }) => {
    const { a, c, pending } = await invitedCountedAndWaiting(ctx);
    await erase(ctx, a);
    // Another inviter's invitation counts the same night, so the night's
    // update runs with inviters to count and still leaves the orphan.
    const d = await signedInAccount(ctx.client);
    await completed(ctx.client, d.accountId);
    const theirs = await makeOne(ctx.app, d);
    const e = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await consented(ctx.client, e.accountId);
    await use(ctx.app, e, theirs.code);
    await completed(ctx.client, e.accountId);
    await completed(ctx.client, c.accountId);

    expect(await countTonight(ctx.client)).toEqual({ counted: 1, fish: 1, likes: 0 });
    expect(
      await rowsOf(ctx.client, "SELECT counted_at FROM invitation WHERE id = $1", pending.id),
    ).toEqual([{ counted_at: null }]);
    expect(
      await rowsOf(ctx.client, "SELECT 1 FROM reward WHERE invitation_id = $1", pending.id),
    ).toEqual([]);
    expect(
      await rowsOf(ctx.client, "SELECT 1 FROM notice WHERE invitation_id = $1", pending.id),
    ).toEqual([]);
    expect(
      await rowsOf(ctx.client, "SELECT 1 FROM reward WHERE invitation_id = $1", theirs.id),
    ).toHaveLength(1);
    // A second night finds nothing more.
    expect(await countTonight(ctx.client)).toEqual({ counted: 0, fish: 0, likes: 0 });
  });

  test("An erased redeemer's invitation goes until it counts, and once counted stays for its inviter without them", async ({
    ctx,
  }) => {
    const { a, b: c, used } = await invitedAndCounted(ctx);
    const pending = await makeOne(ctx.app, a);
    const b = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await consented(ctx.client, b.accountId);
    await use(ctx.app, b, pending.code);

    expect(await erase(ctx, b)).toMatchObject({
      madeInvitationsDeleted: 0,
      madeInvitationsKept: 0,
      rewardUnits: 0,
      usedInvitationsDeleted: 1,
      usedInvitationsKept: 0,
    });
    expect(await rowsOf(ctx.client, "SELECT 1 FROM invitation WHERE id = $1", pending.id)).toEqual(
      [],
    );

    expect(await erase(ctx, c)).toMatchObject({
      usedInvitationsDeleted: 0,
      usedInvitationsKept: 1,
    });
    const kept = await rowsOf(
      ctx.client,
      "SELECT redeemed_by_account_id, redeemed_at IS NOT NULL AS redeemed, counted_at FROM invitation WHERE id = $1",
      used.id,
    );
    expect(kept).toEqual([{ redeemed_by_account_id: null, redeemed: true, counted_at: NIGHT }]);
    // A keeps the count and what it earned.
    expect(await invitationsOf(ctx.app, a)).toMatchObject({
      counted: 1,
      earned: { fish: 1, likes: 0 },
    });
  });

  test("an invitation goes once its inviter and its redeemer are both erased, in either order", async ({
    ctx,
  }) => {
    // The redeemer first: the counted one stays for A without B, then goes with A.
    const first = await invitedAndCounted(ctx);
    expect(await erase(ctx, first.b)).toMatchObject({ usedInvitationsKept: 1 });
    expect(await erase(ctx, first.a)).toMatchObject({
      madeInvitationsDeleted: 2,
      madeInvitationsKept: 0,
      rewardUnits: 1,
      notices: 1,
    });
    expect(
      await rowsOf(ctx.client, "SELECT 1 FROM invitation WHERE id = $1", first.used.id),
    ).toEqual([]);

    // The inviter first: B's and C's stay for them without A, then each goes with its redeemer.
    const second = await invitedCountedAndWaiting(ctx);
    expect(await erase(ctx, second.a)).toMatchObject({ madeInvitationsKept: 2 });
    for (const [who, id] of [
      [second.b, second.used.id],
      [second.c, second.pending.id],
    ] as const) {
      expect(await erase(ctx, who)).toMatchObject({
        usedInvitationsDeleted: 1,
        usedInvitationsKept: 0,
        madeInvitationsDeleted: 0,
      });
      expect(await rowsOf(ctx.client, "SELECT 1 FROM invitation WHERE id = $1", id)).toEqual([]);
    }
  });
});

describe("invitations in the export", () => {
  test("The export lists the invitations made, the one used and the units, never a code or the other person", async ({
    ctx,
  }) => {
    const { a, b, open, used } = await invitedAndCounted(ctx);
    const spentAt = new Date("2026-10-23T09:00:00.000Z");
    await ctx.client.query("UPDATE reward SET spent_at = $2 WHERE account_id = $1", [
      a.accountId,
      spentAt,
    ]);

    const ofA = await openExport(await ctx.app.request("/account/export", { headers: a.headers }));
    // Both were made within the same moment or two: the order is the export's, newest first.
    const { made, ...rest } = ofA.document.invitations;
    expect(made).toHaveLength(2);
    expect(made).toEqual(
      expect.arrayContaining([
        { createdAt: used.createdAt, state: "counted", countedAt: NIGHT.toISOString() },
        { createdAt: open.createdAt, state: "open", countedAt: null },
      ]),
    );
    expect(made.map((m) => m.createdAt)).toEqual(
      made
        .map((m) => m.createdAt)
        .sort()
        .reverse(),
    );
    expect(rest).toEqual({
      used: null,
      rewards: [{ kind: "fish", earnedAt: NIGHT.toISOString(), spentAt: spentAt.toISOString() }],
    });
    const ofB = await openExport(await ctx.app.request("/account/export", { headers: b.headers }));
    expect(ofB.document.invitations).toEqual({
      made: [],
      used: { redeemedAt: expect.any(String), countedAt: NIGHT.toISOString() },
      rewards: [],
    });

    for (const [raw, other] of [
      [ofA.raw, b.accountId],
      [ofB.raw, a.accountId],
    ] as const) {
      expect(raw).not.toContain(other);
      for (const made of [open, used]) {
        const code = normaliseInvitationCode(made.code);
        expect(raw).not.toContain(made.code);
        expect(raw).not.toContain(code);
        expect(raw).not.toContain(hashOf(code));
      }
    }
  });

  test("an invitation used and not counted reads redeemed, its redeemer's has no count yet, and a unit waiting has no spent time", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await completed(ctx.client, a.accountId);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 }, NIGHT);
    const made = await makeOne(ctx.app, a);
    const b = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await consented(ctx.client, b.accountId);
    await use(ctx.app, b, made.code);

    const ofA = await openExport(await ctx.app.request("/account/export", { headers: a.headers }));
    expect(ofA.document.invitations.made).toContainEqual({
      createdAt: made.createdAt,
      state: "redeemed",
      countedAt: null,
    });
    expect(ofA.document.invitations.rewards).toEqual([
      { kind: "like", earnedAt: NIGHT.toISOString(), spentAt: null },
    ]);
    const ofB = await openExport(await ctx.app.request("/account/export", { headers: b.headers }));
    expect(ofB.document.invitations.used).toEqual({
      redeemedAt: expect.any(String),
      countedAt: null,
    });
  });
});
