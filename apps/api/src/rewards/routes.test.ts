import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  ErrorResponse,
  INVITATION_CODE_GROUPED_PATTERN,
  INVITATIONS_OPEN_CAP,
  InvitationCreated,
  Invitations,
  normaliseInvitationCode,
} from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { interleaved } from "../test/chat.ts";
import {
  captureLogger,
  describe,
  expect,
  type LogLine,
  test,
  testConfig,
} from "../test/harness.ts";
import { consented, earnedUnits, gated, hashOf, invitationOf } from "../test/invitations.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { drawCode, hashInvitationCode, makeInvitation, redeemInvitation } from "./invitations.ts";

// The invitation routes (#107, ADR-044): the caller's own, a new one past the
// gate's test and up to the open ones' cap, its withdrawal, and a code typed
// with the caller checked first, one answer for every code that does not
// work and the day's tries; each route's validation, nobody, the wrong
// person, an account erased on the way, and the races on one code and on the
// cap. The night's count is jobs/invitation-count.test.ts, the spend in a
// decision matching/earned.test.ts, erasure and the export erasure.test.ts.

type Person = Awaited<ReturnType<typeof signedInAccount>>;

/** 12:00 in Finland, one Thursday. */
const T = new Date("2026-10-22T09:00:00.000Z");

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;

async function appOn(db: Queryable, now: () => Date = () => T) {
  const { logger, lines } = await captureLogger();
  return { app: createApp({ config: testConfig(), logger, db, now }), lines };
}

const listOf = async (app: App, who: Person) => {
  const answer = await app.request("/invitations", { headers: who.headers });
  expect(answer.status).toBe(200);
  return Invitations.parse(await answer.json());
};
const make = (app: App, who: { headers: Record<string, string> }) =>
  app.request("/invitations", { method: "POST", headers: who.headers });
const madeBy = async (app: App, who: Person) => {
  const answer = await make(app, who);
  expect(answer.status).toBe(201);
  return InvitationCreated.parse(await answer.json());
};
const withdraw = (app: App, who: { headers: Record<string, string> }, id: string) =>
  app.request(`/invitations/${id}`, { method: "DELETE", headers: who.headers });
const redeem = (app: App, who: { headers: Record<string, string> }, body: unknown) =>
  app.request("/invitations/redeem", {
    method: "POST",
    headers: json(who.headers),
    body: JSON.stringify(body),
  });

/** A person who signed in with their bank and gave the consents after the welcome, profile not done. */
async function newcomer(db: Queryable): Promise<Person> {
  const who = await signedInAccount(db, undefined, { state: "registered" });
  await consented(db, who.accountId);
  return who;
}

/** A person whose profile has passed the gate's test. */
async function inviter(db: Queryable): Promise<Person> {
  const who = await signedInAccount(db);
  await gated(db, who.accountId);
  return who;
}

const rowOf = async (db: Queryable, id: string) =>
  (
    await db.query<{
      code_hash: string;
      redeemed_by_account_id: string | null;
      redeemed_at: Date | null;
    }>("SELECT code_hash, redeemed_by_account_id, redeemed_at FROM invitation WHERE id = $1", [id])
  ).rows[0];

const NOTHING = { fish: 0, likes: 0 };

describe("the caller's invitations", () => {
  test("say whether the person may invite or still type a code, what an invitation earns, and nothing of anybody invited", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const n = await newcomer(ctx.client);
    const bare = await signedInAccount(ctx.client, undefined, { state: "registered" });
    expect(await listOf(app, a)).toEqual({
      canInvite: true,
      redeemable: false,
      reward: { fish: 1, likes: 0 },
      open: [],
      counted: 0,
      earned: NOTHING,
    });
    expect(await listOf(app, n)).toMatchObject({ canInvite: false, redeemable: true, open: [] });
    // Without the consents of the welcome, no code yet.
    expect(await listOf(app, bare)).toMatchObject({ canInvite: false, redeemable: false });
    // What earns what is the config's, read as it stands.
    await withMatchingConfig(ctx.client, { invitation_reward: { fish: 0, likes: 3 } });
    expect((await listOf(app, a)).reward).toEqual({ fish: 0, likes: 3 });
  });

  test("count the invitations that counted and what they earned, used units aside", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    await earnedUnits(ctx.client, a.accountId, { fish: 1, likes: 2 });
    await ctx.client.query(
      `UPDATE reward SET spent_at = now() WHERE id = (
         SELECT id FROM reward WHERE account_id = $1 AND kind = 'like' LIMIT 1)`,
      [a.accountId],
    );
    // A redeemed one that has not counted is not said anywhere: it left the open list, that is all.
    const [friend] = await people(ctx.client, null, 1);
    await invitationOf(ctx.client, a.accountId, { redeemedBy: friend });
    expect(await listOf(app, a)).toMatchObject({
      open: [],
      counted: 2,
      earned: { fish: 2, likes: 1 },
    });
  });

  test("a reward in the config of another shape fails loudly, naming the key", async ({ ctx }) => {
    const { app, lines } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    for (const broken of [
      { fish: 1 },
      { fish: 1, likes: 0, boosts: 2 },
      { fish: 1.5, likes: 0 },
      1,
    ]) {
      await withMatchingConfig(ctx.client, { invitation_reward: broken });
      const answer = await app.request("/invitations", { headers: a.headers });
      expect(answer.status, JSON.stringify(broken)).toBe(500);
      expect(await errorCode(answer)).toBe("internal_error");
    }
    expect(lines().some((l) => (l.detail as { key?: string })?.key === "invitation_reward")).toBe(
      true,
    );
  });
});

