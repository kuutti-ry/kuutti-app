import { randomUUID } from "node:crypto";
import { Sanction, SanctionList } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { type SignedIn, type Staff, signedInAccount, staffSession } from "../test/account.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type LogLine,
  type TestContext,
  testConfig,
} from "../test/harness.ts";

// The panel's seven sanction routes through the app (#307, ADR-024 §3):
// each answer's status and shape, every validation rule, each variant of the
// staff guard, the roles, the 404s and 409s, and the log lines. What a
// sanction does to the account, the sessions and the login is the domain's
// (sanctions.test.ts); here it is checked only as far as a route promises it.
// Every request is followed by a look at the log: staff's words reach no line
// of it, whatever the request answered (ADR-024 §1).

/** The routes' clock: 12:00 in Finland on a Tuesday, three days before nothing in particular. */
const T = new Date("2026-10-20T09:00:00Z");
const HOUR = 3_600_000;

// The marks are letters no id, token or request id is made of.
const NOTE_MARK = "zqxjk";
const REVIEW_MARK = "wvkpq";
const NOTE = `staff note ${NOTE_MARK}: the same messages again after a block`;
const REVIEW_NOTE = `review note ${REVIEW_MARK}: the messages stand`;
const NOTE_OF = (length: number) => NOTE_MARK.repeat(Math.ceil(length / 5)).slice(0, length);

type Headers = Record<string, string>;
type Api = { app: App; logs: () => LogLine[]; setClock: (at: Date) => void };

const test = base.extend<{ api: Api }>({
  api: async ({ ctx }, use) => {
    const { logger, lines } = await captureLogger();
    let clock = T;
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => clock });
    await use({
      app,
      logs: lines,
      setClock: (at) => {
        clock = at;
      },
    });
  },
});

async function send(
  api: Api,
  method: "GET" | "POST",
  path: string,
  headers: Headers,
  body?: unknown,
): Promise<Response> {
  const response = await api.app.request(path, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const logged = JSON.stringify(api.logs());
  for (const mark of [NOTE_MARK, REVIEW_MARK]) {
    expect(logged, `${method} ${path} logged staff's words`).not.toContain(mark);
  }
  return response;
}

const list = (api: Api, headers: Headers, accountId: string) =>
  send(api, "GET", `/admin/accounts/${accountId}/sanctions`, headers);
const apply = (api: Api, headers: Headers, accountId: string, body: unknown) =>
  send(api, "POST", `/admin/accounts/${accountId}/sanctions`, headers, body);
const ban = (
  api: Api,
  headers: Headers,
  accountId: string,
  body: unknown = { reason: "harassment", note: NOTE },
) => send(api, "POST", `/admin/accounts/${accountId}/bans`, headers, body);
type Scope = "sanctions" | "bans";
const lift = (api: Api, headers: Headers, id: string, scope: Scope = "sanctions") =>
  send(api, "POST", `/admin/${scope}/${id}/lift`, headers);
const review = (
  api: Api,
  headers: Headers,
  id: string,
  body: unknown,
  scope: Scope = "sanctions",
) => send(api, "POST", `/admin/${scope}/${id}/review`, headers, body);

const WARN = { kind: "warn", reason: "harassment", note: NOTE } as const;
const SHADOW = { kind: "shadow_ban", reason: "scraping", note: NOTE } as const;
const suspend = (endsOn = "2026-10-22") =>
  ({ kind: "suspend", reason: "misrepresentation", note: NOTE, endsOn }) as const;
const KEEP = { note: REVIEW_NOTE, outcome: "keep" } as const;
const LIFT = { note: REVIEW_NOTE, outcome: "lift" } as const;

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await errorCode(response)).toBe(code);
}

/** The answer of an apply, a ban, a lift or a review, held to the contract. */
async function sanctionOf(response: Response, status: 200 | 201): Promise<Sanction> {
  expect(response.status).toBe(status);
  return Sanction.parse(await response.json());
}

/** Everything a sanction route may write about one account, to compare before and after a refusal. */
async function footprint(ctx: TestContext, accountId: string) {
  const sanctions = await ctx.client.query(
    `SELECT id, kind, lifted_at, lifted_by, reviewed_at, reviewed_by, review_note
     FROM sanction WHERE account_id = $1 ORDER BY id`,
    [accountId],
  );
  const audit = await ctx.client.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_log WHERE subject_type = 'account' AND subject_id = $1",
    [accountId],
  );
  const standing = await ctx.client.query(
    `SELECT a.state, a.sanctioned_from, a.state_changed_at, i.standing, i.suspension_ends_at
     FROM account a JOIN identity i ON i.id = a.identity_id WHERE a.id = $1`,
    [accountId],
  );
  const live = await ctx.client.query<{ n: string }>(
    "SELECT count(*) AS n FROM session WHERE account_id = $1 AND revoked_at IS NULL",
    [accountId],
  );
  return {
    sanctions: sanctions.rows,
    audit: Number(audit.rows[0]?.n),
    account: standing.rows[0],
    liveSessions: Number(live.rows[0]?.n),
  };
}

async function standingOf(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    state: string;
    standing: string;
    suspension_ends_at: Date | null;
  }>(
    `SELECT a.state, i.standing, i.suspension_ends_at
     FROM account a JOIN identity i ON i.id = a.identity_id WHERE a.id = $1`,
    [accountId],
  );
  return rows[0];
}

