import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, migrate, withTemporaryDatabase } from "@kuutti/db";
import { ErrorResponse, Notices, NotificationChoices } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { invitationCountJob } from "../jobs/invitation-count.ts";
import { applySanction } from "../safety/index.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { interleaved } from "../test/chat.ts";
import { exportOf } from "../test/export.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { completed, invitationOf } from "../test/invitations.ts";
import { pidOf, waitsFor, watched } from "../test/races.ts";
import { setChoice } from "./notifications.ts";

// The notification choices and the notices in the app (#176, ADR-032): every
// route with its happy path, each validation rule, unauthenticated, the wrong
// user and each error branch; a warning's notice (features/safety/
// sanctions.feature), a counted invitation's for each of its two (#107, #503),
// and the choices and notices in the export and the erasure
// (features/identity/erasure.feature).

type Person = Awaited<ReturnType<typeof signedInAccount>>;
type App = ReturnType<typeof createApp>;

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const choicesOf = async (app: App, who: Person) => {
  const answer = await app.request("/account/notifications", { headers: who.headers });
  expect(answer.status).toBe(200);
  return NotificationChoices.parse(await answer.json()).choices;
};
const choose = (app: App, who: { headers: Record<string, string> }, kind: string, body: unknown) =>
  app.request(`/account/notifications/${kind}`, {
    method: "PUT",
    headers: json(who.headers),
    body: JSON.stringify(body),
  });
const noticesOf = async (app: App, who: Person) => {
  const answer = await app.request("/notices", { headers: who.headers });
  expect(answer.status).toBe(200);
  return Notices.parse(await answer.json()).notices;
};
const read = (app: App, who: { headers: Record<string, string> }, id: string) =>
  app.request(`/notices/${id}/read`, { method: "POST", headers: who.headers });
const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;
const warn = (ctx: TestContext, who: Person, kind: "warn" | "shadow_ban" = "warn") =>
  applySanction(ctx.client, {
    accountId: who.accountId,
    kind,
    reason: "harassment",
    note: "Kept writing after a no.",
    actor: null,
    at: new Date(),
  });
const ALL_ON = [
  { kind: "message", enabled: true },
  { kind: "match", enabled: true },
  { kind: "moderation", enabled: true },
  // Kuutti's announcements to everybody (#573, ADR-068 §6).
  { kind: "announcement", enabled: true },
];

describe("the notification choices", () => {
  test("every kind is on until switched off, and each person's are their own", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    expect(await choicesOf(ctx.app, a)).toEqual(ALL_ON);
    const off = await choose(ctx.app, a, "message", { enabled: false });
    expect(off.status).toBe(200);
    const expected = ALL_ON.map((c) => (c.kind === "message" ? { ...c, enabled: false } : c));
    expect(NotificationChoices.parse(await off.json()).choices).toEqual(expected);
    expect(await choicesOf(ctx.app, a)).toEqual(expected);
    // The same again changes nothing; on again is on.
    expect((await choose(ctx.app, a, "message", { enabled: false })).status).toBe(200);
    expect((await choose(ctx.app, a, "message", { enabled: true })).status).toBe(200);
    expect(await choicesOf(ctx.app, a)).toEqual(ALL_ON);
    expect((await choose(ctx.app, a, "moderation", { enabled: false })).status).toBe(200);
    // B's are B's.
    expect(await choicesOf(ctx.app, b)).toEqual(ALL_ON);
  });

  test("refuses an unknown kind, a value that is no boolean, an unknown key, and nobody", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    for (const [kind, body] of [
      ["push", { enabled: false }],
      // A kind that went with its push (ADR-062 §12).
      ["round", { enabled: false }],
      ["message", { enabled: "no" }],
      ["message", {}],
      ["message", { enabled: false, kind: "match" }],
    ] as const) {
      const answer = await choose(ctx.app, a, kind, body);
      expect(answer.status, JSON.stringify([kind, body])).toBe(400);
    }
    for (const headers of [{}, { authorization: "Bearer nobody" }] as Record<string, string>[]) {
      expect((await ctx.app.request("/account/notifications", { headers })).status).toBe(401);
      expect((await choose(ctx.app, { headers }, "message", { enabled: false })).status).toBe(401);
    }
    expect(await choicesOf(ctx.app, a)).toEqual(ALL_ON);
  });

  test("an account erased between the guard and the write writes nothing", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const racing = interleaved(ctx.client, /INSERT INTO notification_preference/, () =>
      ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]),
    );
    const app = createApp({
      config: testConfig(),
      logger: (await captureLogger()).logger,
      db: racing,
    });
    const answer = await choose(app, a, "match", { enabled: false });
    expect(answer.status).toBe(404);
    expect(await errorCode(answer)).toBe("not_found");
    const rows = await ctx.client.query(
      "SELECT 1 FROM notification_preference WHERE account_id = $1",
      [a.accountId],
    );
    expect(rows.rows).toEqual([]);
  });
});

