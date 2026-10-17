import { ErrorResponse } from "@kuutti/schema";
import { signedInAccount, staffSession } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { describe, expect, type TestContext, test } from "../test/harness.ts";
import { listBlocksOfAccount, recordBlock } from "./blocks.ts";

// features/safety/blocks.feature (#84, ADR-030): the route, who may be
// blocked, what a second block answers, and the database function every
// read that shows a person asks. Where a block holds is tested where it
// holds: the pool (matching/pool.test.ts), the card (profile/service.test.ts),
// the photos (media/budget.test.ts) and the gate (jobs/pond-gate.test.ts).

const UNKNOWN = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";

const block = (ctx: TestContext, headers: Record<string, string>, body: unknown) =>
  ctx.app.request("/blocks", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  ErrorResponse.parse(await response.json()).error.code;

async function identityOf(ctx: TestContext, accountId: string): Promise<string> {
  const { rows } = await ctx.client.query<{ identity_id: string }>(
    "SELECT identity_id FROM account WHERE id = $1",
    [accountId],
  );
  return rows[0]?.identity_id ?? "";
}

/** Every block row, as who blocked whom by account labels. */
async function blocksBetween(ctx: TestContext, people: Record<string, string>) {
  const byIdentity = new Map<string, string>();
  for (const [label, accountId] of Object.entries(people)) {
    byIdentity.set(await identityOf(ctx, accountId), label);
  }
  const { rows } = await ctx.client.query<{ blocker: string; blocked: string }>(
    "SELECT blocker_identity_id AS blocker, blocked_identity_id AS blocked FROM block",
  );
  return rows
    .map((row) => `${byIdentity.get(row.blocker) ?? "?"}->${byIdentity.get(row.blocked) ?? "?"}`)
    .sort();
}

async function blockedBetween(ctx: TestContext, a: string, b: string): Promise<boolean> {
  const { rows } = await ctx.client.query<{ blocked: boolean }>(
    "SELECT blocked_between($1, $2) AS blocked",
    [a, b],
  );
  return rows[0]?.blocked === true;
}

describe("a block from a card", () => {
  test("Blocking again, or blocking somebody who blocked first, answers the same", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
    await cardShown(ctx.client, b.accountId, a.accountId);

    const answers = [
      await block(ctx, a.headers, { accountId: b.accountId }),
      await block(ctx, a.headers, { accountId: b.accountId }),
      // B learns nothing from blocking A: the same answer as for anybody.
      await block(ctx, b.headers, { accountId: a.accountId }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(204);
      expect(await answer.text()).toBe("");
    }
    // One row each way: each person's own block, for their export.
    expect(await blocksBetween(ctx, { a: a.accountId, b: b.accountId })).toEqual(["a->b", "b->a"]);
    expect(await blockedBetween(ctx, a.accountId, b.accountId)).toBe(true);
    expect(await blockedBetween(ctx, b.accountId, a.accountId)).toBe(true);
    // Nothing about the other person reaches a log line: A's lines are A's request lines alone.
    const lines = ctx.logs().filter((line) => line.accountId === a.accountId);
    expect(lines.map((line) => line.msg)).toEqual(["request", "request"]);
    expect(JSON.stringify(lines)).not.toContain(b.accountId);
  });

  test("Only somebody whose card the person was shown can be blocked", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    // C was shown B's card; that lets C block B, never A.
    await cardShown(ctx.client, c.accountId, b.accountId);
    for (const [what, accountId] of [
      ["never shown", b.accountId],
      ["oneself", a.accountId],
      ["nobody", UNKNOWN],
    ] as const) {
      const answer = await block(ctx, a.headers, { accountId });
      expect(answer.status, what).toBe(404);
      expect(await errorCode(answer), what).toBe("not_found");
    }
    expect(await blocksBetween(ctx, { a: a.accountId, b: b.accountId })).toEqual([]);
    expect(await blockedBetween(ctx, a.accountId, b.accountId)).toBe(false);
    // The refusals say nothing of whom they were about.
    expect(JSON.stringify(ctx.logs())).not.toContain(b.accountId);
    expect(JSON.stringify(ctx.logs())).not.toContain(UNKNOWN);
    expect((await block(ctx, c.headers, { accountId: b.accountId })).status).toBe(204);
  });

  test("a block that stands answers the same after the other person's photos, or the other person, are gone", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
    await cardShown(ctx.client, c.accountId, b.accountId);
    expect((await block(ctx, a.headers, { accountId: b.accountId })).status).toBe(204);
    // B's photos go (a new set, or the first step of an erasure), and then B:
    // A's block, asked again every day, answers as it did.
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [b.accountId]);
    expect((await block(ctx, a.headers, { accountId: b.accountId })).status).toBe(204);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [b.accountId],
    );
    expect((await block(ctx, a.headers, { accountId: b.accountId })).status).toBe(204);
    expect(await blocksBetween(ctx, { a: a.accountId, b: b.accountId })).toEqual(["a->b"]);
    // A first block stands on the card, which went with the photos: the cost
    // ADR-030 §5 and §6 name, once and not as an answer to repeat.
    expect((await block(ctx, c.headers, { accountId: b.accountId })).status).toBe(404);
  });

  test("the person blocked blocks back alike whether the one who blocked them is still there or not", async ({
    ctx,
  }) => {
    // Two pairs, each shown the other's card; in each the first blocks the second.
    const [a, b, c, d] = [
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
    ];
    for (const [x, y] of [
      [a, b],
      [c, d],
    ] as const) {
      await cardShown(ctx.client, x.accountId, y.accountId);
      await cardShown(ctx.client, y.accountId, x.accountId);
      expect((await block(ctx, x.headers, { accountId: y.accountId })).status).toBe(204);
    }
    // A puts up a new set of photos, so B's shown records of A are gone; C is
    // erased, photos and all. B and D are left with nothing but the block.
    await ctx.client.query("DELETE FROM photo WHERE account_id = ANY($1)", [
      [a.accountId, c.accountId],
    ]);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [c.accountId],
    );
    // Each blocks back with the same 204, and the block is their own.
    expect((await block(ctx, b.headers, { accountId: a.accountId })).status).toBe(204);
    expect((await block(ctx, d.headers, { accountId: c.accountId })).status).toBe(204);
    expect(
      await blocksBetween(ctx, {
        a: a.accountId,
        b: b.accountId,
        c: c.accountId,
        d: d.accountId,
      }),
    ).toEqual(["a->b", "b->a", "c->d", "d->c"]);
  });

  test("Blocking refuses without a session", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
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
      const answer = await block(ctx, headers, { accountId: b.accountId });
      expect(answer.status, what).toBe(401);
      expect(await errorCode(answer), what).toBe(code);
    }
    expect(await blocksBetween(ctx, { a: a.accountId, b: b.accountId })).toEqual([]);
  });
});

