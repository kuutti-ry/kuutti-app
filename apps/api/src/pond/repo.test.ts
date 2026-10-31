import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { signedInAccount } from "../test/account.ts";
import { type TestContext, test } from "../test/harness.ts";
import { pondNamed } from "../test/people.ts";
import {
  findPondBySlug,
  findPondOfAccount,
  listPondsForAdmin,
  setMatchingOpen,
  setPondOfAccount,
} from "./repo.ts";

// The pond slice's rows (#46, #500): the ponds by slug and by account, the
// choice and what it answers, and the switch. Each statement about a person
// carries that person's account id (rule 6).

async function childPond(ctx: TestContext, slug: string, parentId: string) {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO ponds (slug, name_nominative, name_inessive, parent_id)
     VALUES ($1, 'Otaniemi', 'Otaniemessä', $2) RETURNING id`,
    [slug, parentId],
  );
  return rows[0]?.id ?? "";
}

describe("ponds by slug and by account", () => {
  test("a pond is found by its slug with its parent, and an unknown slug finds nothing", async ({
    ctx,
  }) => {
    const parent = await pondNamed(ctx.client, "test-repo-espoo");
    const child = await childPond(ctx, "test-repo-otaniemi", parent);
    expect(await findPondBySlug(ctx.client, "test-repo-otaniemi")).toEqual({
      id: child,
      slug: "test-repo-otaniemi",
      name: "Otaniemi",
      nameInessive: "Otaniemessä",
      parentId: parent,
    });
    expect(await findPondBySlug(ctx.client, "test-repo-espoo")).toMatchObject({
      id: parent,
      parentId: null,
    });
    expect(await findPondBySlug(ctx.client, "test-repo-nowhere")).toBeNull();
  });

  test("the pond of an account is its own choice, and nothing before it chose", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const pondId = await pondNamed(ctx.client, "test-repo-own");
    expect(await findPondOfAccount(ctx.client, a.accountId)).toBeNull();
    expect(await setPondOfAccount(ctx.client, a.accountId, pondId)).toBe("set");
    expect(await findPondOfAccount(ctx.client, a.accountId)).toMatchObject({
      id: pondId,
      slug: "test-repo-own",
    });
    expect(await findPondOfAccount(ctx.client, b.accountId)).toBeNull();
  });

  test("the choice says whether the pond or the account was missing", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const pondId = await pondNamed(ctx.client, "test-repo-choice");
    expect(
      await setPondOfAccount(ctx.client, a.accountId, "00000000-0000-4000-8000-000000000009"),
    ).toBe("no_pond");
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [a.accountId],
    );
    expect(await setPondOfAccount(ctx.client, a.accountId, pondId)).toBe("no_account");
    const { rows } = await ctx.client.query("SELECT pond_id FROM account WHERE id = $1", [
      a.accountId,
    ]);
    expect(rows[0]?.pond_id).toBeNull();
  });
});

describe("the switch of a pond, as a row (#500, ADR-060 §2)", () => {
  test("every pond is listed with its switch, closed until it is turned", async ({ ctx }) => {
    const pondId = await pondNamed(ctx.client, "test-repo-switch");
    const listed = (await listPondsForAdmin(ctx.client)).find((pond) => pond.id === pondId);
    expect(listed).toMatchObject({ slug: "test-repo-switch", matchingOpen: false });
  });

  test("a press changes the switch once, says so, and says when there is no such pond", async ({
    ctx,
  }) => {
    const pondId = await pondNamed(ctx.client, "test-repo-press");
    const other = await pondNamed(ctx.client, "test-repo-other");
    expect(await setMatchingOpen(ctx.client, pondId, false)).toMatchObject({
      pond: { id: pondId, matchingOpen: false },
      changed: false,
    });
    expect(await setMatchingOpen(ctx.client, pondId, true)).toMatchObject({
      pond: { id: pondId, slug: "test-repo-press", matchingOpen: true },
      changed: true,
    });
    expect(await setMatchingOpen(ctx.client, pondId, true)).toMatchObject({ changed: false });
    expect(await setMatchingOpen(ctx.client, pondId, false)).toMatchObject({
      pond: { matchingOpen: false },
      changed: true,
    });
    expect(await setMatchingOpen(ctx.client, randomUUID(), true)).toBeNull();
    const { rows } = await ctx.client.query("SELECT matching_open FROM ponds WHERE id = $1", [
      other,
    ]);
    expect(rows).toEqual([{ matching_open: false }]);
  });
});