describe("making and withdrawing an invitation", () => {
  test("a person whose profile passed the gate's test makes one: the code shown once, kept as its hash alone", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const made = await madeBy(app, a);
    expect(made.code).toMatch(INVITATION_CODE_GROUPED_PATTERN);
    expect(made.createdAt).toBe(T.toISOString());
    const row = await rowOf(ctx.client, made.id);
    expect(row).toEqual({
      code_hash: hashOf(normaliseInvitationCode(made.code)),
      redeemed_by_account_id: null,
      redeemed_at: null,
    });
    // No column of the row holds the code, in either form.
    const stored = JSON.stringify(
      (await ctx.client.query("SELECT * FROM invitation WHERE id = $1", [made.id])).rows,
    );
    expect(stored).not.toContain(made.code);
    expect(stored).not.toContain(normaliseInvitationCode(made.code));
    // The list says when, never the code.
    const listed = await listOf(app, a);
    expect(listed.open).toEqual([{ id: made.id, createdAt: made.createdAt }]);
    expect(JSON.stringify(listed)).not.toContain(made.code);
  });

  test("draws ten characters of Crockford's alphabet, and the hash is of the normalised code", () => {
    const codes = new Set(Array.from({ length: 200 }, drawCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(hashInvitationCode("0123456789")).toBe(hashOf("0123456789"));
  });

  test("a shadow-banned person invites as anybody does, and nobody before the gate's test", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const hidden = await inviter(ctx.client);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      hidden.accountId,
    ]);
    expect((await make(app, hidden)).status).toBe(201);
    const n = await newcomer(ctx.client);
    const refused = await make(app, n);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("invitation_not_yet");
    const rows = await ctx.client.query("SELECT 1 FROM invitation WHERE inviter_account_id = $1", [
      n.accountId,
    ]);
    expect(rows.rows).toEqual([]);
  });

  test("at most invitations_open are open at once: one more is invitations_full, and one redeemed or withdrawn makes room", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    await withMatchingConfig(ctx.client, { invitations_open: 2 });
    const a = await inviter(ctx.client);
    const first = await madeBy(app, a);
    const second = await madeBy(app, a);
    const full = await make(app, a);
    expect(full.status).toBe(409);
    expect(await errorCode(full)).toBe("invitations_full");
    // The friend types the first: it is no longer open.
    const n = await newcomer(ctx.client);
    expect((await redeem(app, n, { code: first.code })).status).toBe(204);
    const third = await madeBy(app, a);
    expect((await make(app, a)).status).toBe(409);
    expect((await withdraw(app, a, second.id)).status).toBe(204);
    const fourth = await madeBy(app, a);
    expect((await listOf(app, a)).open.map((o) => o.id).sort()).toEqual(
      [third.id, fourth.id].sort(),
    );
  });

  test("never more open than the contract's ceiling, whatever the config says", async ({ ctx }) => {
    const { app } = await appOn(ctx.client);
    await withMatchingConfig(ctx.client, { invitations_open: INVITATIONS_OPEN_CAP + 5 });
    const a = await inviter(ctx.client);
    for (let i = 0; i < INVITATIONS_OPEN_CAP; i += 1) await madeBy(app, a);
    const over = await make(app, a);
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe("invitations_full");
    expect((await listOf(app, a)).open).toHaveLength(INVITATIONS_OPEN_CAP);
  });

  test("withdraws an open invitation of the caller's own, whose code then works no more; another's, a redeemed one and nobody's are 404", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const b = await inviter(ctx.client);
    const mine = await madeBy(app, a);
    const used = await madeBy(app, a);
    // B's list is B's own.
    expect((await listOf(app, b)).open).toEqual([]);
    const n = await newcomer(ctx.client);
    expect((await redeem(app, n, { code: used.code })).status).toBe(204);
    for (const [who, id] of [
      [b, mine.id],
      [a, used.id],
      [a, randomUUID()],
    ] as const) {
      const answer = await withdraw(app, who, id);
      expect(answer.status).toBe(404);
      expect(await errorCode(answer)).toBe("not_found");
    }
    expect(await rowOf(ctx.client, mine.id)).toBeDefined();
    expect((await withdraw(app, a, mine.id)).status).toBe(204);
    expect(await rowOf(ctx.client, mine.id)).toBeUndefined();
    expect((await withdraw(app, a, mine.id)).status).toBe(404);
    const late = await newcomer(ctx.client);
    const answer = await redeem(app, late, { code: mine.code });
    expect(answer.status).toBe(404);
    expect(await errorCode(answer)).toBe("invitation_unknown");
    // An id that is no uuid.
    const malformed = await withdraw(app, a, "not-a-uuid");
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("validation_failed");
  });
});

