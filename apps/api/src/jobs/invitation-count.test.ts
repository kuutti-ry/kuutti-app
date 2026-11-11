import type { Queryable } from "@kuutti/db";
import { Invitations } from "@kuutti/schema";
import type { App } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { applySanction } from "../safety/index.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { interleaved } from "../test/chat.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { completed, consented, invitationOf } from "../test/invitations.ts";
import { people } from "../test/people.ts";
import { noticesOf } from "../test/push.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { invitationCountJob } from "./invitation-count.ts";
import { runNightly } from "./nightly.ts";

// The night's count of invitations (#107, #503, ADR-044 §7): an invitation
// counts the first night its redeemer's profile is complete, once, with the
// fish invitation_reward says that night for each of its two, and a notice
// for each (ADR-032), the friend's only of a fish, read back on the home
// screen; open invitations and redeemers without a row wait; the log line
// holds counts; a broken reward stops the count; and an erasure of the inviter
// while the night counts waits for it, and takes what it wrote of theirs. The
// friend's erasure against the night is identity/races.test.ts's.

/** 04:00 in Finland, one Friday. */
const T = new Date("2026-10-23T01:00:00.000Z");

type Person = Awaited<ReturnType<typeof signedInAccount>>;

async function count(db: Queryable) {
  const { logger, lines } = await captureLogger();
  const job = invitationCountJob({ db, logger, now: () => T });
  return { result: await job.run(), lines };
}

/** An inviter whose profile is complete, and a friend who typed their code, whose profile is not. */
async function invitedPair(ctx: TestContext): Promise<{ a: Person; friend: Person; id: string }> {
  const a = await signedInAccount(ctx.client);
  await completed(ctx.client, a.accountId);
  const friend = await signedInAccount(ctx.client, undefined, { state: "registered" });
  await consented(ctx.client, friend.accountId);
  const id = await invitationOf(ctx.client, a.accountId, { redeemedBy: friend.accountId });
  return { a, friend, id };
}

/** `invitedPair` with the friend's profile complete since, for the night to count. */
async function countablePair(ctx: TestContext) {
  const pair = await invitedPair(ctx);
  await completed(ctx.client, pair.friend.accountId);
  return pair;
}

const invitationsOf = async (app: App, who: Person) =>
  Invitations.parse(await (await app.request("/invitations", { headers: who.headers })).json());

const unitsOf = async (db: Queryable, accountId: string) =>
  (
    await db.query<{ kind: string; invitation_id: string; earned_at: Date }>(
      "SELECT kind, invitation_id, earned_at FROM reward WHERE account_id = $1",
      [accountId],
    )
  ).rows;

const countedAt = async (db: Queryable, id: string) =>
  (
    await db.query<{ counted_at: Date | null }>("SELECT counted_at FROM invitation WHERE id = $1", [
      id,
    ])
  ).rows[0]?.counted_at;

/** All the night could have written for these two: their units, their notices, and the count. */
const footprint = async (db: Queryable, pair: { a: Person; friend: Person; id: string }) => {
  const accounts = [pair.a.accountId, pair.friend.accountId];
  return {
    units: (await db.query("SELECT 1 FROM reward WHERE account_id = ANY($1::uuid[])", [accounts]))
      .rows.length,
    notices: (await db.query("SELECT 1 FROM notice WHERE account_id = ANY($1::uuid[])", [accounts]))
      .rows.length,
    countedAt: await countedAt(db, pair.id),
  };
};

