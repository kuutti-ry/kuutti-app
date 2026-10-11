import { describe, expect } from "vitest";
import { signedInAccount } from "../test/account.ts";
import { type TestContext, test } from "../test/harness.ts";
import { pondNamed } from "../test/people.ts";
import { admissionAnew, deleteGateOfAccount, exportGate, readGateRow } from "./gate.ts";
import { findPondBySlug, findPondOfAccount, setPondOfAccount } from "./repo.ts";

// The pond slice's rows (#46, #94): the ponds by slug and by account, the
// choice and what it answers, and the row of a person's place at the gate
// as it is read, decided anew, exported and erased. Each statement about a
// person carries that person's account id (rule 6).

async function childPond(ctx: TestContext, slug: string, parentId: string) {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO ponds (slug, name_nominative, name_inessive, parent_id)
     VALUES ($1, 'Otaniemi', 'Otaniemessä', $2) RETURNING id`,
    [slug, parentId],
  );
  return rows[0]?.id ?? "";
}

async function gateRow(
  ctx: TestContext,
  accountId: string,
  pondId: string,
  row: { admitted?: boolean; place?: number | null; opened?: boolean; counted?: boolean },
) {
  await ctx.client.query(
    `INSERT INTO gate (account_id, pond_id, admitted_at, place_said, pool_said, opened_at, counted_at)
     VALUES ($1, $2, $3, $4, 20, $5, $6)`,
    [
      accountId,
      pondId,
      row.admitted ? new Date("2026-10-01T03:00:00Z") : null,
      row.place ?? null,
      row.opened ? new Date("2026-10-02T03:00:00Z") : null,
      row.counted === false ? null : new Date("2026-10-03T03:00:00Z"),
    ],
  );
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

describe("the place at the gate, as a row", () => {
  test("before the first count there is no row, and the export says so", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    expect(await readGateRow(ctx.client, a.accountId)).toBeNull();
    expect(await exportGate(ctx.client, a.accountId)).toBeNull();
  });

  test("a row is read and exported as held: times as instants, and nulls as nulls", async ({
    ctx,
  }) => {
    const pondId = await pondNamed(ctx.client, "test-repo-gate");
    const opened = await signedInAccount(ctx.client);
    const waiting = await signedInAccount(ctx.client);
    await gateRow(ctx, opened.accountId, pondId, { admitted: true, opened: true });
    await gateRow(ctx, waiting.accountId, pondId, { place: 10, counted: false });
    expect(await exportGate(ctx.client, opened.accountId)).toEqual({
      pondId,
      admittedAt: "2026-10-01T03:00:00.000Z",
      placeSaid: null,
      poolSaid: 20,
      openedAt: "2026-10-02T03:00:00.000Z",
      countedAt: "2026-10-03T03:00:00.000Z",
    });
    expect(await exportGate(ctx.client, waiting.accountId)).toEqual({
      pondId,
      admittedAt: null,
      placeSaid: 10,
      poolSaid: 20,
      openedAt: null,
      countedAt: null,
    });
    expect(await readGateRow(ctx.client, waiting.accountId)).toEqual({
      pondId,
      admittedAt: null,
      placeSaid: 10,
      poolSaid: 20,
      openedAt: null,
      countedAt: null,
    });
  });

  test("joining a contest empties the person's own row; leaving one, or having no row, changes nothing", async ({
    ctx,
  }) => {
    const pondId = await pondNamed(ctx.client, "test-repo-anew");
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    const nobody = await signedInAccount(ctx.client);
    await gateRow(ctx, me.accountId, pondId, { admitted: true, opened: true });
    await gateRow(ctx, other.accountId, pondId, { admitted: true, opened: true });
    const man = (seeks: string[]) => ({ gender: "man", seeks });

    expect(await admissionAnew(ctx.client, me.accountId, man(["woman"]), man([]))).toBe(false);
    expect(await readGateRow(ctx.client, me.accountId)).toMatchObject({
      openedAt: expect.any(Date),
    });

    expect(
      await admissionAnew(ctx.client, me.accountId, man(["woman"]), man(["woman", "non_binary"])),
    ).toBe(true);
    expect(await readGateRow(ctx.client, me.accountId)).toEqual({
      pondId,
      admittedAt: null,
      placeSaid: null,
      poolSaid: 20,
      openedAt: null,
      countedAt: null,
    });
    expect(await readGateRow(ctx.client, other.accountId)).toMatchObject({
      admittedAt: expect.any(Date),
      openedAt: expect.any(Date),
    });
    expect(await admissionAnew(ctx.client, nobody.accountId, man([]), man(["woman"]))).toBe(false);
  });

  test("erasure takes the person's row and nobody else's", async ({ ctx }) => {
    const pondId = await pondNamed(ctx.client, "test-repo-erase");
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    await gateRow(ctx, me.accountId, pondId, { place: 20 });
    await gateRow(ctx, other.accountId, pondId, { place: 10 });
    expect(await deleteGateOfAccount(ctx.client, me.accountId)).toBe(1);
    expect(await deleteGateOfAccount(ctx.client, me.accountId)).toBe(0);
    expect(await readGateRow(ctx.client, me.accountId)).toBeNull();
    expect(await readGateRow(ctx.client, other.accountId)).not.toBeNull();
  });
});