describe("typing a code", () => {
  test("a code is redeemed once, in any case, with a space for the hyphen, O read as zero and I or L as one", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const id = await invitationOf(ctx.client, a.accountId, {
      codeHash: hashInvitationCode("0123456789"),
    });
    const n = await newcomer(ctx.client);
    expect((await redeem(app, n, { code: " oi234 5678 9 " })).status).toBe(204);
    expect(await rowOf(ctx.client, id)).toMatchObject({
      redeemed_by_account_id: n.accountId,
      redeemed_at: T,
    });
    // Neither may use a code now: the friend has used one, and the inviter's
    // list no longer has it, with nothing said about who used it.
    expect(await listOf(app, n)).toMatchObject({ redeemable: false, canInvite: false });
    expect(await listOf(app, a)).toMatchObject({ open: [], counted: 0, earned: NOTHING });
    const again = await redeem(app, n, { code: "01234-56789" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("invitation_not_for_you");
  });

  test("one answer for a code unknown, used or the caller's own", async ({ ctx }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const used = await invitationOf(ctx.client, a.accountId, {
      codeHash: hashInvitationCode("SEEDSSEEDS"),
    });
    const first = await newcomer(ctx.client);
    expect((await redeem(app, first, { code: "SEEDS-SEEDS" })).status).toBe(204);
    // The caller's own: somebody whose profile has not passed the test any
    // more, holding an invitation of their own (the gate's row went with a pond).
    const own = await newcomer(ctx.client);
    await invitationOf(ctx.client, own.accountId, { codeHash: hashInvitationCode("MYMYMMYMYM") });
    const answers: Array<{ code: string; message: string }> = [];
    for (const code of ["ZZZZZ-ZZZZZ", "SEEDS-SEEDS", "MYMYM-MYMYM"]) {
      const answer = await redeem(app, own, { code });
      expect(answer.status, code).toBe(404);
      const { error } = ErrorResponse.parse(await answer.json());
      answers.push({ code: error.code, message: error.message });
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]?.code).toBe("invitation_unknown");
    // Nothing was written by any of them.
    expect(await rowOf(ctx.client, used)).toMatchObject({
      redeemed_by_account_id: first.accountId,
    });
    const ownRows = await ctx.client.query(
      "SELECT 1 FROM invitation WHERE redeemed_by_account_id = $1",
      [own.accountId],
    );
    expect(ownRows.rows).toEqual([]);
  });

  test("the caller is asked before the code: a profile past the test, a code used, no consents or an identity erased before is invitation_not_for_you, and the code stays open", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const id = await invitationOf(ctx.client, a.accountId, {
      codeHash: hashInvitationCode("PEN00PEN00"),
    });
    const past = await inviter(ctx.client);
    await consented(ctx.client, past.accountId);
    const usedOne = await newcomer(ctx.client);
    await invitationOf(ctx.client, a.accountId, { redeemedBy: usedOne.accountId });
    const unconsented = await signedInAccount(ctx.client, undefined, { state: "registered" });
    // The terms alone, before the privacy step.
    const termsOnly = await newcomer(ctx.client);
    await ctx.client.query("DELETE FROM consent WHERE account_id = $1 AND kind = 'privacy'", [
      termsOnly.accountId,
    ]);
    const returning = await newcomer(ctx.client);
    await ctx.client.query(
      `UPDATE identity SET deletion_count = 1
        WHERE id = (SELECT identity_id FROM account WHERE id = $1)`,
      [returning.accountId],
    );
    for (const who of [past, usedOne, unconsented, termsOnly, returning]) {
      for (const code of ["PEN00-PEN00", "ZZZZZ-ZZZZZ"]) {
        const answer = await redeem(app, who, { code });
        expect(answer.status).toBe(409);
        expect(await errorCode(answer)).toBe("invitation_not_for_you");
      }
      expect((await listOf(app, who)).redeemable).toBe(false);
    }
    expect(await rowOf(ctx.client, id)).toMatchObject({ redeemed_by_account_id: null });
  });

  test("refuses no code, too long, not a code, and an unknown key, before anything is read", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    await withMatchingConfig(ctx.client, { invitation_tries_per_day: 100 });
    const n = await newcomer(ctx.client);
    for (const body of [
      {},
      { code: 1234567890 },
      { code: "" },
      { code: `${"0".repeat(10)}${" ".repeat(23)}` },
      { code: "0123456789A" },
      { code: "01234-5678U" },
      { code: "01234-56789", invitedBy: "a friend" },
    ]) {
      const answer = await redeem(app, n, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(answer)).toBe("validation_failed");
    }
  });

  test("a person tries invitation_tries_per_day codes a Finnish day, whatever the answer; the next is refused until midnight, and another person's tries are their own", async ({
    ctx,
  }) => {
    let at = T;
    const { app, lines } = await appOn(ctx.client, () => at);
    await withMatchingConfig(ctx.client, { invitation_tries_per_day: 2 });
    const n = await newcomer(ctx.client);
    const m = await newcomer(ctx.client);
    expect((await redeem(app, n, { code: "nope" })).status).toBe(400);
    expect((await redeem(app, n, { code: "ZZZZZ-ZZZZZ" })).status).toBe(404);
    const refused = await redeem(app, n, { code: "YYYYY-YYYYY" });
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("invitation_tries_exceeded");
    // Midnight in Helsinki, 21:00 UTC the day before summer time ends.
    const midnight = new Date("2026-10-22T21:00:00.000Z");
    expect(Number(refused.headers.get("retry-after"))).toBe(
      (midnight.getTime() - T.getTime()) / 1000,
    );
    // The refusal is logged by its limit, never its key or the code.
    const line = lines().find((l: LogLine) => l.msg === "invitation code refused");
    expect(line).toMatchObject({ limiter: "invitation_tries_per_day", accountId: n.accountId });
    expect(JSON.stringify(lines())).not.toContain("YYYYY");
    expect(JSON.stringify(lines())).not.toContain(`account:${n.accountId}`);
    // Another person's day is their own.
    expect((await redeem(app, m, { code: "ZZZZZ-ZZZZZ" })).status).toBe(404);
    // Another method on the path is no try, and is not refused by them.
    expect((await withdraw(app, n, "redeem")).status).toBe(400);
    // After midnight the day starts over.
    at = new Date(midnight.getTime() + 1000);
    expect((await redeem(app, n, { code: "ZZZZZ-ZZZZZ" })).status).toBe(404);
  });

  test("no code, typed or made, nor its hash reaches a log line", async ({ ctx }) => {
    const { app, lines } = await appOn(ctx.client);
    const a = await inviter(ctx.client);
    const made = await madeBy(app, a);
    const n = await newcomer(ctx.client);
    expect((await redeem(app, n, { code: "UUUUU-UUUUU" })).status).toBe(400);
    expect((await redeem(app, n, { code: "ZZZZZ-ZZZZZ" })).status).toBe(404);
    expect((await redeem(app, n, { code: made.code })).status).toBe(204);
    expect((await redeem(app, n, { code: made.code })).status).toBe(409);
    const logged = JSON.stringify(lines());
    expect(lines().length).toBeGreaterThan(0);
    for (const code of [made.code, normaliseInvitationCode(made.code), "ZZZZZ", "UUUUU"]) {
      expect(logged).not.toContain(code);
    }
    expect(logged).not.toContain(hashOf(normaliseInvitationCode(made.code)));
  });
});

