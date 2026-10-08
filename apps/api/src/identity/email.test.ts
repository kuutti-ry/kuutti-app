import { AccountExport } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";

// features/identity/erasure.feature (#148, TD-18): the optional e-mail, a way
// back in and nothing else. Real Postgres in a rolled-back transaction.

async function appWith(ctx: TestContext) {
  const { logger, lines } = await captureLogger();
  return { app: createApp({ config: testConfig(), logger, db: ctx.client }), logs: lines };
}
type App = Awaited<ReturnType<typeof appWith>>["app"];
type Headers = Record<string, string>;

const ADDRESS = "aino.probe@example.fi";
const putEmail = (app: App, headers: Headers, body: unknown) =>
  app.request("/account/email", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const readEmail = async (app: App, headers: Headers) =>
  (await (await app.request("/account/email", { headers })).json()) as { email: string | null };

describe("the optional e-mail", () => {
  test("The optional e-mail is set, cleared, exported and erased, and reaches no log line", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    expect(await readEmail(app, a.headers)).toEqual({ email: null });
    expect((await putEmail(app, a.headers, { email: ADDRESS })).status).toBe(204);
    expect(await readEmail(app, a.headers)).toEqual({ email: ADDRESS });
    // The person's own download carries it; nothing else does.
    const exported = AccountExport.parse(
      await (await app.request("/account/export", { headers: a.headers })).json(),
    );
    expect(exported.account.email).toBe(ADDRESS);
    // Validated as an address and nothing else.
    for (const body of [{ email: "aino" }, { email: "" }, { email: "a@b", extra: 1 }, {}]) {
      expect((await putEmail(app, a.headers, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await readEmail(app, a.headers)).toEqual({ email: ADDRESS });
    expect(
      (await app.request("/account/email", { method: "DELETE", headers: a.headers })).status,
    ).toBe(204);
    expect(await readEmail(app, a.headers)).toEqual({ email: null });
    // Erasure takes it with the rest of what is personal.
    expect((await putEmail(app, a.headers, { email: ADDRESS })).status).toBe(204);
    const deleted = await app.request("/account/delete", {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(deleted.status).toBe(204);
    const { rows } = await ctx.client.query<{ email: string | null }>(
      "SELECT email FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(rows[0]?.email).toBeNull();
    // Never in a log line (rules/api.md): the set, the read, the export, the refusals, the erasure.
    expect(JSON.stringify(logs())).not.toContain("probe@");
    expect(logs().filter((l) => l.msg === "email set")).toHaveLength(2);
    expect(logs().filter((l) => l.msg === "email cleared")).toHaveLength(1);
  });

  test("unauthenticated and wrong-user: the e-mail routes need a session and answer the caller only", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect((await app.request("/account/email", { method })).status).toBe(401);
    }
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    expect((await putEmail(app, a.headers, { email: ADDRESS })).status).toBe(204);
    expect(await readEmail(app, b.headers)).toEqual({ email: null });
    expect(
      (await app.request("/account/email", { method: "DELETE", headers: b.headers })).status,
    ).toBe(204);
    expect(await readEmail(app, a.headers)).toEqual({ email: ADDRESS });
  });
});