async function auditOf(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    actor_identity_id: string;
    action: string;
    detail: unknown;
  }>(
    `SELECT actor_identity_id, action, detail FROM audit_log
     WHERE subject_type = 'account' AND subject_id = $1 ORDER BY at, action`,
    [accountId],
  );
  return rows;
}

async function erase(ctx: TestContext, accountId: string): Promise<void> {
  await ctx.client.query("UPDATE account SET state = 'deleted', deleted_at = $2 WHERE id = $1", [
    accountId,
    T,
  ]);
}

const lineOf = (api: Api, msg: string) => api.logs().find((line) => line.msg === msg);

/** A person to sanction, a moderator, a second moderator and an admin. */
async function cast(ctx: TestContext) {
  const person = await signedInAccount(ctx.client);
  const moderator = await staffSession(ctx.client, "moderator");
  const second = await staffSession(ctx.client, "moderator");
  const admin = await staffSession(ctx.client, "admin");
  return { person, moderator, second, admin };
}

async function applied(api: Api, staff: Staff, person: SignedIn, body: unknown) {
  return sanctionOf(await apply(api, staff.headers, person.accountId, body), 201);
}

const open = {
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
};

describe("POST /admin/accounts/{id}/sanctions", () => {
  test.for([
    ["warn", WARN, null, "active"],
    ["shadow_ban", SHADOW, null, "shadow_banned"],
    ["suspend", suspend("2026-10-22"), "2026-10-21T21:00:00.000Z", "suspended"],
  ] as const)(
    "a moderator's %s answers 201 with the row, an audit row and a log line",
    async ([kind, body, endsAt, state], { ctx, api }) => {
      const { person, moderator } = await cast(ctx);
      const item = await applied(api, moderator, person, body);
      expect(item).toEqual({
        id: item.id,
        accountId: person.accountId,
        kind,
        reason: body.reason,
        note: NOTE,
        endsAt,
        createdBy: moderator.identityId,
        createdAt: T.toISOString(),
        ...open,
      });
      expect((await standingOf(ctx, person.accountId))?.state).toBe(state);
      expect(await auditOf(ctx, person.accountId)).toEqual([
        {
          actor_identity_id: moderator.identityId,
          action: "sanction.apply",
          detail: { sanctionId: item.id, kind, reason: body.reason },
        },
      ]);
      const line = lineOf(api, "sanction applied");
      expect(line).toMatchObject({
        staffIdentityId: moderator.identityId,
        accountId: person.accountId,
        sanctionId: item.id,
        kind,
        reason: body.reason,
      });
      expect(line).not.toHaveProperty("note");
    },
  );

  test("an admin may warn too, and a suspension ends the person's sessions", async ({
    ctx,
    api,
  }) => {
    const { person, admin } = await cast(ctx);
    expect((await applied(api, admin, person, WARN)).createdBy).toBe(admin.identityId);
    expect((await footprint(ctx, person.accountId)).liveSessions).toBe(1);
    await applied(api, admin, person, suspend());
    expect((await footprint(ctx, person.accountId)).liveSessions).toBe(0);
    await refused(
      await api.app.request("/onboarding", { headers: person.headers }),
      401,
      "session_revoked",
    );
  });

  test("the note is trimmed, and 500 characters is the most it may hold", async ({ ctx, api }) => {
    const { person, moderator } = await cast(ctx);
    const trimmed = await applied(api, moderator, person, { ...WARN, note: `  \n${NOTE}\t ` });
    expect(trimmed.note).toBe(NOTE);
    const longest = await applied(api, moderator, person, {
      ...WARN,
      note: `   ${NOTE_OF(500)}   `,
    });
    expect(longest.note).toBe(NOTE_OF(500));
  });

  test.for([
    ["an unknown kind", { ...WARN, kind: "mute" }],
    ["a ban, which has its own route", { ...WARN, kind: "ban" }],
    ["no kind", { reason: "harassment", note: NOTE }],
    ["an unknown reason", { ...WARN, reason: "rudeness" }],
    ["no reason", { kind: "warn", note: NOTE }],
    ["an empty note", { ...WARN, note: "" }],
    ["a note of whitespace", { ...WARN, note: " \n\t  " }],
    ["a note of 501 characters", { ...WARN, note: NOTE_OF(501) }],
    ["no note", { kind: "warn", reason: "harassment" }],
    ["a note that is not text", { ...WARN, note: 4711 }],
    ["an extra key", { ...WARN, severity: NOTE }],
    ["an end on a warning", { ...WARN, endsOn: "2026-10-22" }],
    ["an end on a shadow ban", { ...SHADOW, endsOn: "2026-10-22" }],
    ["an end that is not a date", suspend("22.10.2026")],
    ["an end on a day no calendar has", suspend("2026-02-30")],
    ["an end with a time", suspend("2026-10-22T00:00:00Z")],
    ["a suspension without its end", { ...suspend(), endsOn: undefined }],
    ["a body that is not an object", [WARN]],
  ] as const)(
    "refuses %s with validation_failed and writes nothing",
    async ([, body], { ctx, api }) => {
      const { person, moderator } = await cast(ctx);
      const before = await footprint(ctx, person.accountId);
      await refused(
        await apply(api, moderator.headers, person.accountId, body),
        400,
        "validation_failed",
      );
      expect(await footprint(ctx, person.accountId)).toEqual(before);
      expect(lineOf(api, "request validation failed")).toBeDefined();
    },
  );

  test.for([
    ["today", "2026-10-20"],
    ["yesterday", "2026-10-19"],
    ["a day long gone", "2020-01-01"],
    ["the 367th day ahead", "2027-10-22"],
  ] as const)(
    "refuses an end of %s with ends_on_invalid and writes nothing",
    async ([, endsOn], { ctx, api }) => {
      const { person, moderator } = await cast(ctx);
      const before = await footprint(ctx, person.accountId);
      await refused(
        await apply(api, moderator.headers, person.accountId, suspend(endsOn)),
        400,
        "ends_on_invalid",
      );
      expect(await footprint(ctx, person.accountId)).toEqual(before);
    },
  );

  test.for([
    ["tomorrow", "2026-10-21", "2026-10-20T21:00:00.000Z"],
    ["the 366th day ahead", "2027-10-21", "2027-10-20T21:00:00.000Z"],
    ["a day after the clocks turn back", "2026-11-02", "2026-11-01T22:00:00.000Z"],
  ] as const)(
    "accepts an end of %s and ends it at the start of that day in Finland",
    async ([, endsOn, endsAt], { ctx, api }) => {
      const { person, moderator } = await cast(ctx);
      const item = await applied(api, moderator, person, suspend(endsOn));
      expect(item.endsAt).toBe(endsAt);
      expect((await standingOf(ctx, person.accountId))?.suspension_ends_at?.toISOString()).toBe(
        endsAt,
      );
    },
  );

  test("today is Finland's day, not the server's", async ({ ctx, api }) => {
    const { person, moderator } = await cast(ctx);
    // 00:30 on 21.10.2026 in Finland, still the 20th in UTC.
    api.setClock(new Date("2026-10-20T21:30:00Z"));
    await refused(
      await apply(api, moderator.headers, person.accountId, suspend("2026-10-21")),
      400,
      "ends_on_invalid",
    );
    expect((await applied(api, moderator, person, suspend("2026-10-22"))).endsAt).toBe(
      "2026-10-21T21:00:00.000Z",
    );
  });

  // ADR-024 §5: at most 366 days ahead, counted on Finland's calendar. Near a
  // change of the clocks a year apart, 366 times 24 hours lands an hour off.
  test.for([
    // 23:30 on 26.10.2026 in Finland (winter time); a year on is summer time.
    ["a 367th day from a winter night", "2026-10-26T21:30:00Z", "2027-10-28", 400],
    // 00:30 on 30.10.2027 in Finland (summer time); a year on is winter time.
    ["the 366th day from a summer night", "2027-10-29T21:30:00Z", "2028-10-30", 201],
  ] as const)("counts %s on the calendar", async ([, at, endsOn, status], { ctx, api }) => {
    const { person, moderator } = await cast(ctx);
    api.setClock(new Date(at));
    const response = await apply(api, moderator.headers, person.accountId, suspend(endsOn));
    expect(response.status).toBe(status);
  });

  test("an unknown account is not found, and nothing is written", async ({ ctx, api }) => {
    const { moderator } = await cast(ctx);
    const nobody = randomUUID();
    await refused(await apply(api, moderator.headers, nobody, WARN), 404, "not_found");
    expect(await footprint(ctx, nobody)).toEqual({
      sanctions: [],
      audit: 0,
      account: undefined,
      liveSessions: 0,
    });
  });

  test.for([
    ["warn", WARN],
    ["shadow_ban", SHADOW],
    ["suspend", suspend()],
  ] as const)(
    "refuses to %s an erased account with account_deleted",
    async ([, body], { ctx, api }) => {
      const { person, moderator } = await cast(ctx);
      await erase(ctx, person.accountId);
      const before = await footprint(ctx, person.accountId);
      await refused(
        await apply(api, moderator.headers, person.accountId, body),
        409,
        "account_deleted",
      );
      expect(await footprint(ctx, person.accountId)).toEqual(before);
      expect((await standingOf(ctx, person.accountId))?.standing).toBe("ok");
    },
  );
});

