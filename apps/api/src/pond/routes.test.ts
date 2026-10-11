import { PondList } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";

// features/pond/choice.feature (#46). Ponds are inserted inside the test's
// transaction: the test database is migrated, not seeded.

async function appWith(ctx: TestContext) {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db: ctx.client });
}

const NAMES: Record<string, [string, string]> = {
  "test-otaniemi": ["Otaniemi", "Otaniemessä"],
  "test-espoo": ["Espoo", "Espoossa"],
  // Sorts before its parent by name: the order must come from the tree, not the alphabet.
  "test-aalto": ["Aalto", "Aallossa"],
};

async function pond(ctx: TestContext, slug: string, parentId: string | null = null) {
  const [nominative, inessive] = NAMES[slug] ?? [slug, slug];
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO ponds (slug, name_nominative, name_inessive, parent_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [slug, nominative, inessive, parentId],
  );
  return rows[0]?.id ?? "";
}

describe("pond choice", () => {
  test("The pond list carries both case forms", async ({ ctx }) => {
    const app = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const espoo = await pond(ctx, "test-espoo");
    const otaniemi = await pond(ctx, "test-otaniemi", espoo);
    const aalto = await pond(ctx, "test-aalto", otaniemi);
    const response = await app.request("/ponds", { headers: a.headers });
    expect(response.status).toBe(200);
    const { ponds } = PondList.parse(await response.json());
    const found = ponds.find((p) => p.id === otaniemi);
    expect(found).toEqual({
      id: otaniemi,
      slug: "test-otaniemi",
      name: "Otaniemi",
      nameInessive: "Otaniemessä",
      parentId: espoo,
    });
    // Tree order: each parent right before its descendants, whatever the names.
    const at = (id: string) => ponds.findIndex((p) => p.id === id);
    expect(at(espoo)).toBeLessThan(at(otaniemi));
    expect(at(otaniemi)).toBeLessThan(at(aalto));
  });

  test("A pond is chosen from the list and an unknown id is refused", async ({ ctx }) => {
    const app = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const otaniemi = await pond(ctx, "test-otaniemi");
    const choose = (pondId: string) =>
      app.request("/account/pond", {
        method: "PUT",
        headers: { ...a.headers, "content-type": "application/json" },
        body: JSON.stringify({ pondId }),
      });
    expect((await choose(otaniemi)).status).toBe(204);
    const { rows } = await ctx.client.query<{ pond_id: string }>(
      "SELECT pond_id FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(rows[0]?.pond_id).toBe(otaniemi);
    const refused = await choose("00000000-0000-4000-8000-000000000009");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("pond_unknown");
    const after = await ctx.client.query<{ pond_id: string }>(
      "SELECT pond_id FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(after.rows[0]?.pond_id).toBe(otaniemi);
  });

  test("wrong user: a pond choice moves the caller only", async ({ ctx }) => {
    const app = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const otaniemi = await pond(ctx, "test-otaniemi");
    const espoo = await pond(ctx, "test-espoo");
    const choose = (headers: Record<string, string>, pondId: string) =>
      app.request("/account/pond", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ pondId }),
      });
    const ponds = async () => {
      const { rows } = await ctx.client.query<{ id: string; pond_id: string | null }>(
        "SELECT id, pond_id FROM account WHERE id = ANY($1::uuid[])",
        [[a.accountId, b.accountId]],
      );
      return Object.fromEntries(rows.map((r) => [r.id, r.pond_id]));
    };
    expect((await choose(a.headers, otaniemi)).status).toBe(204);
    expect(await ponds()).toEqual({ [a.accountId]: otaniemi, [b.accountId]: null });
    expect((await choose(b.headers, espoo)).status).toBe(204);
    expect(await ponds()).toEqual({ [a.accountId]: otaniemi, [b.accountId]: espoo });
  });

  test("unauthenticated: 401 on the pond routes", async ({ ctx }) => {
    const app = await appWith(ctx);
    expect((await app.request("/ponds")).status).toBe(401);
    expect((await app.request("/account/pond", { method: "PUT" })).status).toBe(401);
  });
});
