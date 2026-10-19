import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  AdminOverview,
  AutomaticBanQueue,
  ConversationList,
  ErrorResponse,
  MessagePage,
} from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import {
  type SignedIn,
  signedInAccount,
  staffSession,
  withMatchingConfig,
} from "../test/account.ts";
import { conversationBetween } from "../test/chat.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type TestContext,
  testConfig,
} from "../test/harness.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { accountOf, reportIn, signedInPeople } from "../test/reports.ts";
import { checkFirstMessage, checkReports } from "./automatic.ts";
import { applySanction, listSanctionsOfAccount } from "./sanctions.ts";

// The automatic shadow bans (#105, features/safety/automatic-shadow-bans.feature):
// each rule at its threshold and one below, what counts and what does not,
// the person already out of sight and staff, two checks at once, what the
// person can still read, the audit row with no actor, a threshold changed in
// the panel and one of zero, and the moderators' confirm and reverse with
// the list, its deadline and its guard. The triggers go through the routes;
// what came before is written straight into the test's transaction.

/** 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(T.getTime() - ms);
const OPENER = "Hei! Katso profiilini ja kirjoita minulle";

type Headers = Record<string, string>;

/** A clock a second later at each reading, as a request and the check after it read it. */
function ticking(): () => Date {
  let t = T.getTime();
  return () => {
    t += 1000;
    return new Date(t);
  };
}

async function appOn(db: Queryable, now: () => Date = ticking()): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now });
}

const test = base.extend<{ app: App }>({
  app: async ({ ctx }, use) => {
    await use(await appOn(ctx.client));
  },
});