describe("POST /admin/accounts/{id}/bans", () => {
  test("an admin's ban answers 201, binds the identity and ends the sessions", async ({
    ctx,
    api,
  }) => {
    const { person, admin } = await cast(ctx);
    const item = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    expect(item).toEqual({
      id: item.id,
      accountId: person.accountId,
      kind: "ban",
      reason: "harassment",
      note: NOTE,
      endsAt: null,
      createdBy: admin.identityId,
      createdAt: T.toISOString(),
      ...open,
    });
    expect(await standingOf(ctx, person.accountId)).toEqual({
      state: "banned",
      standing: "banned",
      suspension_ends_at: null,
    });
    expect((await footprint(ctx, person.accountId)).liveSessions).toBe(0);
    expect(await auditOf(ctx, person.accountId)).toEqual([
      {
        actor_identity_id: admin.identityId,
        action: "sanction.apply",
        detail: { sanctionId: item.id, kind: "ban", reason: "harassment" },
      },
    ]);
    expect(lineOf(api, "sanction applied")).toMatchObject({
      staffIdentityId: admin.identityId,
      accountId: person.accountId,
      sanctionId: item.id,
      kind: "ban",
      reason: "harassment",
    });
  });

  test("an erased account's identity is banned and the tombstone stays deleted", async ({
    ctx,
    api,
  }) => {
    const { person, admin } = await cast(ctx);
    await erase(ctx, person.accountId);
    const item = await sanctionOf(
      await ban(api, admin.headers, person.accountId, { reason: "under_age", note: NOTE }),
      201,
    );
    expect(item.kind).toBe("ban");
    expect(await standingOf(ctx, person.accountId)).toEqual({
      state: "deleted",
      standing: "banned",
      suspension_ends_at: null,
    });
  });

  test.for([
    ["an unknown reason", { reason: "rudeness", note: NOTE }],
    ["no reason", { note: NOTE }],
    ["an empty note", { reason: "harassment", note: "" }],
    ["a note of whitespace", { reason: "harassment", note: "   " }],
    ["a note of 501 characters", { reason: "harassment", note: NOTE_OF(501) }],
    ["no note", { reason: "harassment" }],
    ["a kind, which the route is", { kind: "ban", reason: "harassment", note: NOTE }],
    ["an end", { reason: "harassment", note: NOTE, endsOn: "2026-10-22" }],
  ] as const)(
    "refuses %s with validation_failed and writes nothing",
    async ([, body], { ctx, api }) => {
      const { person, admin } = await cast(ctx);
      const before = await footprint(ctx, person.accountId);
      await refused(
        await ban(api, admin.headers, person.accountId, body),
        400,
        "validation_failed",
      );
      expect(await footprint(ctx, person.accountId)).toEqual(before);
    },
  );

  test("an unknown account is not found", async ({ ctx, api }) => {
    const { admin } = await cast(ctx);
    const nobody = randomUUID();
    await refused(await ban(api, admin.headers, nobody), 404, "not_found");
    expect((await footprint(ctx, nobody)).sanctions).toEqual([]);
  });
});

