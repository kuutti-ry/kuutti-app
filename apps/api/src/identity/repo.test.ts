import { describe, expect } from "vitest";
import { type TestContext, test } from "../test/harness.ts";
import { insertAccount } from "./repo.ts";

// insertAccount refuses an identity inside its cooldown on its own, at the
// boundary decideRegistration uses (refused while now < reregister_after):
// the statement is the last word when an erasure committed after the login
// read the identity (#609, run 1, record 1; the race is in races.test.ts).

const NOW = new Date("2026-10-01T12:00:00Z");
const BIRTH = { birthYear: 1985, birthMonth: 3 };

async function identityWith(ctx: TestContext, reregisterAfter: Date | null): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac, reregister_after) VALUES ($1, $2) RETURNING id",
    ["b".repeat(64), reregisterAfter],
  );
  return rows[0]?.id ?? "";
}

async function accountsOf(ctx: TestContext, identityId: string): Promise<number> {
  const { rows } = await ctx.client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM account WHERE identity_id = $1",
    [identityId],
  );
  return rows[0]?.n ?? -1;
}

describe("insertAccount and the identity's cooldown", () => {
  test("an identity inside its cooldown gets no account, whatever the decision held", async ({
    ctx,
  }) => {
    const identityId = await identityWith(ctx, new Date(NOW.getTime() + 1));
    expect(await insertAccount(ctx.client, { identityId, ...BIRTH, now: NOW })).toBeNull();
    expect(await accountsOf(ctx, identityId)).toBe(0);
  });

  test("an identity whose cooldown ends at this instant gets its account", async ({ ctx }) => {
    const identityId = await identityWith(ctx, NOW);
    const account = await insertAccount(ctx.client, { identityId, ...BIRTH, now: NOW });
    expect(account).toMatchObject({
      identityId,
      state: "registered",
      birthYear: 1985,
      birthMonth: 3,
    });
    expect(await accountsOf(ctx, identityId)).toBe(1);
  });

  test("an identity without a cooldown gets its account", async ({ ctx }) => {
    const identityId = await identityWith(ctx, null);
    expect(await insertAccount(ctx.client, { identityId, ...BIRTH, now: NOW })).toMatchObject({
      identityId,
    });
  });

  test("an identity with a live account gets no second one", async ({ ctx }) => {
    const identityId = await identityWith(ctx, null);
    expect(await insertAccount(ctx.client, { identityId, ...BIRTH, now: NOW })).not.toBeNull();
    expect(await insertAccount(ctx.client, { identityId, ...BIRTH, now: NOW })).toBeNull();
    expect(await accountsOf(ctx, identityId)).toBe(1);
  });

  test("an identity that does not exist gets no account", async ({ ctx }) => {
    const identityId = "00000000-0000-4000-8000-00000000dead";
    expect(await insertAccount(ctx.client, { identityId, ...BIRTH, now: NOW })).toBeNull();
    expect(await accountsOf(ctx, identityId)).toBe(0);
  });
});
