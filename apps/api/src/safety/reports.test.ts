import { resolve } from "node:path";
import { createPool, migrate, withTemporaryDatabase } from "@kuutti/db";
import { ErrorResponse, GateResponse, REPORT_NOTE_MAX } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import { countGates } from "../jobs/pond-gate.ts";
import { dayWindow } from "../media/index.ts";
import { signedInAccount, signInAs, staffSession, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { exportOf } from "../test/export.ts";
import { captureLogger, type TestContext, test } from "../test/harness.ts";
import { type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { pruneReports, REPORT_RETENTION_DAYS, recordReport } from "./reports.ts";

// features/safety/reports.feature (#84, ADR-030): the route, the reasons, the
// note that reaches nobody but the moderators, the day's cap, one open report
// per pair, what the reported person can learn (nothing), and the twelve
// months. The block a report writes holds where blocks.test.ts says.

// A marker of letters: a number can turn up in a log line's timestamp by chance.
const MARK = "qzxvkw";
const NOTE = `He asked for my WhatsApp in the first line ${MARK}.`;
const UNKNOWN = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const DAY_MS = 86_400_000;
// Two nights of the gate's count, 04:00 in Helsinki.
const NIGHT_1 = new Date("2026-10-05T01:00:00Z");
const NIGHT_2 = new Date("2026-10-06T01:00:00Z");
/** Women who seek women, complete: every two of them are in each other's pool. */
const ALIKE: PeopleOptions = { gender: "woman", seeks: ["woman"], complete: true, consented: true };

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const report = (ctx: TestContext, headers: Record<string, string>, body: unknown) =>
  ctx.app.request("/reports", {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  ErrorResponse.parse(await response.json()).error.code;

type ReportRow = {
  reported_account_id: string;
  source: string;
  reason: string;
  note: string | null;
  outcome: string | null;
  decided_at: Date | null;
};
const reportsOf = async (ctx: TestContext, reporter: string) =>
  (
    await ctx.client.query<ReportRow>(
      `SELECT reported_account_id, source, reason, note, outcome, decided_at FROM report
       WHERE reporter_account_id = $1 ORDER BY created_at, id`,
      [reporter],
    )
  ).rows;
const count = async (ctx: TestContext, sql: string, params: unknown[] = []) =>
  Number((await ctx.client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
const blockedBetween = async (ctx: TestContext, a: string, b: string) =>
  (
    await ctx.client.query<{ blocked: boolean }>("SELECT blocked_between($1, $2) AS blocked", [
      a,
      b,
    ])
  ).rows[0]?.blocked === true;

/** A signed-in person who was shown the cards of `n` others, signed in too: what a report needs. */
async function viewerOf(ctx: TestContext, n: number) {
  const viewer = await signedInAccount(ctx.client);
  const subjects: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const subject = await signedInAccount(ctx.client);
    await cardShown(ctx.client, viewer.accountId, subject.accountId);
    subjects.push(subject.accountId);
  }
  return { viewer, subjects };
}

describe("A report from a card lands with its reason, open, and blocks both ways", () => {
  test.for([
    ["harassment", NOTE],
    ["misrepresentation", null],
    ["under_age", "Says she is in year 9 at school."],
    ["commercial_use", null],
    ["scraping", "Asked twenty people the same questions."],
    ["other", null],
  ] as const)("%s, with the note %s", async ([reason, note], { ctx }) => {
    const { viewer, subjects } = await viewerOf(ctx, 1);
    const [b] = subjects as [string];
    const answer = await report(ctx, viewer.headers, {
      accountId: b,
      reason,
      ...(note === null ? {} : { note }),
    });
    expect(answer.status).toBe(204);
    expect(await answer.text()).toBe("");
    expect(await reportsOf(ctx, viewer.accountId)).toEqual([
      { reported_account_id: b, source: "card", reason, note, outcome: null, decided_at: null },
    ]);
    expect(await blockedBetween(ctx, viewer.accountId, b)).toBe(true);
    expect(await blockedBetween(ctx, b, viewer.accountId)).toBe(true);
  });
});

describe("a report from a card that points at one photo (#476)", () => {
  test("a card's report keeps the photo it points at, of the card the reporter was shown, and blocks both ways", async ({
    ctx,
  }) => {
    const { viewer, subjects } = await viewerOf(ctx, 1);
    const [b] = subjects as [string];
    // B's card had a second photo, shown too, and a third that was never shown.
    const first = await cardShown(ctx.client, viewer.accountId, b);
    const photoOf = async () => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
         VALUES ($1, md5(random()::text), 'LKO2?U%2Tw=w', 800, 1067, 'approved',
                 (SELECT coalesce(max(position) + 1, 0) FROM photo
                  WHERE account_id = $1 AND purpose = 'profile'))
         RETURNING id`,
        [b],
      );
      return rows[0]?.id ?? "";
    };
    const second = await photoOf();
    await ctx.client.query(
      "INSERT INTO card_shown (account_id, photo_id, at) VALUES ($1, $2, now())",
      [viewer.accountId, second],
    );
    await photoOf();
    const answer = await report(ctx, viewer.headers, {
      accountId: b,
      reason: "misrepresentation",
      photoId: second,
    });
    expect(answer.status).toBe(204);
    const kept = await ctx.client.query(
      "SELECT source, line_seq, photo_id, photo_pointed FROM report WHERE reporter_account_id = $1",
      [viewer.accountId],
    );
    expect(kept.rows).toEqual([
      { source: "card", line_seq: null, photo_id: second, photo_pointed: true },
    ]);
    expect(await blockedBetween(ctx, viewer.accountId, b)).toBe(true);
    expect(first).not.toBe(second);
  });

  test("the photo a card's report points at reaches no log line, and the reporter's export does not carry it", async ({
    ctx,
  }) => {
    const { viewer, subjects } = await viewerOf(ctx, 1);
    const [b] = subjects as [string];
    const shown = await cardShown(ctx.client, viewer.accountId, b);
    expect(
      (await report(ctx, viewer.headers, { accountId: b, reason: "other", photoId: shown })).status,
    ).toBe(204);
    expect(JSON.stringify(ctx.logs())).not.toContain(shown);
    const exported = await exportOf(ctx.app, viewer.headers);
    expect(exported.reports.items).toHaveLength(1);
    expect(JSON.stringify(exported.reports)).not.toContain(shown);
  });
});

describe("what a report tells, and to whom", () => {
  test("The note reaches no log line, no error detail and no event", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { reports_per_day: 1 });
    const { viewer, subjects } = await viewerOf(ctx, 2);
    const [b, c] = subjects as [string, string];
    // With the research consent, so that an event would be recorded if one were sent.
    const consent = await ctx.app.request("/consents", {
      method: "POST",
      headers: json(viewer.headers),
      body: JSON.stringify({
        kind: "research",
        version: CURRENT_CONSENT_VERSIONS.research,
        locale: "fi",
      }),
    });
    expect(consent.status).toBe(200);
    const events = await count(ctx, "SELECT count(*) AS n FROM events");

    // Filed; refused for its length; refused by the day's cap.
    expect(
      (await report(ctx, viewer.headers, { accountId: b, reason: "harassment", note: NOTE }))
        .status,
    ).toBe(204);
    const long = `${MARK} ${"x".repeat(REPORT_NOTE_MAX)}`;
    expect(
      (await report(ctx, viewer.headers, { accountId: c, reason: "other", note: long })).status,
    ).toBe(400);
    expect(
      (await report(ctx, viewer.headers, { accountId: c, reason: "harassment", note: NOTE }))
        .status,
    ).toBe(429);

    const lines = JSON.stringify(ctx.logs());
    expect(lines).not.toContain(MARK);
    // Neither whom, nor why: the request lines and the cap's refusal name the caller alone.
    expect(lines).not.toContain(b);
    expect(lines).not.toContain(c);
    expect(lines).not.toContain("harassment");
    expect(await count(ctx, "SELECT count(*) AS n FROM events")).toBe(events);
    // The note is the moderators' to read, and it is stored as written.
    expect((await reportsOf(ctx, viewer.accountId)).map((row) => row.note)).toEqual([NOTE]);
  });

  test("The reported person learns nothing from any route", async ({ ctx }) => {
    // Two ponds alike of thirty people who all fit: each has twenty-nine
    // others, so every gate is shut after the first night, and a thirty-first
    // comes to each, so the next night would open them all. In one, A reports
    // B; in the other, C narrows her own window so that D is out of it, which
    // anybody may do (ADR-030 §3, §6).
    await withMatchingConfig(ctx.client, { gate_k: 30, majority_share_max: 0.6 });
    const pond = await pondNamed(ctx.client, "test-report-learns-nothing");
    const twin = await pondNamed(ctx.client, "test-report-window-twin");
    const [a, b, rest] = (await people(ctx.client, pond, 3, ALIKE)) as [string, string, string];
    const [c, d] = (await people(ctx.client, twin, 2, ALIKE)) as [string, string];
    await people(ctx.client, pond, 27, ALIKE);
    await people(ctx.client, twin, 28, ALIKE);
    const { logger } = await captureLogger();
    const night = (at: Date) => countGates({ db: ctx.client, logger, now: () => at });
    await night(NIGHT_1);
    await people(ctx.client, pond, 1, ALIKE);
    await people(ctx.client, twin, 1, ALIKE);
    await cardShown(ctx.client, a, b);
    const headersOf = async (id: string) => (await signInAs(ctx.client, id)).headers;
    const asA = await headersOf(a);
    const asB = await headersOf(b);
    const asC = await headersOf(c);
    const asD = await headersOf(d);
    const asRest = await headersOf(rest);
    const gateOf = async (headers: Record<string, string>) =>
      GateResponse.parse(await (await ctx.app.request("/gate", { headers })).json());
    const read = async () => {
      const onboarding = await (await ctx.app.request("/onboarding", { headers: asB })).json();
      // What B's own asking moves: the copy's time, the copies taken, the session's last use.
      const {
        exportedAt: _at,
        exports: _exports,
        sessions: _sessions,
        ...document
      } = await exportOf(ctx.app, asB);
      return { onboarding, gate: await gateOf(asB), document };
    };
    const before = await read();
    expect(before.gate).toMatchObject({ state: "closed", needed: 10 });
    expect(
      (await report(ctx, asA, { accountId: b, reason: "harassment", note: NOTE })).status,
    ).toBe(204);
    const narrower = await ctx.app.request("/preferences", {
      method: "PUT",
      headers: json(asC),
      body: JSON.stringify({ seeks: ["woman"], ageWindow: { min: 50, max: 60 } }),
    });
    expect(narrower.status).toBe(200);
    // The same day, everything B can ask reads as it did.
    const after = await read();
    expect(after).toEqual(before);
    expect(after.document.reports.items).toEqual([]);
    expect(after.document.blocks.items).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(a);
    expect(JSON.stringify(after)).not.toContain(MARK);
    // B's gate moves at the night's count alone, and exactly as D's does, whom
    // C's window left out: one short of the thirty, while the rest open.
    await night(NIGHT_2);
    const [ofB, ofD] = [await gateOf(asB), await gateOf(asD)];
    expect(ofB).toEqual(ofD);
    expect(ofB).toMatchObject({ state: "closed", needed: 10 });
    expect((await gateOf(asRest)).state).toBe("open");
  });
});

describe("how many, and how often", () => {
  test("A second report of the same person while one is open writes nothing more", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { reports_per_day: 1 });
    const { viewer, subjects } = await viewerOf(ctx, 1);
    const [b] = subjects as [string];
    const staff = await staffSession(ctx.client);
    expect((await report(ctx, viewer.headers, { accountId: b, reason: "harassment" })).status).toBe(
      204,
    );
    // The same answer, nothing written, and the day's one report is not spent on it.
    const again = await report(ctx, viewer.headers, { accountId: b, reason: "other", note: NOTE });
    expect(again.status).toBe(204);
    expect(await reportsOf(ctx, viewer.accountId)).toEqual([
      expect.objectContaining({ reason: "harassment", note: null }),
    ]);
    // Once a moderator has decided it, a new one is a new row (the next day's, here).
    await ctx.client.query(
      `UPDATE report SET outcome = 'dismissed', decided_at = now(), decided_by = $2,
         created_at = created_at - interval '1 day'
       WHERE reporter_account_id = $1`,
      [viewer.accountId, staff.identityId],
    );
    expect((await report(ctx, viewer.headers, { accountId: b, reason: "other" })).status).toBe(204);
    expect(
      (await reportsOf(ctx, viewer.accountId)).map((row) => [row.reason, row.outcome]),
    ).toEqual([
      ["harassment", "dismissed"],
      ["other", null],
    ]);
  });

  test("The sixth report of a day is refused in words and writes nothing", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { reports_per_day: 5 });
    const { viewer, subjects } = await viewerOf(ctx, 7);
    // Yesterday's report is yesterday's.
    await ctx.client.query(
      `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, created_at)
       VALUES ($1, $2, 'card', 'other', $3)`,
      [viewer.accountId, subjects[6], new Date(dayWindow(new Date()).start.getTime() - 1)],
    );
    for (const subject of subjects.slice(0, 5)) {
      expect(
        (await report(ctx, viewer.headers, { accountId: subject, reason: "other" })).status,
      ).toBe(204);
    }
    const sixth = subjects[5] as string;
    const refused = await report(ctx, viewer.headers, { accountId: sixth, reason: "other" });
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("report_budget_exceeded");
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await reportsOf(ctx, viewer.accountId)).length).toBe(6);
    // Nothing for the sixth, the block neither.
    expect(await blockedBetween(ctx, viewer.accountId, sixth)).toBe(false);
    expect(ctx.logs().find((line) => line.msg === "report refused")).toMatchObject({
      accountId: viewer.accountId,
      used: 5,
      limit: 5,
      refusal: "budget",
    });
    // Another person's day is their own.
    const other = await viewerOf(ctx, 1);
    expect(
      (await report(ctx, other.viewer.headers, { accountId: other.subjects[0], reason: "other" }))
        .status,
    ).toBe(204);
  });

  it("holds against a parallel burst: exactly the cap is written, and a block for each", async () => {
    // The race is between connections, so the rows are committed, into a
    // database of the test's own (media/budget.test.ts's way).
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 6, applicationName: "kuutti-burst" });
      try {
        await migrate(pool, resolve(import.meta.dirname, "../../../../packages/db/drizzle"));
        const person = async (label: string) => {
          const { rows } = await pool.query<{ id: string }>(
            `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id)
             INSERT INTO account (identity_id, state, birth_year, birth_month)
             SELECT id, 'active', 1990, 6 FROM i RETURNING id`,
            [`burst ${label}`],
          );
          return rows[0]?.id ?? "";
        };
        const viewer = await person("viewer");
        const subjects: string[] = [];
        for (let i = 0; i < 12; i += 1) {
          const subject = await person(`subject ${i}`);
          await cardShown(pool, viewer, subject);
          subjects.push(subject);
        }
        const at = new Date();
        const results = await Promise.all(
          subjects.map((subject) =>
            recordReport(pool, {
              reporterAccountId: viewer,
              reportedAccountId: subject,
              reason: "other",
              note: null,
              photoId: null,
              at,
              since: new Date(at.getTime() - 3_600_000),
              limit: 3,
            }),
          ),
        );
        expect(results.filter((r) => r.outcome === "filed")).toHaveLength(3);
        expect(results.filter((r) => r.outcome === "over_budget")).toHaveLength(9);
        const rows = async (table: string) =>
          Number(
            (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
          );
        expect(await rows("report")).toBe(3);
        expect(await rows("block")).toBe(3);
      } finally {
        await pool.end();
      }
    });
  }, 30_000);
});

describe("what the answers do not tell", () => {
  test("an open report and the day's cap answer before the card is asked about", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { reports_per_day: 1 });
    const { viewer, subjects } = await viewerOf(ctx, 2);
    const [b, c] = subjects as [string, string];
    expect((await report(ctx, viewer.headers, { accountId: b, reason: "harassment" })).status).toBe(
      204,
    );
    // B's photos go: the report still open answers as it did.
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [b]);
    expect((await report(ctx, viewer.headers, { accountId: b, reason: "other" })).status).toBe(204);
    // C is erased, photos and all. Over the day's cap the answer is the cap's,
    // whoever is named: still there or not, shown or not.
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [c]);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [c],
    );
    for (const accountId of [c, UNKNOWN, viewer.accountId]) {
      const refused = await report(ctx, viewer.headers, { accountId, reason: "other" });
      expect(refused.status, accountId).toBe(429);
      expect(await errorCode(refused)).toBe("report_budget_exceeded");
    }
    expect(await count(ctx, "SELECT count(*) AS n FROM report")).toBe(1);
    expect(await count(ctx, "SELECT count(*) AS n FROM block")).toBe(1);
  });

  test("the person blocked reports the one who blocked them alike whether they are still there or not, and again once a report is decided", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
    await cardShown(ctx.client, b.accountId, a.accountId);
    const blocked = await ctx.app.request("/blocks", {
      method: "POST",
      headers: json(a.headers),
      body: JSON.stringify({ accountId: b.accountId }),
    });
    expect(blocked.status).toBe(204);
    // A puts up new photos, so B's shown records of A are gone: the block is B's proof.
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [a.accountId]);
    expect(
      (await report(ctx, b.headers, { accountId: a.accountId, reason: "harassment" })).status,
    ).toBe(204);
    // A moderator decides it; then A is erased, and B asks again: filed again, alike.
    await ctx.client.query(
      `UPDATE report SET outcome = 'dismissed', decided_at = now(), decided_by = $2
       WHERE reporter_account_id = $1`,
      [b.accountId, staff.identityId],
    );
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [a.accountId],
    );
    expect((await report(ctx, b.headers, { accountId: a.accountId, reason: "other" })).status).toBe(
      204,
    );
    expect((await reportsOf(ctx, b.accountId)).map((row) => [row.reason, row.outcome])).toEqual([
      ["harassment", "dismissed"],
      ["other", null],
    ]);
  });
});

describe("who may be reported", () => {
  test("Only somebody whose card the person was shown can be reported", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    await cardShown(ctx.client, c.accountId, b.accountId);
    for (const [what, accountId] of [
      ["never shown", b.accountId],
      ["oneself", a.accountId],
      ["nobody", UNKNOWN],
    ] as const) {
      const answer = await report(ctx, a.headers, { accountId, reason: "harassment", note: NOTE });
      expect(answer.status, what).toBe(404);
      expect(await errorCode(answer), what).toBe("not_found");
    }
    expect(await count(ctx, "SELECT count(*) AS n FROM report")).toBe(0);
    expect(await count(ctx, "SELECT count(*) AS n FROM block")).toBe(0);
    expect(JSON.stringify(ctx.logs())).not.toContain(MARK);
    // C was shown B's card: C may.
    expect((await report(ctx, c.headers, { accountId: b.accountId, reason: "other" })).status).toBe(
      204,
    );
  });

  test("Reporting refuses without a session", async ({ ctx }) => {
    const { subjects } = await viewerOf(ctx, 1);
    const staff = await staffSession(ctx.client);
    const ended = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const expired = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    for (const [what, headers, code] of [
      ["no token", {}, "unauthenticated"],
      ["a token nobody issued", { authorization: `Bearer ${"C".repeat(43)}` }, "unauthenticated"],
      ["a staff token", staff.headers, "unauthenticated"],
      ["an ended session", ended.headers, "session_revoked"],
      ["an expired access token", expired.headers, "session_expired"],
    ] as const) {
      const answer = await report(ctx, headers, { accountId: subjects[0], reason: "other" });
      expect(answer.status, what).toBe(401);
      expect(await errorCode(answer), what).toBe(code);
    }
    expect(await count(ctx, "SELECT count(*) AS n FROM report")).toBe(0);
  });
});

describe("the report route's edges", () => {
  test.for([
    ["no reason", { reason: undefined }],
    ["an unknown reason", { reason: "rude" }],
    ["a note over the cap", { note: "x".repeat(REPORT_NOTE_MAX + 1) }],
    ["a note of spaces", { note: "   " }],
    ["an account id that is not one", { accountId: "b" }],
    ["an unknown key", { source: "card" }],
    // A card's pointer is a photo id (#476); a line is a conversation's.
    ["a photo id that is not one", { photoId: "p" }],
    ["a line, which is a conversation's pointer", { seq: 1 }],
  ] as const)("refuses %s with 400 and writes nothing", async ([, patch], { ctx }) => {
    const { viewer, subjects } = await viewerOf(ctx, 1);
    const answer = await report(ctx, viewer.headers, {
      accountId: subjects[0],
      reason: "other",
      ...patch,
    });
    expect(answer.status).toBe(400);
    expect(await errorCode(answer)).toBe("validation_failed");
    expect(await count(ctx, "SELECT count(*) AS n FROM report")).toBe(0);
    expect(await count(ctx, "SELECT count(*) AS n FROM block")).toBe(0);
  });

  test("a request that outlived the reporter's erasure writes nothing", async ({ ctx }) => {
    const { viewer, subjects } = await viewerOf(ctx, 1);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [viewer.accountId],
    );
    const at = new Date();
    const record = await recordReport(ctx.client, {
      reporterAccountId: viewer.accountId,
      reportedAccountId: subjects[0] as string,
      reason: "other",
      note: NOTE,
      photoId: null,
      at,
      since: dayWindow(at).start,
      limit: 5,
    });
    expect(record).toEqual({ outcome: "not_found" });
    expect(await count(ctx, "SELECT count(*) AS n FROM report")).toBe(0);
    expect(await count(ctx, "SELECT count(*) AS n FROM block")).toBe(0);
  });
});

describe("the twelve months", () => {
  test("The night prunes reports older than twelve months", async ({ ctx }) => {
    const { viewer, subjects } = await viewerOf(ctx, 4);
    const staff = await staffSession(ctx.client);
    const now = new Date("2027-10-20T01:00:00Z");
    const edge = now.getTime() - REPORT_RETENTION_DAYS * DAY_MS;
    // Two past the twelve months (one open, one decided), two inside them, the edge one to the millisecond.
    const filed: Array<[string, number, boolean]> = [
      [subjects[0] as string, edge - 1, false],
      [subjects[1] as string, edge - DAY_MS, true],
      [subjects[2] as string, edge, false],
      [subjects[3] as string, edge + DAY_MS, true],
    ];
    for (const [subject, at, decided] of filed) {
      await ctx.client.query(
        `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, note, created_at,
                             outcome, decided_at, decided_by)
         VALUES ($1, $2, 'card', 'other', $3, $4, $5, $6, $7)`,
        [
          viewer.accountId,
          subject,
          NOTE,
          new Date(at),
          decided ? "dismissed" : null,
          decided ? new Date(at + 1000) : null,
          decided ? staff.identityId : null,
        ],
      );
      await ctx.client.query(
        `INSERT INTO block (blocker_identity_id, blocked_identity_id, created_at)
         SELECT me.identity_id, them.identity_id, $3 FROM account me, account them
         WHERE me.id = $1 AND them.id = $2`,
        [viewer.accountId, subject, new Date(at)],
      );
    }
    const { logger } = await captureLogger();
    expect(await pruneReports({ db: ctx.client, logger }, now)).toEqual({
      pruned: 2,
      photos: 0,
      objects: 0,
    });
    expect((await reportsOf(ctx, viewer.accountId)).map((row) => row.reported_account_id)).toEqual([
      subjects[2],
      subjects[3],
    ]);
    // The blocks stay: they are not the report's.
    expect(await count(ctx, "SELECT count(*) AS n FROM block")).toBe(4);
    expect((await pruneReports({ db: ctx.client, logger }, now)).pruned).toBe(0);
  });
});