describe("GET /admin/accounts/{id}/sanctions", () => {
  test("lists the account's sanctions newest first, every field as written", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, second } = await cast(ctx);
    const warned = await applied(api, moderator, person, WARN);
    api.setClock(new Date(T.getTime() + HOUR));
    const hidden = await applied(api, moderator, person, SHADOW);
    api.setClock(new Date(T.getTime() + 2 * HOUR));
    const suspended = await applied(api, moderator, person, suspend());
    api.setClock(new Date(T.getTime() + 3 * HOUR));
    const lookedAt = await sanctionOf(await review(api, second.headers, hidden.id, LIFT), 200);

    const response = await list(api, moderator.headers, person.accountId);
    expect(response.status).toBe(200);
    const page = SanctionList.parse(await response.json());
    expect(page.items).toEqual([suspended, lookedAt, warned]);
    expect(lookedAt).toMatchObject({
      liftedAt: new Date(T.getTime() + 3 * HOUR).toISOString(),
      liftedBy: second.identityId,
      reviewNote: REVIEW_NOTE,
      reviewedBy: second.identityId,
    });
  });

  test("a person with no sanction has an empty list", async ({ ctx, api }) => {
    const { person, admin } = await cast(ctx);
    const response = await list(api, admin.headers, person.accountId);
    expect(response.status).toBe(200);
    expect(SanctionList.parse(await response.json())).toEqual({ items: [] });
  });

  test("a ban set on an earlier account of the identity is listed with the new one, and nothing else of it", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, admin } = await cast(ctx);
    await applied(api, moderator, person, WARN);
    await erase(ctx, person.accountId);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, birth_year, birth_month)
       SELECT identity_id, 'active', 1990, 6 FROM account WHERE id = $1 RETURNING id`,
      [person.accountId],
    );
    const newer = rows[0]?.id ?? "";
    const warnedNewer = await sanctionOf(await apply(api, moderator.headers, newer, WARN), 201);
    api.setClock(new Date(T.getTime() + HOUR));
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);

    const ofNewer = SanctionList.parse(await (await list(api, moderator.headers, newer)).json());
    expect(ofNewer.items).toEqual([banned, warnedNewer]);
    const ofErased = SanctionList.parse(
      await (await list(api, moderator.headers, person.accountId)).json(),
    );
    expect(ofErased.items.map((i) => i.kind)).toEqual(["ban", "warn"]);
  });

  test("a sanction no person applied lists with no author, and anyone may review it", async ({
    ctx,
    api,
  }) => {
    const { person, moderator } = await cast(ctx);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO sanction (identity_id, account_id, kind, reason, note, created_at)
       SELECT identity_id, id, 'shadow_ban', 'scraping', $2, $3 FROM account WHERE id = $1
       RETURNING id`,
      [person.accountId, NOTE, T],
    );
    const id = rows[0]?.id ?? "";
    const page = SanctionList.parse(
      await (await list(api, moderator.headers, person.accountId)).json(),
    );
    expect(page.items).toEqual([
      {
        id,
        accountId: person.accountId,
        kind: "shadow_ban",
        reason: "scraping",
        note: NOTE,
        endsAt: null,
        createdBy: null,
        createdAt: T.toISOString(),
        ...open,
      },
    ]);
    const item = await sanctionOf(await review(api, moderator.headers, id, KEEP), 200);
    expect(item.reviewedBy).toBe(moderator.identityId);
  });

  test("an unknown account is not found", async ({ ctx, api }) => {
    const { moderator } = await cast(ctx);
    await refused(await list(api, moderator.headers, randomUUID()), 404, "not_found");
  });
});

