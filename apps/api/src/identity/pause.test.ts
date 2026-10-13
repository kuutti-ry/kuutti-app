import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { pauseAccount, resumeAccount } from "./pause.ts";

// features/identity/pause.feature through the route (#170, ADR-022): real
// Postgres in a rolled-back transaction. The bank login that ends a break is
// in routes.test.ts, with the broker; here the resume is called as the login
// calls it.

const DAY_MS = 86_400_000;

async function appWith(ctx: TestContext) {
  const { logger, lines } = await captureLogger();
  const app = createApp({ config: testConfig(), logger, db: ctx.client });
  return { app, logger, logs: lines };
}

const pause = (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  body: unknown = { confirm: true },
) =>
  app.request("/account/pause", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function count(ctx: TestContext, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await ctx.client.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function accountRow(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    state: string;
    paused_from: string | null;
    state_changed_at: Date | null;
  }>("SELECT state, paused_from, state_changed_at FROM account WHERE id = $1", [accountId]);
  return rows[0];
}

/** What the person holds, counted: the break must leave every figure as it was. */
async function holdings(ctx: TestContext, accountId: string) {
  const per = async (table: string) =>
    count(ctx, `SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId]);
  const { rows } = await ctx.client.query<{ gender: string | null; pond_id: string | null }>(
    "SELECT gender, pond_id FROM account WHERE id = $1",
    [accountId],
  );
  return {
    profile: await per("profile"),
    photo: await per("photo"),
    preferences: await per("preferences"),
    consent: await per("consent"),
    gate: await per("gate"),
    gender: rows[0]?.gender,
    pond: rows[0]?.pond_id,
  };
}

async function liveSessions(ctx: TestContext, accountId: string) {
  return count(
    ctx,
    "SELECT count(*) AS n FROM session WHERE account_id = $1 AND revoked_at IS NULL",
    [accountId],
  );
}

describe("taking a break", () => {
  test("Taking a break hides the profile, ends every session and erases nothing", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    // The second device: another session row of the same account.
    const second = await signedInAccount(ctx.client, "a2");
    await ctx.client.query("UPDATE session SET account_id = $1 WHERE id = $2", [
      a.accountId,
      second.sessionId,
    ]);
    await ctx.client.query("DELETE FROM account WHERE id = $1", [second.accountId]);
    const pond = await ctx.client.query<{ id: string }>(
      "INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('break-pond', 'Pond', 'Pondissa') RETURNING id",
    );
    const pondId = pond.rows[0]?.id;
    await ctx.client.query("UPDATE account SET gender = 'woman', pond_id = $2 WHERE id = $1", [
      a.accountId,
      pondId,
    ]);
    await ctx.client.query(
      `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
       VALUES ($1, 'Aino', null, '{"intent":"long_term"}'::jsonb, '[]'::jsonb)`,
      [a.accountId],
    );
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k-break', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0)`,
      [a.accountId],
    );
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode)
       VALUES ($1, 'seeks', '["man"]'::jsonb, 'hard'), ($1, 'age_window', '{"min":25,"max":35}'::jsonb, 'hard')`,
      [a.accountId],
    );
    await ctx.client.query(
      `INSERT INTO consent (account_id, kind, version, locale_shown)
       VALUES ($1, 'terms', 'v1', 'fi'), ($1, 'privacy', 'v1', 'fi')`,
      [a.accountId],
    );
    await ctx.client.query("INSERT INTO gate (account_id, pond_id) VALUES ($1, $2)", [
      a.accountId,
      pondId,
    ]);
    const before = await holdings(ctx, a.accountId);
    expect(before).toMatchObject({ profile: 1, photo: 1, preferences: 2, consent: 2, gate: 1 });
    expect(await liveSessions(ctx, a.accountId)).toBe(2);

    expect((await pause(app, a.headers)).status).toBe(204);

    expect(await accountRow(ctx, a.accountId)).toMatchObject({
      state: "paused",
      paused_from: "active",
    });
    expect(await liveSessions(ctx, a.accountId)).toBe(0);
    expect(
      await count(
        ctx,
        "SELECT count(*) AS n FROM session WHERE account_id = $1 AND revoked_reason = 'paused'",
        [a.accountId],
      ),
    ).toBe(2);
    for (const headers of [a.headers, second.headers]) {
      for (const path of ["/auth/session", "/profile", "/account/export"]) {
        expect((await app.request(path, { headers })).status, path).toBe(401);
      }
    }
    expect(await holdings(ctx, a.accountId)).toEqual(before);
    expect(logs().find((l) => l.msg === "account paused")).toMatchObject({
      accountId: a.accountId,
      sessions: 2,
    });
  });

  test("A shadow ban survives a break without showing", async ({ ctx }) => {
    const { app, logger, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      a.accountId,
    ]);
    const res = await pause(app, a.headers);
    expect(res.status).toBe(204);
    expect(await accountRow(ctx, a.accountId)).toMatchObject({
      state: "paused",
      paused_from: "shadow_banned",
    });
    const deps = { db: ctx.client, logger, now: () => new Date() };
    expect(await resumeAccount(deps, { id: a.accountId, stateChangedAt: new Date() })).toBe(true);
    expect(await accountRow(ctx, a.accountId)).toMatchObject({
      state: "shadow_banned",
      paused_from: null,
    });
    // The answer and the log read like anybody's.
    expect(JSON.stringify(logs())).not.toMatch(/shadow|ban/i);
  });

  test("An account still in onboarding cannot take a break", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a", { state: "registered" });
    const res = await pause(app, a.headers);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_active");
    expect(await accountRow(ctx, a.accountId)).toMatchObject({
      state: "registered",
      paused_from: null,
    });
    expect(await liveSessions(ctx, a.accountId)).toBe(1);
  });

  test("Taking a break needs the confirmation and only touches the caller", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    for (const body of [{}, { confirm: false }, { confirm: "yes" }]) {
      expect((await pause(app, a.headers, body)).status).toBe(400);
    }
    expect(await accountRow(ctx, a.accountId)).toMatchObject({ state: "active" });
    expect(await liveSessions(ctx, a.accountId)).toBe(1);

    expect((await pause(app, a.headers)).status).toBe(204);
    expect(await accountRow(ctx, b.accountId)).toMatchObject({
      state: "active",
      paused_from: null,
    });
    expect(await liveSessions(ctx, b.accountId)).toBe(1);
    expect((await app.request("/auth/session", { headers: b.headers })).status).toBe(200);
  });

  test("A break and its end are noted for research without a reason", async ({ ctx }) => {
    const { app, logger } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    await ctx.client.query(
      "INSERT INTO research_subject (account_id, consent_version) VALUES ($1, 'v1')",
      [a.accountId],
    );
    expect((await pause(app, a.headers)).status).toBe(204);
    const paused = await accountRow(ctx, a.accountId);
    const since = paused?.state_changed_at as Date;
    const back = new Date(since.getTime() + 3 * DAY_MS + 3_600_000);
    expect(
      await resumeAccount(
        { db: ctx.client, logger, now: () => back },
        { id: a.accountId, stateChangedAt: since },
      ),
    ).toBe(true);
    const { rows } = await ctx.client.query<{ name: string; props: Record<string, unknown> }>(
      `SELECT e.name, e.props FROM events e
       JOIN research_subject s ON s.research_id = e.research_id
       WHERE s.account_id = $1 ORDER BY e.at`,
      [a.accountId],
    );
    expect(rows).toEqual([
      { name: "account_paused", props: {} },
      { name: "account_resumed", props: { afterDays: 3 } },
    ]);
    for (const row of rows) {
      expect(Object.values(row.props).some((v) => typeof v === "string")).toBe(false);
    }
  });

  test("a second break of a paused account answers already_paused, an erased one not_found, and a resume of a live one does nothing", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => new Date() };
    const a = await signedInAccount(ctx.client, "a");
    expect(await pauseAccount(deps, a.accountId)).toEqual({ sessions: 1 });
    await expect(pauseAccount(deps, a.accountId)).rejects.toMatchObject({
      status: 409,
      code: "already_paused",
    });
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]);
    await expect(pauseAccount(deps, a.accountId)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    const b = await signedInAccount(ctx.client, "b");
    expect(await resumeAccount(deps, { id: b.accountId, stateChangedAt: null })).toBe(false);
    expect(await accountRow(ctx, b.accountId)).toMatchObject({ state: "active" });
  });
});