describe("a choice against the account's erasure", () => {
  it("a choice saved while the account is being erased waits for it, and writes nothing", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({
        connectionString: url,
        max: 4,
        applicationName: "kuutti-176-race",
      });
      const erasing = await pool.connect();
      const choosing = await pool.connect();
      try {
        await migrate(pool, resolve(import.meta.dirname, "../../../../packages/db/drizzle"));
        const { rows } = await pool.query<{ id: string }>(
          `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ('kuutti 176 race') RETURNING id)
           INSERT INTO account (identity_id, state, birth_year, birth_month)
           SELECT id, 'active', 1990, 6 FROM i RETURNING id`,
        );
        const accountId = rows[0]?.id as string;
        const { logger } = await captureLogger();
        // Asked before the work: a client runs one query at a time.
        const erasurePid = await pidOf(erasing);
        const choicePid = await pidOf(choosing);
        // The erasure has done its work and holds the account, not yet committed.
        await erasing.query("BEGIN");
        await eraseAccount({ db: erasing, logger, now: () => new Date() }, accountId);
        const choice = watched(
          setChoice(
            { db: choosing, now: () => new Date() },
            { accountId, kind: "message", enabled: false },
          ),
        );
        const waited = await waitsFor(pool, choicePid, erasurePid, choice.settled);
        await erasing.query("COMMIT");
        expect(waited).toBe(true);
        expect(await choice.outcome).toBe("not_found");
        const left = await pool.query(
          "SELECT 1 FROM notification_preference WHERE account_id = $1",
          [accountId],
        );
        expect(left.rows).toEqual([]);
      } finally {
        erasing.release();
        choosing.release();
        await pool.end();
      }
    });
  }, 30_000);
});

describe("the notices", () => {
  test("A warning shows the person a notice in the app until it is read, and none once lifted", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    expect(await noticesOf(ctx.app, a)).toEqual([]);
    const warning = await warn(ctx, a);
    // A shadow ban tells nobody anything (ADR-024 §7).
    await warn(ctx, a, "shadow_ban");
    const [notice, ...rest] = await noticesOf(ctx.app, a);
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ kind: "warning", reason: "harassment", readAt: null });
    // Not B's to read or to mark.
    expect(await noticesOf(ctx.app, b)).toEqual([]);
    const theirs = await read(ctx.app, b, notice?.id as string);
    expect(theirs.status).toBe(404);
    expect(await errorCode(theirs)).toBe("not_found");
    // Read, and read again: the first time stands.
    expect((await read(ctx.app, a, notice?.id as string)).status).toBe(204);
    const once = (await noticesOf(ctx.app, a))[0]?.readAt;
    expect(once).not.toBeNull();
    expect((await read(ctx.app, a, notice?.id as string)).status).toBe(204);
    expect((await noticesOf(ctx.app, a))[0]?.readAt).toBe(once);
    // A second warning, lifted since, is no notice any more.
    const second = await warn(ctx, a);
    expect(await noticesOf(ctx.app, a)).toHaveLength(2);
    await ctx.client.query("UPDATE sanction SET lifted_at = now() WHERE id = $1", [second.id]);
    expect((await noticesOf(ctx.app, a)).map((n) => n.id)).toEqual([notice?.id]);
    expect(warning.kind).toBe("warn");
  });

  test("refuses a notice that is nobody's, an id that is no uuid, and nobody", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    expect((await read(ctx.app, a, randomUUID())).status).toBe(404);
    expect((await read(ctx.app, a, "not-a-uuid")).status).toBe(400);
    for (const headers of [{}, { authorization: "Bearer nobody" }] as Record<string, string>[]) {
      expect((await ctx.app.request("/notices", { headers })).status).toBe(401);
      expect((await read(ctx.app, { headers }, randomUUID())).status).toBe(401);
    }
  });
});