describe("POST /admin/sanctions/{id}/lift", () => {
  test.for([
    ["warn", WARN, "active"],
    ["shadow_ban", SHADOW, "active"],
    ["suspend", suspend(), "active"],
  ] as const)(
    "a moderator lifts a %s: 200, the account settled, an audit row and a log line",
    async ([kind, body, state], { ctx, api }) => {
      const { person, moderator, second } = await cast(ctx);
      const item = await applied(api, moderator, person, body);
      api.setClock(new Date(T.getTime() + HOUR));
      const lifted = await sanctionOf(await lift(api, second.headers, item.id), 200);
      expect(lifted).toEqual({
        ...item,
        liftedAt: new Date(T.getTime() + HOUR).toISOString(),
        liftedBy: second.identityId,
      });
      expect(await standingOf(ctx, person.accountId)).toEqual({
        state,
        standing: "ok",
        suspension_ends_at: null,
      });
      expect((await auditOf(ctx, person.accountId)).map((r) => [r.action, r.detail])).toEqual([
        ["sanction.apply", { sanctionId: item.id, kind, reason: body.reason }],
        ["sanction.lift", { sanctionId: item.id, kind, reason: body.reason }],
      ]);
      const line = lineOf(api, "sanction lifted");
      expect(line).toMatchObject({
        staffIdentityId: second.identityId,
        accountId: person.accountId,
        sanctionId: item.id,
        kind,
      });
      expect(line).not.toHaveProperty("note");
    },
  );

  test("a lift brings no ended session back", async ({ ctx, api }) => {
    const { person, moderator } = await cast(ctx);
    const item = await applied(api, moderator, person, suspend());
    await sanctionOf(await lift(api, moderator.headers, item.id), 200);
    expect((await footprint(ctx, person.accountId)).liveSessions).toBe(0);
    await refused(
      await api.app.request("/onboarding", { headers: person.headers }),
      401,
      "session_revoked",
    );
  });

  test("a second lift is refused with sanction_lifted and leaves no audit row", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, second } = await cast(ctx);
    const item = await applied(api, moderator, person, SHADOW);
    await sanctionOf(await lift(api, moderator.headers, item.id), 200);
    const before = await footprint(ctx, person.accountId);
    await refused(await lift(api, second.headers, item.id), 409, "sanction_lifted");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("an unknown sanction, and a ban, are not found here", async ({ ctx, api }) => {
    const { person, moderator, admin } = await cast(ctx);
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    const before = await footprint(ctx, person.accountId);
    await refused(await lift(api, moderator.headers, randomUUID()), 404, "not_found");
    // Not even an admin lifts a ban on the moderators' route.
    await refused(await lift(api, admin.headers, banned.id), 404, "not_found");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });
});

describe("POST /admin/bans/{id}/lift", () => {
  test("an admin lifts a ban: 200, the account back to what it was, an audit row and a log line", async ({
    ctx,
    api,
  }) => {
    const { person, admin } = await cast(ctx);
    const other = await staffSession(ctx.client, "admin");
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    api.setClock(new Date(T.getTime() + HOUR));
    const lifted = await sanctionOf(await lift(api, other.headers, banned.id, "bans"), 200);
    expect(lifted).toEqual({
      ...banned,
      liftedAt: new Date(T.getTime() + HOUR).toISOString(),
      liftedBy: other.identityId,
    });
    expect(await standingOf(ctx, person.accountId)).toEqual({
      state: "active",
      standing: "ok",
      suspension_ends_at: null,
    });
    expect((await auditOf(ctx, person.accountId)).map((r) => r.action)).toEqual([
      "sanction.apply",
      "sanction.lift",
    ]);
    expect(lineOf(api, "sanction lifted")).toMatchObject({
      staffIdentityId: other.identityId,
      accountId: person.accountId,
      sanctionId: banned.id,
      kind: "ban",
    });
  });

  test("a second lift of a ban is refused with sanction_lifted", async ({ ctx, api }) => {
    const { person, admin } = await cast(ctx);
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    await sanctionOf(await lift(api, admin.headers, banned.id, "bans"), 200);
    const before = await footprint(ctx, person.accountId);
    await refused(await lift(api, admin.headers, banned.id, "bans"), 409, "sanction_lifted");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("an unknown ban, and a sanction that is not a ban, are not found here", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, admin } = await cast(ctx);
    const warned = await applied(api, moderator, person, WARN);
    const before = await footprint(ctx, person.accountId);
    await refused(await lift(api, admin.headers, randomUUID(), "bans"), 404, "not_found");
    await refused(await lift(api, admin.headers, warned.id, "bans"), 404, "not_found");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });
});