const json = (headers: Headers, body: unknown) => ({
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** A report from the conversation between the two, filed through its route; the conversation is the proof of contact. */
async function reportFrom(ctx: TestContext, app: App, reporter: SignedIn, reported: string) {
  const id = await conversationBetween(ctx.client, reporter.accountId, reported, {
    openedAt: ago(DAY),
  });
  const answer = await app.request(
    `/conversations/${id}/report`,
    json(reporter.headers, { reason: "harassment" }),
  );
  expect(answer.status).toBe(204);
}

/** `n` people's reports of the account, filed at the times given, as filing leaves them. */
async function reportsOf(ctx: TestContext, reported: string, times: Date[]) {
  const reporters = await signedInPeople(ctx.client, times.length);
  for (const [i, reporter] of reporters.entries()) {
    await reportIn(
      ctx.client,
      reporter.accountId,
      reported,
      (times[i] as Date).toISOString(),
      undefined,
      "conversation",
    );
  }
  return reporters;
}

/** Conversations the person opened, each with one other person and an opener of `body` at the time given. */
async function openersBy(
  ctx: TestContext,
  sender: SignedIn,
  openers: { body: string; at: Date }[],
) {
  const others = await signedInPeople(ctx.client, openers.length);
  for (const [i, other] of others.entries()) {
    const { body, at } = openers[i] as { body: string; at: Date };
    await conversationBetween(ctx.client, sender.accountId, other.accountId, {
      openedAt: new Date(at.getTime() - MINUTE),
      messages: [{ from: "a", body, at }],
    });
  }
  return others;
}

/** A conversation the sender opens through the send route now, with `body`. */
async function opensWith(ctx: TestContext, app: App, sender: SignedIn, body: string) {
  const [other] = await signedInPeople(ctx.client, 1);
  if (!other) throw new Error("person not written");
  const id = await conversationBetween(ctx.client, sender.accountId, other.accountId, {
    openedAt: ago(MINUTE),
  });
  const sent = await send(app, sender, id, body);
  expect(sent.status).toBe(201);
  return { other, id };
}

const send = (app: App, who: SignedIn, conversationId: string, body: string) =>
  app.request(
    `/conversations/${conversationId}/messages`,
    json(who.headers, { clientId: randomUUID(), body }),
  );

type SanctionRow = {
  kind: string;
  reason: string;
  created_by: string | null;
  rule: string | null;
  rule_count: number | null;
  lifted_at: Date | null;
};

async function sanctionsOf(db: Queryable, accountId: string): Promise<SanctionRow[]> {
  return (
    await db.query<SanctionRow>(
      `SELECT kind, reason, created_by, rule, rule_count, lifted_at FROM sanction
        WHERE account_id = $1 ORDER BY created_at, id`,
      [accountId],
    )
  ).rows;
}

const byRule = (rule: string, count: number) => ({
  kind: "shadow_ban",
  reason: "other",
  created_by: null,
  rule,
  rule_count: count,
  lifted_at: null,
});

async function stateOf(db: Queryable, accountId: string): Promise<string> {
  const { rows } = await db.query<{ state: string }>("SELECT state FROM account WHERE id = $1", [
    accountId,
  ]);
  return rows[0]?.state as string;
}

async function identityOf(db: Queryable, accountId: string): Promise<string> {
  const { rows } = await db.query<{ identity_id: string }>(
    "SELECT identity_id FROM account WHERE id = $1",
    [accountId],
  );
  return rows[0]?.identity_id as string;
}

async function auditOf(db: Queryable, action: string) {
  return (
    await db.query(
      `SELECT actor_identity_id, subject_type, subject_id, detail FROM audit_log
        WHERE action = $1 ORDER BY at, id`,
      [action],
    )
  ).rows;
}

/** A rule's shadow ban on the account, as a rule writes it, `hours` ago. */
async function ruledBan(db: Queryable, accountId: string, hoursAgo = 1): Promise<string> {
  const at = ago(hoursAgo * HOUR);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sanction (identity_id, account_id, kind, reason, note, created_at,
                           rule, rule_count, rule_first_at)
     SELECT identity_id, id, 'shadow_ban', 'other', 'Applied by the automatic rule.', $2,
            'first_messages', 20, $3
       FROM account WHERE id = $1 RETURNING id`,
    [accountId, at, new Date(at.getTime() - HOUR)],
  );
  return rows[0]?.id as string;
}

/** B reported by C, D and E within the week, the third through the route: the rule's ban. */
async function bannedByReports(ctx: TestContext, app: App) {
  const b = await signedInAccount(ctx.client);
  const reporters = await reportsOf(ctx, b.accountId, [ago(2 * DAY), ago(DAY)]);
  const [third] = await signedInPeople(ctx.client, 1);
  if (!third) throw new Error("person not written");
  await reportFrom(ctx, app, third, b.accountId);
  const { rows } = await ctx.client.query<{ id: string }>(
    "SELECT id FROM sanction WHERE account_id = $1 AND rule = 'reports'",
    [b.accountId],
  );
  const reports = await ctx.client.query<{ id: string }>(
    "SELECT id FROM report WHERE reported_account_id = $1 ORDER BY created_at",
    [b.accountId],
  );
  return {
    b,
    reporters: [...reporters, third],
    banId: rows[0]?.id as string,
    reportIds: reports.rows.map((r) => r.id),
  };
}

/** A banned by the first-messages rule at their twentieth opener, sent through the route. */
async function bannedByOpeners(ctx: TestContext, app: App) {
  const a = await signedInAccount(ctx.client);
  await openersBy(
    ctx,
    a,
    Array.from({ length: 19 }, (_, i) => ({ body: `Hei numero ${i}`, at: ago((50 - i) * MINUTE) })),
  );
  const twentieth = await opensWith(ctx, app, a, "Hei numero kaksikymmentä");
  const { rows } = await ctx.client.query<{ id: string }>(
    "SELECT id FROM sanction WHERE account_id = $1 AND rule = 'first_messages'",
    [a.accountId],
  );
  return { a, ...twentieth, banId: rows[0]?.id as string };
}

describe("the reports rule", () => {
  describe("Reports by different people within seven days shadow-ban the reported person at the threshold", () => {
    test.for([
      [1, "not sanctioned"],
      [2, "shadow-banned by nobody for the reason other, by the rule reports counting 3"],
    ] as const)("%i earlier: %s", async ([earlier], { ctx, app }) => {
      const b = await signedInAccount(ctx.client);
      await reportsOf(
        ctx,
        b.accountId,
        Array.from({ length: earlier }, (_, i) => ago((6 - i) * DAY)),
      );
      const [last] = await signedInPeople(ctx.client, 1);
      if (!last) throw new Error("person not written");
      await reportFrom(ctx, app, last, b.accountId);
      expect(await sanctionsOf(ctx.client, b.accountId)).toEqual(
        earlier === 2 ? [byRule("reports", 3)] : [],
      );
      expect(await stateOf(ctx.client, b.accountId)).toBe(
        earlier === 2 ? "shadow_banned" : "active",
      );
    });
  });

  test("One person's reports count once, through any account of theirs", async ({ ctx, app }) => {
    const b = await signedInAccount(ctx.client);
    const [c, d] = await signedInPeople(ctx.client, 2);
    if (!c || !d) throw new Error("people not written");
    await reportIn(ctx.client, c.accountId, b.accountId, ago(3 * DAY).toISOString());
    // C's later account, the earlier one erased since.
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [c.accountId]);
    const later = await accountOf(ctx.client, await identityOf(ctx.client, c.accountId));
    await reportIn(ctx.client, later, b.accountId, ago(DAY).toISOString());
    await reportFrom(ctx, app, d, b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
  });

  test("A report a moderator dismissed does not count", async ({ ctx, app }) => {
    const moderator = await staffSession(ctx.client);
    const b = await signedInAccount(ctx.client);
    const [c, d, e] = await signedInPeople(ctx.client, 3);
    if (!c || !d || !e) throw new Error("people not written");
    await reportIn(ctx.client, c.accountId, b.accountId, ago(3 * DAY).toISOString());
    await reportIn(ctx.client, d.accountId, b.accountId, ago(2 * DAY).toISOString(), {
      outcome: "dismissed",
      at: ago(DAY).toISOString(),
      by: moderator.identityId,
    });
    await reportFrom(ctx, app, e, b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
  });

  test("A report as old as the window does not count", async ({ ctx }) => {
    // A clock that stands still: the window starts exactly seven days before the check.
    const app = await appOn(ctx.client, () => T);
    const b = await signedInAccount(ctx.client);
    await reportsOf(ctx, b.accountId, [ago(7 * DAY), ago(DAY)]);
    const [e] = await signedInPeople(ctx.client, 1);
    if (!e) throw new Error("person not written");
    await reportFrom(ctx, app, e, b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
  });

  test("a report a millisecond inside the window counts", async ({ ctx }) => {
    const app = await appOn(ctx.client, () => T);
    const b = await signedInAccount(ctx.client);
    await reportsOf(ctx, b.accountId, [ago(7 * DAY - 1), ago(DAY)]);
    const [e] = await signedInPeople(ctx.client, 1);
    if (!e) throw new Error("person not written");
    await reportFrom(ctx, app, e, b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([byRule("reports", 3)]);
  });

  test("Being blocked by any number of people counts for nothing", async ({ ctx, app }) => {
    const b = await signedInAccount(ctx.client);
    const blockers = await signedInPeople(ctx.client, 3);
    for (const blocker of blockers) {
      await ctx.client.query(
        `INSERT INTO block (blocker_identity_id, blocked_identity_id)
         SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
        [blocker.accountId, b.accountId],
      );
    }
    await reportsOf(ctx, b.accountId, [ago(DAY)]);
    const [g] = await signedInPeople(ctx.client, 1);
    if (!g) throw new Error("person not written");
    await reportFrom(ctx, app, g, b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
  });

  describe("A rule writes nothing on a person already out of sight, or on staff", () => {
    test.for([
      ["shadow-banned by a moderator"],
      ["shadow-banned by the first-messages rule"],
      ["suspended"],
      ["banned"],
      ["a moderator"],
    ] as const)("%s", async ([standing], { ctx }) => {
      const { logger, lines } = await captureLogger();
      const app = createApp({ config: testConfig(), logger, db: ctx.client, now: ticking() });
      const moderator = await staffSession(ctx.client);
      const b = await signedInAccount(ctx.client);
      const identity = await identityOf(ctx.client, b.accountId);
      const sanctionAs = (kind: string, endsAt: Date | null) =>
        ctx.client.query(
          `INSERT INTO sanction (identity_id, account_id, kind, reason, note, ends_at, created_by, created_at)
           VALUES ($1, $2, $3, 'harassment', 'Seen in the queue.', $4, $5, $6)`,
          [identity, b.accountId, kind, endsAt, moderator.identityId, ago(DAY)],
        );
      if (standing === "shadow-banned by a moderator") await sanctionAs("shadow_ban", null);
      if (standing === "shadow-banned by the first-messages rule") {
        await ruledBan(ctx.client, b.accountId);
      }
      if (standing === "suspended") await sanctionAs("suspend", new Date(T.getTime() + 3 * DAY));
      if (standing === "banned") await sanctionAs("ban", null);
      if (standing === "a moderator") {
        await ctx.client.query(
          "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
          [identity],
        );
      }
      await reportsOf(ctx, b.accountId, [ago(2 * DAY), ago(DAY)]);
      const before = (await sanctionsOf(ctx.client, b.accountId)).length;
      const [third] = await signedInPeople(ctx.client, 1);
      if (!third) throw new Error("person not written");
      await reportFrom(ctx, app, third, b.accountId);
      expect((await sanctionsOf(ctx.client, b.accountId)).length).toBe(before);
      // Staff are measured and refused in words; nobody else reaches the measure. No check failed.
      const warned = lines().filter((line) => line.msg?.startsWith("automatic rule met by"));
      expect(warned.map((line) => line.rule)).toEqual(
        standing === "a moderator" ? ["reports"] : [],
      );
      expect(lines().some((line) => line.msg === "automatic rule check failed")).toBe(false);
    });
  });

  test("An automatic shadow ban is an audit row with no actor, naming its rule", async ({
    ctx,
    app,
  }) => {
    const { b } = await bannedByReports(ctx, app);
    const rows = await auditOf(ctx.client, "sanction.apply");
    expect(rows).toEqual([
      {
        actor_identity_id: null,
        subject_type: "account",
        subject_id: b.accountId,
        detail: expect.objectContaining({
          kind: "shadow_ban",
          reason: "other",
          rule: "reports",
          count: 3,
        }),
      },
    ]);
    expect(Object.keys(rows[0]?.detail ?? {}).sort()).toEqual([
      "count",
      "kind",
      "reason",
      "rule",
      "sanctionId",
    ]);
  });

  test("the database refuses a row with no actor for anything but a rule's shadow ban", async ({
    ctx,
  }) => {
    await expect(
      ctx.client.query(
        `INSERT INTO audit_log (actor_identity_id, action, subject_type, subject_id)
         VALUES (NULL, 'account.view', 'account', $1)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("A threshold changed in the panel holds from the next report, after its config.change row", async ({
    ctx,
    app,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const b = await signedInAccount(ctx.client);
    await reportsOf(ctx, b.accountId, [ago(DAY)]);
    const changed = await app.request(
      "/admin/config/auto_shadow_ban_reports",
      json(admin.headers, { value: 2, reason: "Two are enough while the queue is short" }),
    );
    expect(changed.status).toBe(200);
    const [d] = await signedInPeople(ctx.client, 1);
    if (!d) throw new Error("person not written");
    await reportFrom(ctx, app, d, b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([byRule("reports", 2)]);
    expect(await auditOf(ctx.client, "config.change")).toEqual([
      expect.objectContaining({
        actor_identity_id: admin.identityId,
        detail: expect.objectContaining({ key: "auto_shadow_ban_reports", version: 2 }),
      }),
    ]);
  });

  test("Two reports at the threshold at the same moment shadow-ban the person once", async () => {
    await withTwoConnections("kuutti-105-reports", async (pool, first, second) => {
      const { logger } = await captureLogger();
      const deps = (db: Queryable) => ({ db, logger, now: () => T });
      const b = await signedInAccount(pool);
      const reporters = await signedInPeople(pool, 3);
      for (const [i, reporter] of reporters.entries()) {
        await reportIn(pool, reporter.accountId, b.accountId, ago((i + 1) * HOUR).toISOString());
      }
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // The first check holds B's rows with its ban written; the second waits on them.
      await checkReports(deps(first), b.accountId);
      const racing = watched(checkReports(deps(second), b.accountId));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      await racing.outcome;
      await second.query("COMMIT");
      expect(await sanctionsOf(pool, b.accountId)).toEqual([byRule("reports", 3)]);
    });
  });

  test("a check that fails changes no answer, and says which check in its line", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const b = await signedInAccount(ctx.client);
    await ctx.client.query("DELETE FROM matching_config WHERE key = 'auto_shadow_ban_reports'");
    await checkReports({ db: ctx.client, logger, now: () => T }, b.accountId);
    expect(lines().find((line) => line.msg === "automatic rule check failed")).toMatchObject({
      check: "reports",
      code: "internal_error",
    });
    expect(JSON.stringify(lines())).not.toContain(b.accountId);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
  });

  test("an erased account is never checked", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const b = await signedInAccount(ctx.client);
    await reportsOf(ctx, b.accountId, [ago(3 * HOUR), ago(2 * HOUR), ago(HOUR)]);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [b.accountId]);
    await checkReports({ db: ctx.client, logger, now: () => T }, b.accountId);
    await checkReports({ db: ctx.client, logger, now: () => T }, randomUUID());
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
  });
});

describe("the first-messages rules", () => {
  describe("First messages within the hour shadow-ban the sender at the threshold", () => {
    test.for([
      [18, "not sanctioned"],
      [19, "shadow-banned by nobody for the reason other, by the rule first_messages counting 20"],
    ] as const)("%i earlier: %s", async ([earlier], { ctx, app }) => {
      const a = await signedInAccount(ctx.client);
      await openersBy(
        ctx,
        a,
        Array.from({ length: earlier }, (_, i) => ({
          body: `Moikka, olen ${i}`,
          at: ago((59 - i) * MINUTE),
        })),
      );
      await opensWith(ctx, app, a, "Moikka, mitä kuuluu tänään");
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual(
        earlier === 19 ? [byRule("first_messages", 20)] : [],
      );
    });
  });

  test("A reply is not a first message", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const writers = await signedInPeople(ctx.client, 20);
    const ids: string[] = [];
    for (const [i, writer] of writers.entries()) {
      ids.push(
        await conversationBetween(ctx.client, writer.accountId, a.accountId, {
          openedAt: ago(HOUR),
          messages: [{ from: "a", body: `Hei, olen ${i}`, at: ago((50 - i) * MINUTE) }],
        }),
      );
    }
    for (const id of ids) expect((await send(app, a, id, "Hei vain")).status).toBe(201);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("the openers other people sent a person are not theirs", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const writers = await signedInPeople(ctx.client, 19);
    for (const [i, writer] of writers.entries()) {
      // The writer opens, on side a; the person is side b.
      await conversationBetween(ctx.client, writer.accountId, a.accountId, {
        openedAt: ago(HOUR),
        messages: [{ from: "a", body: OPENER, at: ago((50 - i) * MINUTE) }],
      });
    }
    await opensWith(ctx, app, a, OPENER);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  describe("The same first message to five people shadow-bans the sender at the threshold", () => {
    test.for([
      [3, "not sanctioned"],
      [4, "shadow-banned by the rule same_first_message counting 5"],
    ] as const)("%i earlier: %s", async ([earlier], { ctx, app }) => {
      const a = await signedInAccount(ctx.client);
      await openersBy(
        ctx,
        a,
        Array.from({ length: earlier }, (_, i) => ({ body: OPENER, at: ago((20 - i) * HOUR) })),
      );
      await opensWith(ctx, app, a, "HEI katso profiilini, ja kirjoita minulle!!! 😊");
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual(
        earlier === 4 ? [byRule("same_first_message", 5)] : [],
      );
    });
  });

  describe("Only the same letters and digits make the same first message", () => {
    test.for([
      [
        "a line of words",
        "it with other spacing, line breaks and full-width letters",
        OPENER,
        "Ｈｅｉ!  Katso\nprofiilini   ja kirjoita minulle",
        true,
      ],
      [
        "a line of words",
        "it with one word changed",
        OPENER,
        "Hei! Katso profiilini ja soita minulle",
        false,
      ],
      [
        "a line of words and a number",
        "it with another number",
        "Nähdäänkö lauantaina kello 18 torilla?",
        "Nähdäänkö lauantaina kello 19 torilla?",
        false,
      ],
      ['"Moi! Mitä kuuluu?"', '"moi mitä kuuluu"', "Moi! Mitä kuuluu?", "moi mitä kuuluu", true],
    ] as const)("%s, then %s", async ([, , earlier, next, banned], { ctx, app }) => {
      const a = await signedInAccount(ctx.client);
      await openersBy(
        ctx,
        a,
        Array.from({ length: 4 }, (_, i) => ({ body: earlier, at: ago((4 - i) * HOUR) })),
      );
      await opensWith(ctx, app, a, next);
      expect((await sanctionsOf(ctx.client, a.accountId)).map((s) => s.rule)).toEqual(
        banned ? ["same_first_message"] : [],
      );
    });

    test("a photo with no caption, then a photo with no caption", async ({ ctx }) => {
      const { logger } = await captureLogger();
      const a = await signedInAccount(ctx.client);
      const others = await signedInPeople(ctx.client, 5);
      let last = "";
      for (const [i, other] of others.entries()) {
        last = await conversationBetween(ctx.client, a.accountId, other.accountId, {
          openedAt: ago(DAY),
        });
        // A photo opener with no caption: no words at all to compare.
        await ctx.client.query(
          `INSERT INTO message (conversation_id, seq, side, client_id, kind, body, created_at)
           VALUES ($1, 1, 'a', $2, 'photo', NULL, $3)`,
          [last, randomUUID(), ago((5 - i) * HOUR)],
        );
      }
      await checkFirstMessage(
        { db: ctx.client, logger, now: () => T },
        { accountId: a.accountId, conversationId: last },
      );
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
    });
  });

  test("The first message that met a rule is delivered, and the next line is withheld", async ({
    ctx,
    app,
  }) => {
    const { a, other: c, id } = await bannedByOpeners(ctx, app);
    expect((await sanctionsOf(ctx.client, a.accountId)).map((s) => s.rule)).toEqual([
      "first_messages",
    ]);
    expect((await send(app, a, id, "Vastaa jo")).status).toBe(201);
    const read = async (who: SignedIn) =>
      MessagePage.parse(
        await (await app.request(`/conversations/${id}/messages`, { headers: who.headers })).json(),
      ).messages.map((m) => m.body);
    expect(await read(c)).toEqual(["Hei numero kaksikymmentä"]);
    expect((await read(a)).sort()).toEqual(["Hei numero kaksikymmentä", "Vastaa jo"].sort());
  });

  test("A person a rule shadow-banned gets the answers they got before", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const onboarding = async () =>
      (await app.request("/onboarding", { headers: a.headers })).json();
    const conversations = async () => {
      const list = ConversationList.parse(
        await (await app.request("/conversations", { headers: a.headers })).json(),
      );
      return [...list.open, ...list.archived];
    };
    const before = await onboarding();
    await openersBy(
      ctx,
      a,
      Array.from({ length: 19 }, (_, i) => ({
        body: `Hei numero ${i}`,
        at: ago((50 - i) * MINUTE),
      })),
    );
    const listed = await conversations();
    const { id } = await opensWith(ctx, app, a, "Hei numero kaksikymmentä");
    expect(await stateOf(ctx.client, a.accountId)).toBe("shadow_banned");
    expect((await send(app, a, id, "Ja vielä yksi")).status).toBe(201);
    // The nineteen read as they did, and the new one as any open conversation does.
    const after = await conversations();
    for (const item of listed) expect(after.find((x) => x.id === item.id)).toEqual(item);
    expect(after.find((x) => x.id === id)?.state).toBe(listed[0]?.state);
    expect(await onboarding()).toEqual(before);
    expect(await listSanctionsOfAccount(ctx.client, a.accountId, 100)).toEqual([]);
  });

  test("A threshold of zero switches its rule off", async ({ ctx, app }) => {
    await withMatchingConfig(ctx.client, {
      auto_shadow_ban_first_messages: 0,
      auto_shadow_ban_same_first_message: 0,
    });
    const a = await signedInAccount(ctx.client);
    await openersBy(
      ctx,
      a,
      Array.from({ length: 19 }, (_, i) => ({ body: OPENER, at: ago((50 - i) * MINUTE) })),
    );
    await opensWith(ctx, app, a, OPENER);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a resend of an opener checks nothing again", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    await openersBy(
      ctx,
      a,
      Array.from({ length: 19 }, (_, i) => ({ body: `Hei ${i}`, at: ago((50 - i) * MINUTE) })),
    );
    const [other] = await signedInPeople(ctx.client, 1);
    if (!other) throw new Error("person not written");
    const id = await conversationBetween(ctx.client, a.accountId, other.accountId, {
      openedAt: ago(MINUTE),
    });
    // The rule off for the first send; the resend after it is switched on again must not check.
    await withMatchingConfig(ctx.client, { auto_shadow_ban_first_messages: 0 });
    const clientId = randomUUID();
    const body = { clientId, body: "Hei kaksikymmentä" };
    expect((await app.request(`/conversations/${id}/messages`, json(a.headers, body))).status).toBe(
      201,
    );
    await withMatchingConfig(ctx.client, { auto_shadow_ban_first_messages: 20 });
    expect((await app.request(`/conversations/${id}/messages`, json(a.headers, body))).status).toBe(
      200,
    );
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });
});

describe("the moderators' review", () => {
  test("A confirmed automatic shadow ban closes the reports filed before it, one by one", async ({
    ctx,
    app,
  }) => {
    const m = await staffSession(ctx.client);
    const { banId, reportIds } = await bannedByReports(ctx, app);
    const confirmed = await app.request(
      `/admin/sanctions/${banId}/review`,
      json(m.headers, { outcome: "keep", note: "Three different people in a day; it stands." }),
    );
    expect(confirmed.status).toBe(200);
    expect(await auditOf(ctx.client, "sanction.review")).toEqual([
      expect.objectContaining({
        actor_identity_id: m.identityId,
        detail: expect.objectContaining({ outcome: "keep", rule: "reports" }),
      }),
    ]);
    expect(reportIds).toHaveLength(3);
    for (const id of reportIds) {
      const decided = await app.request(
        `/admin/reports/${id}/decision`,
        json(m.headers, { outcome: "acted", sanctionId: banId }),
      );
      expect(decided.status).toBe(200);
    }
    expect((await auditOf(ctx.client, "report.decide")).length).toBe(3);
  });

  test("An automatic shadow ban nobody confirmed closes no report", async ({ ctx, app }) => {
    const m = await staffSession(ctx.client);
    const { banId, reportIds } = await bannedByReports(ctx, app);
    const refused = await app.request(
      `/admin/reports/${reportIds[0]}/decision`,
      json(m.headers, { outcome: "acted", sanctionId: banId }),
    );
    expect(refused.status).toBe(409);
    expect(ErrorResponse.parse(await refused.json()).error.code).toBe("sanction_not_for_report");
    const { rows } = await ctx.client.query("SELECT outcome FROM report WHERE id = $1", [
      reportIds[0],
    ]);
    expect(rows).toEqual([{ outcome: null }]);
  });

  test("Reversing an automatic shadow ban shows the person again with what they sent", async ({
    ctx,
    app,
  }) => {
    const m = await staffSession(ctx.client);
    const { a: b, other: c, id, banId } = await bannedByOpeners(ctx, app);
    expect((await send(app, b, id, "Missä olet?")).status).toBe(201);
    const read = async () =>
      MessagePage.parse(
        await (await app.request(`/conversations/${id}/messages`, { headers: c.headers })).json(),
      ).messages.map((message) => message.body);
    expect(await read()).not.toContain("Missä olet?");
    const reversed = await app.request(
      `/admin/sanctions/${banId}/review`,
      json(m.headers, { outcome: "lift", note: "A new member greeting everybody; not abuse." }),
    );
    expect(reversed.status).toBe(200);
    expect(await stateOf(ctx.client, b.accountId)).toBe("active");
    expect(await read()).toContain("Missä olet?");
    expect(await auditOf(ctx.client, "sanction.review")).toEqual([
      expect.objectContaining({
        actor_identity_id: m.identityId,
        detail: expect.objectContaining({ outcome: "lift", rule: "first_messages" }),
      }),
    ]);
  });

  test("After a reversal only what follows counts", async ({ ctx, app }) => {
    const m = await staffSession(ctx.client);
    const { b, banId } = await bannedByReports(ctx, app);
    const reversed = await app.request(
      `/admin/sanctions/${banId}/review`,
      json(m.headers, { outcome: "lift", note: "Friends of one person reporting together." }),
    );
    expect(reversed.status).toBe(200);
    const [f] = await signedInPeople(ctx.client, 1);
    if (!f) throw new Error("person not written");
    await reportFrom(ctx, app, f, b.accountId);
    expect((await sanctionsOf(ctx.client, b.accountId)).filter((s) => !s.lifted_at)).toEqual([]);
  });

  test("Past the review deadline the shadow ban stays until a moderator decides", async ({
    ctx,
  }) => {
    const app = await appOn(ctx.client, () => T);
    const moderator = await staffSession(ctx.client);
    const b = await signedInAccount(ctx.client);
    const banId = await ruledBan(ctx.client, b.accountId, 49);
    const list = AutomaticBanQueue.parse(
      await (
        await app.request("/admin/sanctions/automatic", { headers: moderator.headers })
      ).json(),
    );
    expect(list).toMatchObject({ now: T.toISOString(), reviewHours: 48, total: 1 });
    expect(list.items.map((item) => item.id)).toEqual([banId]);
    const front = AdminOverview.parse(
      await (await app.request("/admin/overview", { headers: moderator.headers })).json(),
    );
    expect(front.reviewHours).toBe(48);
    expect(front.queues.find((q) => q.queue === "automatic_bans")).toEqual({
      queue: "automatic_bans",
      waiting: 1,
      oldestSince: ago(49 * HOUR).toISOString(),
    });
    expect((await sanctionsOf(ctx.client, b.accountId))[0]?.lifted_at).toBeNull();
  });

  test("The list shows the rules' open shadow bans oldest first, and nobody their own", async ({
    ctx,
    app,
  }) => {
    const m = await staffSession(ctx.client);
    const [b, c, d] = await signedInPeople(ctx.client, 3);
    if (!b || !c || !d) throw new Error("people not written");
    const ofB = await ruledBan(ctx.client, b.accountId, 5);
    const ofC = await ruledBan(ctx.client, c.accountId, 3);
    await applySanction(ctx.client, {
      accountId: d.accountId,
      kind: "shadow_ban",
      reason: "harassment",
      note: "Seen in the queue.",
      actor: m.identityId,
      at: ago(4 * HOUR),
    });
    // M uses the app too, and a rule hid that account before M was made a moderator.
    const own = await accountOf(ctx.client, m.identityId);
    await ruledBan(ctx.client, own, 6);
    const list = AutomaticBanQueue.parse(
      await (await app.request("/admin/sanctions/automatic", { headers: m.headers })).json(),
    );
    expect(list.items.map((item) => item.id)).toEqual([ofB, ofC]);
    expect(list.total).toBe(2);
    expect(list.items[0]).toEqual({
      id: ofB,
      accountId: b.accountId,
      rule: "first_messages",
      count: 20,
      firstAt: ago(6 * HOUR).toISOString(),
      createdAt: ago(5 * HOUR).toISOString(),
    });
    const front = AdminOverview.parse(
      await (await app.request("/admin/overview", { headers: m.headers })).json(),
    );
    expect(front.queues.find((q) => q.queue === "automatic_bans")?.waiting).toBe(2);
  });

  test("The automatic shadow bans refuse without a session and refuse a researcher", async ({
    ctx,
    app,
  }) => {
    const member = await signedInAccount(ctx.client);
    const researcher = await staffSession(ctx.client, "researcher");
    const expired = await staffSession(ctx.client);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const revoked = await staffSession(ctx.client);
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      revoked.sessionId,
    ]);
    const b = await signedInAccount(ctx.client);
    await ruledBan(ctx.client, b.accountId);
    const before = await ctx.client.query("SELECT count(*)::int AS n FROM audit_log");
    for (const [what, headers, status, code] of [
      ["no token", {}, 401, "unauthenticated"],
      ["a product session's token", member.headers, 401, "unauthenticated"],
      ["an expired session", expired.headers, 401, "session_expired"],
      ["a revoked session", revoked.headers, 401, "session_revoked"],
      ["a researcher", researcher.headers, 403, "admin_forbidden"],
    ] as const) {
      const answer = await app.request("/admin/sanctions/automatic", { headers });
      expect(answer.status, what).toBe(status);
      expect(ErrorResponse.parse(await answer.json()).error.code, what).toBe(code);
    }
    const after = await ctx.client.query("SELECT count(*)::int AS n FROM audit_log");
    expect(after.rows).toEqual(before.rows);
  });
});
