import type { Queryable } from "@kuutti/db";
import { Invitations, Notices } from "@kuutti/schema";
import type { App } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { applySanction } from "../safety/index.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { consented, gated, invitationOf } from "../test/invitations.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { invitationCountJob } from "./invitation-count.ts";
import { runNightly } from "./nightly.ts";

// The night's count of invitations (#107, ADR-044 §7): an invitation counts
// the first night its redeemer has a gate row, once, with the units
// invitation_reward says that night and one notice for its inviter (ADR-032),
// read back on the home screen; open invitations and redeemers without a row
// wait; the log line holds counts; a broken reward stops the count; and an
// erasure of the inviter while the night counts waits for it, and takes what
// it wrote but the friend's invitation.

/** 04:00 in Finland, one Friday. */
const T = new Date("2026-10-23T01:00:00.000Z");

type Person = Awaited<ReturnType<typeof signedInAccount>>;

async function count(db: Queryable) {
  const { logger, lines } = await captureLogger();
  const job = invitationCountJob({ db, logger, now: () => T });
  return { result: await job.run(), lines };
}

/** An inviter past the gate, and a friend who typed their code, not past it yet. */
async function invitedPair(ctx: TestContext): Promise<{ a: Person; friend: string; id: string }> {
  const a = await signedInAccount(ctx.client);
  await gated(ctx.client, a.accountId);
  const [friend] = await people(ctx.client, null, 1);
  if (!friend) throw new Error("friend not written");
  await consented(ctx.client, friend);
  const id = await invitationOf(ctx.client, a.accountId, { redeemedBy: friend });
  return { a, friend, id };
}

const noticesOf = async (app: App, who: Person) => {
  const answer = await app.request("/notices", { headers: who.headers });
  expect(answer.status).toBe(200);
  return Notices.parse(await answer.json()).notices;
};

const unitsOf = async (db: Queryable, accountId: string) =>
  (
    await db.query<{ kind: string; invitation_id: string; earned_at: Date }>(
      "SELECT kind, invitation_id, earned_at FROM reward WHERE account_id = $1 ORDER BY kind",
      [accountId],
    )
  ).rows;