describe("POST /admin/sanctions/{id}/review", () => {
  test("a second moderator keeps a suspension: 200, the note and who, the account as it was", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, second } = await cast(ctx);
    const item = await applied(api, moderator, person, suspend());
    api.setClock(new Date(T.getTime() + HOUR));
    const kept = await sanctionOf(await review(api, second.headers, item.id, KEEP), 200);
    expect(kept).toEqual({
      ...item,
      reviewNote: REVIEW_NOTE,
      reviewedBy: second.identityId,
      reviewedAt: new Date(T.getTime() + HOUR).toISOString(),
    });
    expect((await standingOf(ctx, person.accountId))?.state).toBe("suspended");
    expect((await auditOf(ctx, person.accountId)).map((r) => [r.action, r.detail])).toEqual([
      ["sanction.apply", { sanctionId: item.id, kind: "suspend", reason: "misrepresentation" }],
      ["sanction.review", { sanctionId: item.id, kind: "suspend", outcome: "keep" }],
    ]);
    const line = lineOf(api, "sanction reviewed");
    expect(line).toMatchObject({
      staffIdentityId: second.identityId,
      accountId: person.accountId,
      sanctionId: item.id,
      kind: "suspend",
      outcome: "keep",
    });
    expect(line).not.toHaveProperty("note");
  });

  test("a second moderator lifts a suspension in the review", async ({ ctx, api }) => {
    const { person, moderator, second } = await cast(ctx);
    const item = await applied(api, moderator, person, suspend());
    api.setClock(new Date(T.getTime() + HOUR));
    const at = new Date(T.getTime() + HOUR).toISOString();
    const done = await sanctionOf(await review(api, second.headers, item.id, LIFT), 200);
    expect(done).toEqual({
      ...item,
      liftedAt: at,
      liftedBy: second.identityId,
      reviewNote: REVIEW_NOTE,
      reviewedBy: second.identityId,
      reviewedAt: at,
    });
    expect(await standingOf(ctx, person.accountId)).toEqual({
      state: "active",
      standing: "ok",
      suspension_ends_at: null,
    });
    expect(lineOf(api, "sanction reviewed")).toMatchObject({ outcome: "lift", kind: "suspend" });
  });

  test("a lifted sanction may still be looked at and kept on the record", async ({ ctx, api }) => {
    const { person, moderator, second } = await cast(ctx);
    const item = await applied(api, moderator, person, SHADOW);
    const lifted = await sanctionOf(await lift(api, moderator.headers, item.id), 200);
    const kept = await sanctionOf(await review(api, second.headers, item.id, KEEP), 200);
    expect(kept).toMatchObject({
      liftedAt: lifted.liftedAt,
      liftedBy: moderator.identityId,
      reviewedBy: second.identityId,
    });
  });

  test("the author's own review is refused with own_sanction and writes nothing", async ({
    ctx,
    api,
  }) => {
    const { person, moderator } = await cast(ctx);
    const item = await applied(api, moderator, person, suspend());
    const before = await footprint(ctx, person.accountId);
    for (const body of [KEEP, LIFT]) {
      await refused(await review(api, moderator.headers, item.id, body), 409, "own_sanction");
    }
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("a second review is refused with sanction_reviewed", async ({ ctx, api }) => {
    const { person, moderator, second, admin } = await cast(ctx);
    const item = await applied(api, moderator, person, WARN);
    await sanctionOf(await review(api, second.headers, item.id, KEEP), 200);
    const before = await footprint(ctx, person.accountId);
    for (const body of [KEEP, LIFT]) {
      await refused(await review(api, admin.headers, item.id, body), 409, "sanction_reviewed");
    }
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("a review that would lift a lifted sanction is refused with sanction_lifted", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, second } = await cast(ctx);
    const item = await applied(api, moderator, person, SHADOW);
    await sanctionOf(await lift(api, moderator.headers, item.id), 200);
    const before = await footprint(ctx, person.accountId);
    await refused(await review(api, second.headers, item.id, LIFT), 409, "sanction_lifted");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test.for([
    ["an unknown outcome", { note: REVIEW_NOTE, outcome: "delete" }],
    ["no outcome", { note: REVIEW_NOTE }],
    ["an empty note", { note: "", outcome: "keep" }],
    ["a note of whitespace", { note: "\n  ", outcome: "keep" }],
    ["a note of 501 characters", { note: NOTE_OF(501), outcome: "keep" }],
    ["no note", { outcome: "keep" }],
    ["an extra key", { ...KEEP, kind: "warn" }],
  ] as const)(
    "refuses %s with validation_failed and writes nothing",
    async ([, body], { ctx, api }) => {
      const { person, moderator, second } = await cast(ctx);
      const item = await applied(api, moderator, person, WARN);
      const before = await footprint(ctx, person.accountId);
      await refused(await review(api, second.headers, item.id, body), 400, "validation_failed");
      expect(await footprint(ctx, person.accountId)).toEqual(before);
    },
  );

  test("an unknown sanction, and a ban, are not found here", async ({ ctx, api }) => {
    const { person, moderator, admin } = await cast(ctx);
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    const before = await footprint(ctx, person.accountId);
    await refused(await review(api, moderator.headers, randomUUID(), KEEP), 404, "not_found");
    await refused(await review(api, moderator.headers, banned.id, KEEP), 404, "not_found");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });
});

describe("POST /admin/bans/{id}/review", () => {
  test("a second admin keeps a ban, or lifts it", async ({ ctx, api }) => {
    const { person, admin } = await cast(ctx);
    const other = await staffSession(ctx.client, "admin");
    const first = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    api.setClock(new Date(T.getTime() + HOUR));
    const kept = await sanctionOf(await review(api, other.headers, first.id, KEEP, "bans"), 200);
    expect(kept).toEqual({
      ...first,
      reviewNote: REVIEW_NOTE,
      reviewedBy: other.identityId,
      reviewedAt: new Date(T.getTime() + HOUR).toISOString(),
    });
    expect(lineOf(api, "sanction reviewed")).toMatchObject({
      staffIdentityId: other.identityId,
      accountId: person.accountId,
      sanctionId: first.id,
      kind: "ban",
      outcome: "keep",
    });
    expect((await standingOf(ctx, person.accountId))?.standing).toBe("banned");

    const again = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    const done = await sanctionOf(await review(api, other.headers, again.id, LIFT, "bans"), 200);
    expect(done.liftedBy).toBe(other.identityId);
    // The first ban is still open: the person stays banned.
    expect((await standingOf(ctx, person.accountId))?.standing).toBe("banned");
    await sanctionOf(await lift(api, other.headers, first.id, "bans"), 200);
    expect(await standingOf(ctx, person.accountId)).toEqual({
      state: "active",
      standing: "ok",
      suspension_ends_at: null,
    });
  });

  test("the admin who banned may not review the ban, nor anyone twice", async ({ ctx, api }) => {
    const { person, admin } = await cast(ctx);
    const other = await staffSession(ctx.client, "admin");
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    const before = await footprint(ctx, person.accountId);
    await refused(await review(api, admin.headers, banned.id, LIFT, "bans"), 409, "own_sanction");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
    await sanctionOf(await review(api, other.headers, banned.id, KEEP, "bans"), 200);
    const third = await staffSession(ctx.client, "admin");
    await refused(
      await review(api, third.headers, banned.id, LIFT, "bans"),
      409,
      "sanction_reviewed",
    );
  });

  test("a review of a ban with an unknown outcome is validation_failed", async ({ ctx, api }) => {
    const { person, admin } = await cast(ctx);
    const other = await staffSession(ctx.client, "admin");
    const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    const before = await footprint(ctx, person.accountId);
    await refused(
      await review(api, other.headers, banned.id, { note: REVIEW_NOTE, outcome: "unban" }, "bans"),
      400,
      "validation_failed",
    );
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("an unknown ban, and a sanction that is not a ban, are not found here", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, admin } = await cast(ctx);
    const suspended = await applied(api, moderator, person, suspend());
    const before = await footprint(ctx, person.accountId);
    await refused(await review(api, admin.headers, randomUUID(), KEEP, "bans"), 404, "not_found");
    await refused(await review(api, admin.headers, suspended.id, KEEP, "bans"), 404, "not_found");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });
});

/** The seven routes, each with a body that would pass, against a person with an open warning and an open ban. */
async function sevenRoutes(ctx: TestContext, api: Api) {
  const { person, moderator, admin } = await cast(ctx);
  const warned = await applied(api, moderator, person, WARN);
  const banned = await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
  const routes = [
    ["GET /admin/accounts/{id}/sanctions", (h: Headers) => list(api, h, person.accountId)],
    ["POST /admin/accounts/{id}/sanctions", (h: Headers) => apply(api, h, person.accountId, WARN)],
    ["POST /admin/accounts/{id}/bans", (h: Headers) => ban(api, h, person.accountId)],
    ["POST /admin/sanctions/{id}/lift", (h: Headers) => lift(api, h, warned.id)],
    ["POST /admin/bans/{id}/lift", (h: Headers) => lift(api, h, banned.id, "bans")],
    ["POST /admin/sanctions/{id}/review", (h: Headers) => review(api, h, warned.id, KEEP)],
    ["POST /admin/bans/{id}/review", (h: Headers) => review(api, h, banned.id, KEEP, "bans")],
  ] as const;
  return { person, routes };
}

describe("the staff guard on the seven routes", () => {
  test("each variant of a missing or dead session is refused with its own code, and nothing is written", async ({
    ctx,
    api,
  }) => {
    const { person, routes } = await sevenRoutes(ctx, api);
    const bystander = await signedInAccount(ctx.client);
    const ended = await staffSession(ctx.client, "admin");
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const expired = await staffSession(ctx.client, "admin");
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const demoted = await staffSession(ctx.client, "admin");
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      demoted.identityId,
    ]);
    const suspendedStaff = await staffSession(ctx.client, "admin");
    await ctx.client.query("UPDATE identity SET standing = 'suspended' WHERE id = $1", [
      suspendedStaff.identityId,
    ]);
    const before = await footprint(ctx, person.accountId);
    for (const [what, headers, code] of [
      ["no token", {}, "unauthenticated"],
      ["another scheme", { authorization: `Basic ${"A".repeat(43)}` }, "unauthenticated"],
      ["a malformed token", { authorization: "Bearer not-a-token" }, "unauthenticated"],
      ["a product session's token", bystander.headers, "unauthenticated"],
      ["an ended session", ended.headers, "session_revoked"],
      ["a role taken away", demoted.headers, "session_revoked"],
      ["staff no longer in good standing", suspendedStaff.headers, "session_revoked"],
      ["an expired session", expired.headers, "session_expired"],
    ] as const) {
      for (const [route, call] of routes) {
        const response = await call(headers);
        expect(response.status, `${what}: ${route}`).toBe(401);
        expect(await errorCode(response), `${what}: ${route}`).toBe(code);
      }
    }
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("the guard answers before the contract is read", async ({ api }) => {
    await refused(await list(api, {}, "not-a-uuid"), 401, "unauthenticated");
    await refused(await apply(api, {}, "not-a-uuid", { kind: "mute" }), 401, "unauthenticated");
    await refused(await review(api, {}, "not-a-uuid", {}, "bans"), 401, "unauthenticated");
  });

  test("a researcher is refused all seven with admin_forbidden, and nothing is written", async ({
    ctx,
    api,
  }) => {
    const { person, routes } = await sevenRoutes(ctx, api);
    const researcher = await staffSession(ctx.client, "researcher");
    const before = await footprint(ctx, person.accountId);
    for (const [route, call] of routes) {
      const response = await call(researcher.headers);
      expect(response.status, route).toBe(403);
      expect(await errorCode(response), route).toBe("admin_forbidden");
    }
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("a moderator is refused the three ban routes with admin_forbidden, and nothing is written", async ({
    ctx,
    api,
  }) => {
    const { person, routes } = await sevenRoutes(ctx, api);
    const moderator = await staffSession(ctx.client, "moderator");
    const before = await footprint(ctx, person.accountId);
    const banRoutes = routes.filter(([route]) => route.includes("ban"));
    expect(banRoutes.map(([route]) => route)).toEqual([
      "POST /admin/accounts/{id}/bans",
      "POST /admin/bans/{id}/lift",
      "POST /admin/bans/{id}/review",
    ]);
    for (const [route, call] of banRoutes) {
      const response = await call(moderator.headers);
      expect(response.status, route).toBe(403);
      expect(await errorCode(response), route).toBe("admin_forbidden");
    }
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });

  test("an id that is not a uuid is validation_failed on all seven", async ({ ctx, api }) => {
    const { admin } = await cast(ctx);
    for (const response of [
      await list(api, admin.headers, "42"),
      await apply(api, admin.headers, "42", WARN),
      await ban(api, admin.headers, "42"),
      await lift(api, admin.headers, "42"),
      await lift(api, admin.headers, "42", "bans"),
      await review(api, admin.headers, "42", KEEP),
      await review(api, admin.headers, "42", KEEP, "bans"),
    ]) {
      await refused(response, 400, "validation_failed");
    }
  });
});

describe("a member of staff as the target or the actor's own sanction (ADR-024 §3)", () => {
  /** A live account on a member of staff's identity, as a person of the panel's own would have. */
  async function staffAccount(ctx: TestContext, role: "moderator" | "admin" | "researcher") {
    const staff = await staffSession(ctx.client, role);
    const { rows } = await ctx.client.query<{ id: string }>(
      "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
      [staff.identityId],
    );
    return { ...staff, accountId: rows[0]?.id ?? "" };
  }

  test("refuses a sanction or a ban on a member of staff with staff_target and writes nothing", async ({
    ctx,
    api,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const target = await staffAccount(ctx, "moderator");
    const before = await footprint(ctx, target.accountId);
    await refused(await apply(api, admin.headers, target.accountId, WARN), 409, "staff_target");
    await refused(
      await apply(api, admin.headers, target.accountId, suspend()),
      409,
      "staff_target",
    );
    await refused(await ban(api, admin.headers, target.accountId), 409, "staff_target");
    expect(await footprint(ctx, target.accountId)).toEqual(before);
  });

  test("refuses a member of staff lifting or reviewing a sanction on themselves with own_account", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    const applied = await sanctionOf(
      await apply(api, moderator.headers, person.accountId, SHADOW),
      201,
    );
    // The person becomes a moderator afterwards, with a panel session of their own.
    const { rows } = await ctx.client.query<{ identity_id: string }>(
      "SELECT identity_id FROM account WHERE id = $1",
      [person.accountId],
    );
    const identityId = rows[0]?.identity_id ?? "";
    await ctx.client.query(
      "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
      [identityId],
    );
    const token = "o".repeat(43);
    await ctx.client.query(
      `INSERT INTO admin_session (identity_id, role, access_hash, expires_at)
       VALUES ($1, 'moderator', encode(sha256($2::bytea), 'hex'), now() + interval '8 hours')`,
      [identityId, token],
    );
    const own = { authorization: `Bearer ${token}` };
    const before = await footprint(ctx, person.accountId);
    await refused(await lift(api, own, applied.id), 409, "own_account");
    await refused(await review(api, own, applied.id, LIFT), 409, "own_account");
    expect(await footprint(ctx, person.accountId)).toEqual(before);
  });
});

describe("staff's words in the log", () => {
  test("no line of a request carries a note, applied, lifted, reviewed or refused", async ({
    ctx,
    api,
  }) => {
    const { person, moderator, second, admin } = await cast(ctx);
    const item = await applied(api, moderator, person, suspend());
    await sanctionOf(await review(api, second.headers, item.id, KEEP), 200);
    await sanctionOf(await lift(api, second.headers, item.id), 200);
    await sanctionOf(await ban(api, admin.headers, person.accountId), 201);
    await refused(await review(api, admin.headers, item.id, KEEP), 409, "sanction_reviewed");
    await refused(await review(api, moderator.headers, item.id, KEEP), 409, "own_sanction");
    await refused(
      await apply(api, moderator.headers, person.accountId, { ...WARN, note: NOTE_OF(501) }),
      400,
      "validation_failed",
    );
    await refused(
      await apply(api, moderator.headers, person.accountId, { ...WARN, kind: "ban" }),
      400,
      "validation_failed",
    );
    const logged = api.logs();
    expect(logged.map((l) => l.msg)).toEqual(
      expect.arrayContaining([
        "sanction applied",
        "sanction reviewed",
        "sanction lifted",
        "request validation failed",
      ]),
    );
    const text = JSON.stringify(logged);
    expect(text).not.toContain(NOTE_MARK);
    expect(text).not.toContain(REVIEW_MARK);
    expect(text).not.toContain("the same messages again");
  });
});