describe("the block route's edges", () => {
  test.for([
    ["no account", {}],
    ["an account id that is not one", { accountId: "b" }],
    ["an unknown key", { accountId: UNKNOWN, reason: "other" }],
  ] as const)("refuses %s with 400 and writes nothing", async ([, body], { ctx }) => {
    const a = await signedInAccount(ctx.client);
    const answer = await block(ctx, a.headers, body);
    expect(answer.status).toBe(400);
    expect(await errorCode(answer)).toBe("validation_failed");
    expect((await ctx.client.query("SELECT 1 FROM block")).rowCount).toBe(0);
  });

  test("a request that outlived the caller's erasure writes nothing", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [a.accountId],
    );
    const set = await recordBlock(ctx.client, {
      blockerAccountId: a.accountId,
      blockedAccountId: b.accountId,
      at: new Date(),
    });
    expect(set).toBe(false);
    expect((await ctx.client.query("SELECT 1 FROM block")).rowCount).toBe(0);
  });

  test("the person's own blocks are listed by date, newest first, and nobody else's", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    const first = new Date("2026-10-20T09:00:00Z");
    const second = new Date("2026-10-21T09:00:00Z");
    for (const [viewer, subject, at] of [
      [a, b, first],
      [a, c, second],
      [c, a, second],
    ] as const) {
      await cardShown(ctx.client, viewer.accountId, subject.accountId);
      expect(
        await recordBlock(ctx.client, {
          blockerAccountId: viewer.accountId,
          blockedAccountId: subject.accountId,
          at,
        }),
      ).toBe(true);
    }
    expect(await listBlocksOfAccount(ctx.client, a.accountId, 10)).toEqual([
      { at: second },
      { at: first },
    ]);
    expect(await listBlocksOfAccount(ctx.client, a.accountId, 1)).toEqual([{ at: second }]);
    expect(await listBlocksOfAccount(ctx.client, b.accountId, 10)).toEqual([]);
  });
});