describe("nobody, and an account erased on the way", () => {
  test("every route refuses a request without a session or with an unknown token", async ({
    ctx,
  }) => {
    const { app } = await appOn(ctx.client);
    for (const headers of [{}, { authorization: "Bearer nobody" }] as Record<string, string>[]) {
      expect((await app.request("/invitations", { headers })).status).toBe(401);
      expect((await make(app, { headers })).status).toBe(401);
      expect((await withdraw(app, { headers }, randomUUID())).status).toBe(401);
      expect((await redeem(app, { headers }, { code: "ZZZZZ-ZZZZZ" })).status).toBe(401);
    }
  });

  test("an account erased between the guard and the work reads and writes nothing", async ({
    ctx,
  }) => {
    const a = await inviter(ctx.client);
    const n = await newcomer(ctx.client);
    const code = "0PEN1-0PEN1";
    await invitationOf(ctx.client, a.accountId, {
      codeHash: hashInvitationCode(normaliseInvitationCode(code)),
    });
    const erase = (who: Person) => () =>
      ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [who.accountId]);
    const cases: Array<[Person, RegExp, (app: App) => Response | Promise<Response>]> = [
      [a, /SELECT i\.deletion_count/, (app) => app.request("/invitations", { headers: a.headers })],
      [a, /FOR UPDATE OF a/, (app) => make(app, a)],
      [n, /FOR UPDATE OF a/, (app) => redeem(app, n, { code })],
    ];
    for (const [who, before, call] of cases) {
      const racing = interleaved(ctx.client, before, erase(who));
      const { app } = await appOn(racing);
      const answer = await call(app);
      expect(racing.ran()).toBe(true);
      expect(answer.status).toBe(404);
      expect(await errorCode(answer)).toBe("not_found");
      await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [who.accountId]);
    }
    const written = await ctx.client.query(
      "SELECT 1 FROM invitation WHERE inviter_account_id = $1 AND redeemed_at IS NOT NULL",
      [a.accountId],
    );
    expect(written.rows).toEqual([]);
    expect(
      (
        await ctx.client.query("SELECT 1 FROM invitation WHERE inviter_account_id = $1", [
          a.accountId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
});

describe("races on committed rows", () => {
  /** A pond, an inviter past the gate and two people who gave the consents, committed. */
  async function cast(db: Queryable) {
    const [a, n, m] = await people(db, null, 3);
    if (!a || !n || !m) throw new Error("cast not written");
    await gated(db, a);
    await consented(db, n);
    await consented(db, m);
    return { a, n, m };
  }

  test("Two people typing one code at once: the second waits for the first and is told the code does not work", async () => {
    await withTwoConnections("kuutti-107-redeem", async (pool, first, second) => {
      const { a, n, m } = await cast(pool);
      const id = await invitationOf(pool, a, { codeHash: hashInvitationCode("RACE0RACE0") });
      const { logger } = await captureLogger();
      const deps = (db: Queryable) => ({ db, logger, now: () => T });
      const secondPid = await pidOf(second);
      const firstPid = await pidOf(first);
      await first.query("BEGIN");
      await second.query("BEGIN");
      await redeemInvitation(deps(first), { accountId: n, code: "RACE0-RACE0" });
      const racing = watched(redeemInvitation(deps(second), { accountId: m, code: "race0 race0" }));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toBe("invitation_unknown");
      await second.query("COMMIT");
      const { rows } = await pool.query<{ redeemed_by_account_id: string }>(
        "SELECT redeemed_by_account_id FROM invitation WHERE id = $1",
        [id],
      );
      expect(rows).toEqual([{ redeemed_by_account_id: n }]);
    });
  });

  test("Two invitations made at once past the cap: the second waits for the first and is refused", async () => {
    await withTwoConnections("kuutti-107-cap", async (pool, first, second) => {
      const { a } = await cast(pool);
      await pool.query(
        `INSERT INTO matching_config (version, key, value, created_by)
         VALUES (2, 'invitations_open', '1'::jsonb, 'test')`,
      );
      const { logger } = await captureLogger();
      const deps = (db: Queryable) => ({ db, logger, now: () => T });
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      await makeInvitation(deps(first), a);
      const racing = watched(makeInvitation(deps(second), a));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toBe("invitations_full");
      await second.query("COMMIT");
      const { rows } = await pool.query("SELECT 1 FROM invitation WHERE inviter_account_id = $1", [
        a,
      ]);
      expect(rows).toHaveLength(1);
    });
  });
});
