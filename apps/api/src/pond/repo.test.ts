import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { signedInAccount } from "../test/account.ts";
import { test } from "../test/harness.ts";
import { pondNamed } from "../test/people.ts";
import {
  findHomeOfAccount,
  findPondOfAccount,
  listPonds,
  listPondsForAdmin,
  lockHomeOfAccount,
  setMatchingOpen,
  writeHomeOfAccount,
} from "./repo.ts";

// The pond slice's rows (#46, #500, #514): the pond and the home of an account,
// the write that sets them, and the switch. Each statement about a person
// carries that person's account id (rule 6).

describe("the pond and the home of an account", () => {
  test("the ponds are listed by name", async ({ ctx }) => {
    const zeta = await pondNamed(ctx.client, "test-repo-zeta");
    const alpha = await pondNamed(ctx.client, "test-repo-alpha");
    const ponds = (await listPonds(ctx.client)).map((pond) => pond.id);
    expect(ponds.indexOf(alpha)).toBeLessThan(ponds.indexOf(zeta));
  });

  test("an account's pond is its own, and nothing before the home set it", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    expect(await findPondOfAccount(ctx.client, a.accountId)).toBeNull();
    await writeHomeOfAccount(ctx.client, a.accountId, { place: "00530", showsArea: false });
    expect(await findPondOfAccount(ctx.client, a.accountId)).toEqual({
      id: expect.any(String),
      slug: "suomi",
      name: "Suomi",
    });
    expect(await findPondOfAccount(ctx.client, b.accountId)).toBeNull();
    expect(await findHomeOfAccount(ctx.client, b.accountId)).toEqual({
      place: null,
      showsArea: false,
    });
  });

  test("the write leaves a pond already held", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const pondId = await pondNamed(ctx.client, "test-repo-held");
    await ctx.client.query("UPDATE account SET pond_id = $2 WHERE id = $1", [a.accountId, pondId]);
    await writeHomeOfAccount(ctx.client, a.accountId, { place: "00530", showsArea: true });
    expect(await findPondOfAccount(ctx.client, a.accountId)).toMatchObject({ id: pondId });
  });

  test("a write with no place leaves the kept place, and sets what the card shows", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await writeHomeOfAccount(ctx.client, a.accountId, { place: "00530", showsArea: false });
    await writeHomeOfAccount(ctx.client, a.accountId, { place: null, showsArea: true });
    expect(await findHomeOfAccount(ctx.client, a.accountId)).toEqual({
      place: "00530",
      showsArea: true,
    });
  });

  test("the lock finds a live account's home, and nothing on a tombstone", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET home_place = '091' WHERE id = $1", [a.accountId]);
    expect(await lockHomeOfAccount(ctx.client, a.accountId)).toEqual({
      place: "091",
      showsArea: false,
    });
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [a.accountId],
    );
    expect(await lockHomeOfAccount(ctx.client, a.accountId)).toBeNull();
    expect(await findHomeOfAccount(ctx.client, "00000000-0000-4000-8000-000000000009")).toBeNull();
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