describe("blocked_between, the test every read that shows a person asks (migration 0051)", () => {
  test("holds both ways, across a later account of either identity, and for nobody else", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
    await recordBlock(ctx.client, {
      blockerAccountId: a.accountId,
      blockedAccountId: b.accountId,
      at: new Date(),
    });
    expect(await blockedBetween(ctx, a.accountId, b.accountId)).toBe(true);
    expect(await blockedBetween(ctx, b.accountId, a.accountId)).toBe(true);
    expect(await blockedBetween(ctx, a.accountId, c.accountId)).toBe(false);
    expect(await blockedBetween(ctx, c.accountId, b.accountId)).toBe(false);
    expect(await blockedBetween(ctx, a.accountId, a.accountId)).toBe(false);
    expect(await blockedBetween(ctx, a.accountId, UNKNOWN)).toBe(false);

    // Both come back with new accounts on the same identities (TD-7's cooldown passed).
    const later = async (accountId: string) => {
      await ctx.client.query(
        "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
        [accountId],
      );
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO account (identity_id, state, birth_year, birth_month)
         SELECT identity_id, 'active', 1990, 6 FROM account WHERE id = $1 RETURNING id`,
        [accountId],
      );
      return rows[0]?.id ?? "";
    };
    const a2 = await later(a.accountId);
    const b2 = await later(b.accountId);
    expect(await blockedBetween(ctx, a2, b.accountId)).toBe(true);
    expect(await blockedBetween(ctx, b2, a2)).toBe(true);
    expect(await blockedBetween(ctx, a2, c.accountId)).toBe(false);
  });

  test("is a body Postgres parsed, so what it reads cannot be dropped from under it", async ({
    ctx,
  }) => {
    // BEGIN ATOMIC: the body is parsed when the function is made, and the
    // tables it reads are its dependencies, as a view's are (a string body
    // would record none).
    const { rows } = await ctx.client.query<{ name: string }>(
      `SELECT DISTINCT refobjid::regclass::text AS name FROM pg_depend
       WHERE objid = 'blocked_between(uuid, uuid)'::regprocedure
         AND refclassid = 'pg_class'::regclass
       ORDER BY 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(["account", "block"]);
  });
});

describe("what a standing block proves, and for whom (ADR-030 §6)", () => {
  test("a block proves contact only between the accounts it was set between, never a later one", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await cardShown(ctx.client, a.accountId, b.accountId);
    expect((await block(ctx, a.headers, { accountId: b.accountId })).status).toBe(204);
    /** Erased, photos and all, and back on the same identity after the cooldown: a new account, signed in. */
    const later = async (accountId: string) => {
      await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [accountId]);
      await ctx.client.query(
        "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
        [accountId],
      );
      const again = await signedInAccount(ctx.client);
      await ctx.client.query(
        `UPDATE account SET identity_id = (SELECT identity_id FROM account WHERE id = $2),
           registered_at = now() + interval '31 days'
         WHERE id = $1`,
        [again.accountId, accountId],
      );
      return again;
    };
    const report = (headers: Record<string, string>, accountId: string) =>
      ctx.app.request("/reports", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ accountId, reason: "other" }),
      });

    // B comes back as B2, and somebody hands A the new account's id: to A it
    // is a stranger's, so neither a block nor a report learns it is B.
    const b2 = await later(b.accountId);
    expect((await block(ctx, a.headers, { accountId: b2.accountId })).status).toBe(404);
    expect((await report(a.headers, b2.accountId)).status).toBe(404);
    // Nor does B2 learn from A's id that A blocked B.
    expect((await block(ctx, b2.headers, { accountId: a.accountId })).status).toBe(404);
    // A comes back as A2: the block A set proves nothing for A2 either.
    const a2 = await later(a.accountId);
    expect((await block(ctx, a2.headers, { accountId: b.accountId })).status).toBe(404);
    expect((await block(ctx, a2.headers, { accountId: b2.accountId })).status).toBe(404);
    expect((await report(a2.headers, b.accountId)).status).toBe(404);
    // Nothing more was written, and the one block holds for every account of the two.
    expect(
      await blocksBetween(ctx, {
        a: a.accountId,
        b: b.accountId,
      }),
    ).toEqual(["a->b"]);
    expect((await ctx.client.query("SELECT 1 FROM report")).rowCount).toBe(0);
    expect(await blockedBetween(ctx, a2.accountId, b2.accountId)).toBe(true);
  });
});
