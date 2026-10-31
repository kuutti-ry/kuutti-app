import { randomUUID } from "node:crypto";
import { AdminPond, AdminPondList } from "@kuutti/schema";
import { createApp } from "../app.ts";
import { signedInAccount, staffSession } from "../test/account.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { pondNamed } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { setMatchingOpen } from "./repo.ts";

// The switch of a pond in the panel (#500, ADR-060 §1, §2,
// features/pond/opening.feature): who may list and turn it, what the audit log
// holds of it, and every refusal. What the switch does to a person's matching
// is jobs/pool.test.ts.

type Headers = Record<string, string>;

const press = (ctx: TestContext, headers: Headers, pondId: string, body: unknown) =>
  ctx.app.request(`/admin/ponds/${pondId}/matching`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

const openIn = async (ctx: TestContext, pondId: string) =>
  (
    await ctx.client.query<{ matching_open: boolean }>(
      "SELECT matching_open FROM ponds WHERE id = $1",
      [pondId],
    )
  ).rows[0]?.matching_open;

const auditRows = async (ctx: TestContext, pondId: string) =>
  (
    await ctx.client.query(
      `SELECT actor_identity_id, action, subject_type, subject_id, detail
         FROM audit_log WHERE subject_id = $1 ORDER BY detail->>'open' DESC`,
      [pondId],
    )
  ).rows;

describe("two presses at once", () => {
  test("the second waits for the first, finds the switch as it asks and writes nothing", async () => {
    await withTwoConnections("kuutti-500-press", async (pool, first, second) => {
      const pond = await pondNamed(pool, "test-admin-race");
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      expect(await setMatchingOpen(first, pond, true)).toMatchObject({ changed: true });
      const racing = watched(setMatchingOpen(second, pond, true));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toMatchObject({
        pond: { matchingOpen: true },
        changed: false,
      });
      await second.query("COMMIT");
    });
  });
});

describe("the ponds in the panel", () => {
  test("an admin reads every pond with its switch", async ({ ctx }) => {
    const pondId = await pondNamed(ctx.client, "test-admin-list");
    const admin = await staffSession(ctx.client, "admin");
    const response = await ctx.app.request("/admin/ponds", { headers: admin.headers });
    expect(response.status).toBe(200);
    const { items } = AdminPondList.parse(await response.json());
    expect(items.find((pond) => pond.id === pondId)).toMatchObject({
      slug: "test-admin-list",
      name: "Pond test-admin-list",
      matchingOpen: false,
    });
  });

  test("The switch is written to the audit log once, with no words", async ({ ctx }) => {
    const pondId = await pondNamed(ctx.client, "test-admin-audit");
    const admin = await staffSession(ctx.client, "admin");

    const opened = await press(ctx, admin.headers, pondId, { open: true });
    expect(opened.status).toBe(200);
    expect(AdminPond.parse(await opened.json())).toMatchObject({ id: pondId, matchingOpen: true });
    expect(await openIn(ctx, pondId)).toBe(true);

    // A second press finds the switch as it asks: nothing changes, nothing is written.
    const again = await press(ctx, admin.headers, pondId, { open: true });
    expect(again.status).toBe(200);
    expect(AdminPond.parse(await again.json()).matchingOpen).toBe(true);
    const row = {
      actor_identity_id: admin.identityId,
      action: "pond.matching",
      subject_type: "pond",
      subject_id: pondId,
    };
    expect(await auditRows(ctx, pondId)).toEqual([{ ...row, detail: { open: true } }]);

    expect((await press(ctx, admin.headers, pondId, { open: false })).status).toBe(200);
    expect(await openIn(ctx, pondId)).toBe(false);
    expect(await auditRows(ctx, pondId)).toEqual([
      { ...row, detail: { open: true } },
      { ...row, detail: { open: false } },
    ]);
  });

  test("the log line says which pond and which way, and who, and only for a press that changed it", async ({
    ctx,
  }) => {
    const pondId = await pondNamed(ctx.client, "test-admin-log");
    const admin = await staffSession(ctx.client, "admin");
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    const send = (open: boolean) =>
      app.request(`/admin/ponds/${pondId}/matching`, {
        method: "POST",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ open }),
      });
    expect((await send(true)).status).toBe(200);
    expect((await send(true)).status).toBe(200);
    const said = lines().filter((line) => line.msg === "pond matching");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ pondId, open: true, staffIdentityId: admin.identityId });
  });

  test("Only an admin turns the switch", async ({ ctx }) => {
    const pondId = await pondNamed(ctx.client, "test-admin-only");
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);

    const list = await ctx.app.request("/admin/ponds", { headers: moderator.headers });
    expect(list.status).toBe(403);
    expect(await errorCode(list)).toBe("admin_forbidden");
    const turned = await press(ctx, moderator.headers, pondId, { open: true });
    expect(turned.status).toBe(403);
    expect(await errorCode(turned)).toBe("admin_forbidden");

    for (const headers of [{}, person.headers]) {
      expect((await ctx.app.request("/admin/ponds", { headers })).status).toBe(401);
      expect((await press(ctx, headers, pondId, { open: true })).status).toBe(401);
    }
    expect(await openIn(ctx, pondId)).toBe(false);
    expect(await auditRows(ctx, pondId)).toEqual([]);
  });

  test.for([
    ["no body", undefined],
    ["no switch", {}],
    ["a switch that is no boolean", { open: "true" }],
    ["a reason, which the audit row has no room for", { open: true, reason: "ready" }],
  ] as const)("refuses %s", async ([_, body], { ctx }) => {
    const pondId = await pondNamed(ctx.client, "test-admin-body");
    const admin = await staffSession(ctx.client, "admin");
    expect((await press(ctx, admin.headers, pondId, body)).status).toBe(400);
    expect(await openIn(ctx, pondId)).toBe(false);
  });

  test("an id that is no uuid is refused, and a pond that does not exist is not found", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    expect((await press(ctx, admin.headers, "suomi", { open: true })).status).toBe(400);
    const nobody = randomUUID();
    const missing = await press(ctx, admin.headers, nobody, { open: true });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not_found");
    expect(await auditRows(ctx, nobody)).toEqual([]);
  });
});