describe("the notices of a counted invitation", () => {
  /** 04:00 in Finland, the night of the count. */
  const NIGHT = new Date("2026-10-23T01:00:00.000Z");

  /** "A" and the friend "B" who used A's code, counted tonight, each side's reward its own. */
  async function countedPair(ctx: TestContext) {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await completed(ctx.client, a.accountId);
    await completed(ctx.client, b.accountId);
    await invitationOf(ctx.client, a.accountId, { redeemedBy: b.accountId });
    await withMatchingConfig(ctx.client, {
      invitation_reward: { inviterFish: 2, friendFish: 3 },
    });
    const { logger } = await captureLogger();
    await invitationCountJob({ db: ctx.client, logger, now: () => NIGHT }).run();
    return { a, b };
  }

  test("each of the two reads what it earned them alone, though the invitation holds both people's fish", async ({
    ctx,
  }) => {
    const { a, b } = await countedPair(ctx);
    expect(await noticesOf(ctx.app, a)).toEqual([
      {
        id: expect.any(String),
        kind: "invitation_counted",
        at: NIGHT.toISOString(),
        readAt: null,
        reward: { fish: 2 },
      },
    ]);
    expect(await noticesOf(ctx.app, b)).toEqual([
      {
        id: expect.any(String),
        kind: "invitation_friend",
        at: NIGHT.toISOString(),
        readAt: null,
        reward: { fish: 3 },
      },
    ]);
  });

  test("a notice says what the invitation earned, whether or not the fish has been used since", async ({
    ctx,
  }) => {
    const { b } = await countedPair(ctx);
    await ctx.client.query("UPDATE reward SET spent_at = now() WHERE account_id = $1", [
      b.accountId,
    ]);
    expect((await noticesOf(ctx.app, b))[0]).toMatchObject({ reward: { fish: 3 } });
  });

  test("each kind answers with its own: a warning its reason, the friend's its reward", async ({
    ctx,
  }) => {
    const { b } = await countedPair(ctx);
    await warn(ctx, b);
    const answer = await ctx.app.request("/notices", { headers: b.headers });
    expect(answer.status).toBe(200);
    // As the phone gets it, before any parsing could drop what should not be there.
    const { notices } = (await answer.json()) as { notices: Array<Record<string, unknown>> };
    const fields = (kind: string) =>
      Object.keys(notices.find((notice) => notice.kind === kind) ?? {}).sort();
    expect(fields("warning")).toEqual(["at", "id", "kind", "readAt", "reason"]);
    expect(fields("invitation_friend")).toEqual(["at", "id", "kind", "readAt", "reward"]);
  });

  test("the friend's notice is the friend's alone to read: the inviter, the invitation's other person, is told there is no such notice", async ({
    ctx,
  }) => {
    const { a, b } = await countedPair(ctx);
    const [notice] = await noticesOf(ctx.app, b);
    const id = notice?.id as string;

    const theirs = await read(ctx.app, a, id);
    expect(theirs.status).toBe(404);
    expect(await errorCode(theirs)).toBe("not_found");
    expect((await noticesOf(ctx.app, b))[0]?.readAt).toBeNull();

    expect((await read(ctx.app, b, id)).status).toBe(204);
    expect((await noticesOf(ctx.app, b))[0]?.readAt).toEqual(expect.any(String));
    // The inviter's own stays unread.
    expect((await noticesOf(ctx.app, a))[0]?.readAt).toBeNull();
  });

  test("the export lists the friend's notice by its kind and dates, nothing of who invited them", async ({
    ctx,
  }) => {
    const { a, b } = await countedPair(ctx);
    const [notice] = await noticesOf(ctx.app, b);
    expect((await read(ctx.app, b, notice?.id as string)).status).toBe(204);

    const exported = await exportOf(ctx.app, b.headers);

    expect(exported.notifications.notices).toEqual([
      { kind: "invitation_friend", at: NIGHT.toISOString(), readAt: expect.any(String) },
    ]);
    expect(JSON.stringify(exported.notifications)).not.toContain(a.accountId);
  });
});

describe("the choices and the notices in the export and the erasure", () => {
  test("The notification choices and the notices are exported and erased", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    expect((await choose(ctx.app, a, "message", { enabled: false })).status).toBe(200);
    await warn(ctx, a);
    const [notice] = await noticesOf(ctx.app, a);
    expect((await read(ctx.app, a, notice?.id as string)).status).toBe(204);
    const exported = await exportOf(ctx.app, a.headers);
    expect(exported.notifications).toEqual({
      choices: ALL_ON.map((c) => (c.kind === "message" ? { ...c, enabled: false } : c)),
      notices: [{ kind: "warning", at: notice?.at, readAt: expect.any(String) }],
    });
    const summary = await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      a.accountId,
    );
    expect(summary).toMatchObject({ notificationChoices: 1, notices: 1 });
    for (const table of ["notification_preference", "notice"]) {
      const left = await ctx.client.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [
        a.accountId,
      ]);
      expect(left.rows, table).toEqual([]);
    }
  });
});