describe("the night's count of invitations", () => {
  test("an invitation counts the first night its redeemer has a gate row, with the night's reward and one notice, and once", async ({
    ctx,
  }) => {
    const { a, friend, id } = await invitedPair(ctx);
    // Redeemed, and the friend's profile has not passed the test: it waits.
    expect((await count(ctx.client)).result).toEqual({ counted: 0, fish: 0, likes: 0 });
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([]);

    await gated(ctx.client, friend);
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 1, likes: 0 });
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", invitation_id: id, earned_at: T },
    ]);
    const { rows } = await ctx.client.query<{ counted_at: Date }>(
      "SELECT counted_at FROM invitation WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([{ counted_at: T }]);
    // The inviter reads it on the home screen: what it earned, never whom.
    const [notice, ...rest] = await noticesOf(ctx.app, a);
    expect(rest).toEqual([]);
    expect(notice).toEqual({
      id: expect.any(String),
      kind: "invitation_counted",
      at: T.toISOString(),
      readAt: null,
      reward: { fish: 1, likes: 0 },
    });
    expect(JSON.stringify(notice)).not.toContain(friend);
    expect(
      (await ctx.app.request(`/notices/${notice?.id}/read`, { method: "POST", headers: a.headers }))
        .status,
    ).toBe(204);
    const listed = Invitations.parse(
      await (await ctx.app.request("/invitations", { headers: a.headers })).json(),
    );
    expect(listed).toMatchObject({ counted: 1, earned: { fish: 1, likes: 0 } });

    // A second run the same night writes nothing.
    expect((await count(ctx.client)).result).toEqual({ counted: 0, fish: 0, likes: 0 });
    expect(await unitsOf(ctx.client, a.accountId)).toHaveLength(1);
    expect(await noticesOf(ctx.app, a)).toHaveLength(1);
  });

  test("the reward is the config's as it stands that night: likes, both, or nothing at all", async ({
    ctx,
  }) => {
    const first = await invitedPair(ctx);
    await gated(ctx.client, first.friend);
    await withMatchingConfig(ctx.client, { invitation_reward: { fish: 2, likes: 3 } });
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 2, likes: 3 });
    expect((await unitsOf(ctx.client, first.a.accountId)).map((u) => u.kind)).toEqual([
      "like",
      "like",
      "like",
      "fish",
      "fish",
    ]);
    expect((await noticesOf(ctx.app, first.a))[0]).toMatchObject({ reward: { fish: 2, likes: 3 } });

    const second = await invitedPair(ctx);
    await gated(ctx.client, second.friend);
    await withMatchingConfig(ctx.client, { invitation_reward: { fish: 0, likes: 0 } });
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 0, likes: 0 });
    expect(await unitsOf(ctx.client, second.a.accountId)).toEqual([]);
    // The notice still says it counted, and that it earned nothing.
    expect((await noticesOf(ctx.app, second.a))[0]).toMatchObject({
      kind: "invitation_counted",
      reward: { fish: 0, likes: 0 },
    });
  });

  test("an open invitation and one counted already stay as they are; a shadow-banned redeemer counts, and a banned inviter still earns", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await gated(ctx.client, a.accountId);
    const open = await invitationOf(ctx.client, a.accountId);
    const [done] = await people(ctx.client, null, 1);
    await gated(ctx.client, done as string);
    const before = new Date("2026-10-01T01:00:00.000Z");
    await invitationOf(ctx.client, a.accountId, { redeemedBy: done, countedAt: before });
    const hidden = await invitedPair(ctx);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      hidden.friend,
    ]);
    await gated(ctx.client, hidden.friend);
    const banned = await invitedPair(ctx);
    await gated(ctx.client, banned.friend);
    await ctx.client.query("UPDATE account SET state = 'banned' WHERE id = $1", [
      banned.a.accountId,
    ]);

    expect((await count(ctx.client)).result).toEqual({ counted: 2, fish: 2, likes: 0 });
    const states = await ctx.client.query<{ id: string; counted_at: Date | null }>(
      "SELECT id, counted_at FROM invitation WHERE inviter_account_id = $1 ORDER BY created_at",
      [a.accountId],
    );
    expect(states.rows.find((r) => r.id === open)?.counted_at).toBeNull();
    expect(states.rows.find((r) => r.id !== open)?.counted_at).toEqual(before);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([]);
    expect(await unitsOf(ctx.client, hidden.a.accountId)).toHaveLength(1);
    expect(await unitsOf(ctx.client, banned.a.accountId)).toHaveLength(1);
  });

  test("the night's line carries how many and of what, never who; a reward of another shape stops the count and writes nothing", async ({
    ctx,
  }) => {
    const { a, friend } = await invitedPair(ctx);
    await gated(ctx.client, friend);
    const { logger, lines } = await captureLogger();
    await withMatchingConfig(ctx.client, { invitation_reward: { fish: 1, likes: 0, boosts: 1 } });
    const job = invitationCountJob({ db: ctx.client, logger, now: () => T });
    await runNightly([job], logger);
    expect(lines().find((l) => l.msg === "nightly job failed")).toMatchObject({
      job: "invitation-count",
    });
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([]);

    await withMatchingConfig(ctx.client, { invitation_reward: { fish: 1, likes: 0 } });
    await runNightly([job], logger);
    const done = lines().find((l) => l.msg === "nightly job done");
    expect(done).toMatchObject({ job: "invitation-count", counted: 1, fish: 1, likes: 0 });
    const logged = JSON.stringify(lines());
    expect(logged).not.toContain(a.accountId);
    expect(logged).not.toContain(friend);
  });

  test("a warning lifted since hides itself alone: the counted invitation's notice stays", async ({
    ctx,
  }) => {
    const { a, friend } = await invitedPair(ctx);
    await gated(ctx.client, friend);
    await count(ctx.client);
    const warning = await applySanction(ctx.client, {
      accountId: a.accountId,
      kind: "warn",
      reason: "harassment",
      note: "Kept writing after a no.",
      actor: null,
      // The morning after the count.
      at: new Date(T.getTime() + 4 * 60 * 60 * 1000),
    });
    expect((await noticesOf(ctx.app, a)).map((n) => n.kind)).toEqual([
      "warning",
      "invitation_counted",
    ]);
    await ctx.client.query("UPDATE sanction SET lifted_at = now() WHERE id = $1", [warning.id]);
    expect((await noticesOf(ctx.app, a)).map((n) => n.kind)).toEqual(["invitation_counted"]);
  });

  test("An erasure of the inviter while the night counts waits for the count, and takes what it wrote", async () => {
    await withTwoConnections("kuutti-107-count", async (pool, counting, erasing) => {
      const [a, friend] = await people(pool, null, 2);
      if (!a || !friend) throw new Error("cast not written");
      await gated(pool, a);
      await gated(pool, friend);
      await invitationOf(pool, a, { redeemedBy: friend });
      const { logger } = await captureLogger();
      const countingPid = await pidOf(counting);
      const erasingPid = await pidOf(erasing);
      // The count has written the units and the notice, not committed.
      await counting.query("BEGIN");
      await erasing.query("BEGIN");
      expect(await invitationCountJob({ db: counting, logger, now: () => T }).run()).toEqual({
        counted: 1,
        fish: 1,
        likes: 0,
      });
      const erasure = watched(eraseAccount({ db: erasing, logger, now: () => T }, a));
      expect(await waitsFor(pool, erasingPid, countingPid, erasure.settled)).toBe(true);
      await counting.query("COMMIT");
      expect(await erasure.outcome).toMatchObject({
        madeInvitationsDeleted: 0,
        madeInvitationsKept: 1,
        rewardUnits: 1,
        notices: 1,
      });
      await erasing.query("COMMIT");
      for (const table of ["reward", "notice"]) {
        const { rows } = await pool.query(`SELECT 1 FROM ${table}`);
        expect(rows, table).toEqual([]);
      }
      // The friend's invitation stays theirs, counted, naming no inviter (ADR-044 §10).
      const { rows } = await pool.query(
        "SELECT inviter_account_id, redeemed_by_account_id, counted_at FROM invitation",
      );
      expect(rows).toEqual([
        { inviter_account_id: null, redeemed_by_account_id: friend, counted_at: T },
      ]);
    });
  });
});