describe("the night's count of invitations", () => {
  test("an invitation counts the first night its redeemer's profile is complete, whether or not their pond is open, with the night's reward and a notice for each of its two, and once", async ({
    ctx,
  }) => {
    const { a, friend, id } = await invitedPair(ctx);
    // Redeemed, and the friend's profile is not complete: it waits.
    expect((await count(ctx.client)).result).toEqual({ counted: 0, fish: 0 });
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([]);
    expect(await unitsOf(ctx.client, friend.accountId)).toEqual([]);

    await completed(ctx.client, friend.accountId);
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 2 });
    for (const who of [a, friend]) {
      expect(await unitsOf(ctx.client, who.accountId)).toEqual([
        { kind: "fish", invitation_id: id, earned_at: T },
      ]);
    }
    expect(await countedAt(ctx.client, id)).toEqual(T);

    // Each reads it on the home screen: what it earned them, never whom.
    const [notice, ...rest] = await noticesOf(ctx.app, a);
    expect(rest).toEqual([]);
    expect(notice).toEqual({
      id: expect.any(String),
      kind: "invitation_counted",
      at: T.toISOString(),
      readAt: null,
      reward: { fish: 1 },
    });
    expect(JSON.stringify(notice)).not.toContain(friend.accountId);
    const [theirs, ...others] = await noticesOf(ctx.app, friend);
    expect(others).toEqual([]);
    expect(theirs).toEqual({
      id: expect.any(String),
      kind: "invitation_friend",
      at: T.toISOString(),
      readAt: null,
      reward: { fish: 1 },
    });
    expect(JSON.stringify(theirs)).not.toContain(a.accountId);
    expect(
      (await ctx.app.request(`/notices/${notice?.id}/read`, { method: "POST", headers: a.headers }))
        .status,
    ).toBe(204);

    // What is banked is each person's; only the inviter has an invitation that counted.
    expect(await invitationsOf(ctx.app, a)).toMatchObject({ counted: 1, earned: { fish: 1 } });
    expect(await invitationsOf(ctx.app, friend)).toMatchObject({ counted: 0, earned: { fish: 1 } });

    // A second run the same night writes nothing.
    expect((await count(ctx.client)).result).toEqual({ counted: 0, fish: 0 });
    for (const who of [a, friend]) {
      expect(await unitsOf(ctx.client, who.accountId)).toHaveLength(1);
      expect(await noticesOf(ctx.app, who)).toHaveLength(1);
    }
  });

  test.for([
    ["two and three", { inviterFish: 2, friendFish: 3 }, 5, ["invitation_friend"]],
    ["three and two", { inviterFish: 3, friendFish: 2 }, 5, ["invitation_friend"]],
    ["the ceiling on both sides", { inviterFish: 10, friendFish: 10 }, 20, ["invitation_friend"]],
    ["none for the friend", { inviterFish: 2, friendFish: 0 }, 2, []],
    ["none for the inviter", { inviterFish: 0, friendFish: 2 }, 2, ["invitation_friend"]],
    ["none for either", { inviterFish: 0, friendFish: 0 }, 0, []],
  ] as const)(
    "the reward is the config's as it stands that night, each side its own: %s",
    async ([, reward, fish, friendsNotices], { ctx }) => {
      const { a, friend, id } = await countablePair(ctx);
      await withMatchingConfig(ctx.client, { invitation_reward: reward });

      expect((await count(ctx.client)).result).toEqual({ counted: 1, fish });

      expect(await unitsOf(ctx.client, a.accountId)).toHaveLength(reward.inviterFish);
      expect(await unitsOf(ctx.client, friend.accountId)).toHaveLength(reward.friendFish);
      expect(await countedAt(ctx.client, id)).toEqual(T);
      // The inviter's notice says it counted, whatever it earned, nothing included.
      expect(await noticesOf(ctx.app, a)).toEqual([
        expect.objectContaining({
          kind: "invitation_counted",
          reward: { fish: reward.inviterFish },
        }),
      ]);
      // The friend has no invitation of theirs to hear about: a notice only of a fish.
      const theirs = await noticesOf(ctx.app, friend);
      expect(theirs.map((notice) => notice.kind)).toEqual(friendsNotices);
      for (const notice of theirs) {
        expect(notice).toMatchObject({ reward: { fish: reward.friendFish } });
      }

      // Counted is counted, of nothing too: a second run writes nothing.
      expect((await count(ctx.client)).result).toEqual({ counted: 0, fish: 0 });
      expect(await noticesOf(ctx.app, a)).toHaveLength(1);
      expect(await unitsOf(ctx.client, a.accountId)).toHaveLength(reward.inviterFish);
    },
  );

  test("a night of several adds up, each notice reading its own invitation: an inviter of two, one of whom invited a third", async ({
    ctx,
  }) => {
    const { a, friend: b } = await countablePair(ctx);
    const c = await signedInAccount(ctx.client);
    await completed(ctx.client, c.accountId);
    await invitationOf(ctx.client, a.accountId, { redeemedBy: c.accountId });
    const d = await signedInAccount(ctx.client);
    await completed(ctx.client, d.accountId);
    await invitationOf(ctx.client, b.accountId, { redeemedBy: d.accountId });
    await withMatchingConfig(ctx.client, {
      invitation_reward: { inviterFish: 2, friendFish: 3 },
    });

    expect((await count(ctx.client)).result).toEqual({ counted: 3, fish: 15 });

    expect(await unitsOf(ctx.client, a.accountId)).toHaveLength(4);
    expect(await unitsOf(ctx.client, b.accountId)).toHaveLength(5);
    expect(await unitsOf(ctx.client, c.accountId)).toHaveLength(3);
    expect(await unitsOf(ctx.client, d.accountId)).toHaveLength(3);
    const said = async (who: Person) =>
      (await noticesOf(ctx.app, who))
        .map((notice) => `${notice.kind} ${"reward" in notice ? notice.reward.fish : "-"}`)
        .sort();
    expect(await said(a)).toEqual(["invitation_counted 2", "invitation_counted 2"]);
    // Both sides of one person: what the invitation they made earned, and what the one they used did.
    expect(await said(b)).toEqual(["invitation_counted 2", "invitation_friend 3"]);
    expect(await said(c)).toEqual(["invitation_friend 3"]);
    expect(await said(d)).toEqual(["invitation_friend 3"]);
  });

  test("a redeemer whose profile lapsed waits for the night it is complete again (ADR-060 §7)", async ({
    ctx,
  }) => {
    const { a, friend, id } = await countablePair(ctx);
    const consent = (withdrawn: string) =>
      ctx.client.query(
        `UPDATE consent SET withdrawn_at = ${withdrawn} WHERE account_id = $1 AND kind = 'special_category'`,
        [friend.accountId],
      );
    await consent("now()");
    expect((await count(ctx.client)).result).toEqual({ counted: 0, fish: 0 });
    await consent("NULL");
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 2 });
    for (const who of [a, friend]) {
      expect(await unitsOf(ctx.client, who.accountId)).toEqual([
        { kind: "fish", invitation_id: id, earned_at: T },
      ]);
    }
  });

  test("a person whose completeness lapsed holds back the invitation they used and not the one they made, though both of its people are counting another tonight", async ({
    ctx,
  }) => {
    // A invited B, and B, complete then, invited C. A's second friend D is complete,
    // so that A, B, C and D are all locked tonight, and B is not among those complete.
    const { a, friend: b, id: bUsed } = await countablePair(ctx);
    const c = await signedInAccount(ctx.client);
    await completed(ctx.client, c.accountId);
    const bMade = await invitationOf(ctx.client, b.accountId, { redeemedBy: c.accountId });
    const d = await signedInAccount(ctx.client);
    await completed(ctx.client, d.accountId);
    const aMade = await invitationOf(ctx.client, a.accountId, { redeemedBy: d.accountId });
    await ctx.client.query(
      "UPDATE consent SET withdrawn_at = now() WHERE account_id = $1 AND kind = 'special_category'",
      [b.accountId],
    );

    expect((await count(ctx.client)).result).toEqual({ counted: 2, fish: 4 });

    expect(await countedAt(ctx.client, bMade)).toEqual(T);
    expect(await countedAt(ctx.client, aMade)).toEqual(T);
    expect(await countedAt(ctx.client, bUsed)).toBeNull();
    const invitationsOfUnits = async (who: Person) =>
      (await unitsOf(ctx.client, who.accountId)).map((unit) => unit.invitation_id);
    expect(await invitationsOfUnits(a)).toEqual([aMade]);
    expect(await invitationsOfUnits(b)).toEqual([bMade]);
    expect(await invitationsOfUnits(c)).toEqual([bMade]);
    expect(await invitationsOfUnits(d)).toEqual([aMade]);
    expect((await noticesOf(ctx.app, b)).map((notice) => notice.kind)).toEqual([
      "invitation_counted",
    ]);

    // B's profile is complete again, and the one they used counts the next night.
    await ctx.client.query(
      "UPDATE consent SET withdrawn_at = NULL WHERE account_id = $1 AND kind = 'special_category'",
      [b.accountId],
    );
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 2 });
    expect(await countedAt(ctx.client, bUsed)).toEqual(T);
    expect((await noticesOf(ctx.app, b)).map((notice) => notice.kind).sort()).toEqual([
      "invitation_counted",
      "invitation_friend",
    ]);
  });

  test("of two redeemers of one inviter, the one who is complete counts and the other waits", async ({
    ctx,
  }) => {
    const { a, id } = await countablePair(ctx);
    const [other] = await people(ctx.client, null, 1);
    if (!other) throw new Error("friend not written");
    const waits = await invitationOf(ctx.client, a.accountId, { redeemedBy: other });

    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 2 });

    expect(await countedAt(ctx.client, id)).toEqual(T);
    expect(await countedAt(ctx.client, waits)).toBeNull();
    expect(await unitsOf(ctx.client, other)).toEqual([]);
  });

  test("an open invitation and one counted already stay as they are; a shadow-banned redeemer counts and earns, and a banned inviter still earns", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await completed(ctx.client, a.accountId);
    const open = await invitationOf(ctx.client, a.accountId);
    const [done] = await people(ctx.client, null, 1);
    await completed(ctx.client, done as string);
    const before = new Date("2026-10-01T01:00:00.000Z");
    const counted = await invitationOf(ctx.client, a.accountId, {
      redeemedBy: done,
      countedAt: before,
    });
    const hidden = await countablePair(ctx);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      hidden.friend.accountId,
    ]);
    const banned = await countablePair(ctx);
    await ctx.client.query("UPDATE account SET state = 'banned' WHERE id = $1", [
      banned.a.accountId,
    ]);

    expect((await count(ctx.client)).result).toEqual({ counted: 2, fish: 4 });
    expect(await countedAt(ctx.client, open)).toBeNull();
    expect(await countedAt(ctx.client, counted)).toEqual(before);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([]);
    expect(await unitsOf(ctx.client, done as string)).toEqual([]);
    expect(await unitsOf(ctx.client, hidden.a.accountId)).toHaveLength(1);
    expect(await unitsOf(ctx.client, hidden.friend.accountId)).toHaveLength(1);
    expect(await unitsOf(ctx.client, banned.a.accountId)).toHaveLength(1);
    expect(await unitsOf(ctx.client, banned.friend.accountId)).toHaveLength(1);
  });

  test("the night's line carries how many and of what, never who", async ({ ctx }) => {
    const { a, friend } = await countablePair(ctx);
    const { logger, lines } = await captureLogger();
    await runNightly([invitationCountJob({ db: ctx.client, logger, now: () => T })], logger);

    const done = lines().find((l) => l.msg === "nightly job done");
    expect(done).toMatchObject({ job: "invitation-count", counted: 1, fish: 2 });
    // Its fields are the counts and the logger's own, nothing else.
    expect(Object.keys(done ?? {}).sort()).toEqual([
      "counted",
      "fish",
      "hostname",
      "job",
      "level",
      "msg",
      "pid",
      "time",
    ]);
    const logged = JSON.stringify(lines());
    expect(logged).not.toContain(a.accountId);
    expect(logged).not.toContain(friend.accountId);
  });

  test.for([
    ["the old shape of fish and likes", { fish: 1, likes: 0 }],
    ["a key it does not know", { inviterFish: 1, friendFish: 1, boosts: 1 }],
    ["likes beside the fish", { inviterFish: 1, friendFish: 1, likes: 0 }],
    ["the inviter past the ceiling", { inviterFish: 11, friendFish: 1 }],
    ["the friend past the ceiling", { inviterFish: 1, friendFish: 11 }],
    ["a fraction", { inviterFish: 1, friendFish: 0.5 }],
    ["a negative", { inviterFish: -1, friendFish: 1 }],
    ["a side left out", { inviterFish: 1 }],
    ["a number for the whole", 1],
  ] as const)(
    "a reward of another shape fails the night's job and writes nothing, and the night after a mended one counts it: %s",
    async ([, broken], { ctx }) => {
      const pair = await countablePair(ctx);
      const { logger, lines } = await captureLogger();
      await withMatchingConfig(ctx.client, { invitation_reward: broken });
      const job = invitationCountJob({ db: ctx.client, logger, now: () => T });

      await runNightly([job], logger);

      expect(lines().find((l) => l.msg === "nightly job failed")).toMatchObject({
        job: "invitation-count",
      });
      expect(lines().some((l) => l.msg === "nightly job done")).toBe(false);
      expect(await footprint(ctx.client, pair)).toEqual({ units: 0, notices: 0, countedAt: null });
      expect(JSON.stringify(lines())).not.toContain(pair.friend.accountId);

      await withMatchingConfig(ctx.client, {
        invitation_reward: { inviterFish: 1, friendFish: 1 },
      });
      await runNightly([job], logger);
      expect(lines().find((l) => l.msg === "nightly job done")).toMatchObject({
        counted: 1,
        fish: 2,
      });
    },
  );

  test("a failure on the way takes back all the night wrote, and the next night counts it", async ({
    ctx,
  }) => {
    const pair = await countablePair(ctx);
    const { logger } = await captureLogger();
    // The units are written and the first notice is not.
    const failing = interleaved(ctx.client, /INSERT INTO notice/, () =>
      Promise.reject(new Error("the notice could not be written")),
    );

    await expect(invitationCountJob({ db: failing, logger, now: () => T }).run()).rejects.toThrow(
      "the notice could not be written",
    );

    expect(failing.ran()).toBe(true);
    expect(await footprint(ctx.client, pair)).toEqual({ units: 0, notices: 0, countedAt: null });
    expect((await count(ctx.client)).result).toEqual({ counted: 1, fish: 2 });
    expect(await footprint(ctx.client, pair)).toEqual({ units: 2, notices: 2, countedAt: T });
  });

  test("a warning lifted since hides itself alone: the counted invitation's notice stays", async ({
    ctx,
  }) => {
    const { a } = await countablePair(ctx);
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

  test("An erasure of the inviter while the night counts waits for the count, and takes what it wrote of theirs", async () => {
    await withTwoConnections("kuutti-107-count", async (pool, counting, erasing) => {
      const [a, friend] = await people(pool, null, 2);
      if (!a || !friend) throw new Error("cast not written");
      await completed(pool, a);
      await completed(pool, friend);
      await invitationOf(pool, a, { redeemedBy: friend });
      const { logger } = await captureLogger();
      const countingPid = await pidOf(counting);
      const erasingPid = await pidOf(erasing);
      // The count has written the units and the notices, not committed.
      await counting.query("BEGIN");
      await erasing.query("BEGIN");
      expect(await invitationCountJob({ db: counting, logger, now: () => T }).run()).toEqual({
        counted: 1,
        fish: 2,
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
      // The friend's fish and notice stay theirs.
      for (const table of ["reward", "notice"]) {
        const { rows } = await pool.query(`SELECT account_id FROM ${table}`);
        expect(rows, table).toEqual([{ account_id: friend }]);
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
