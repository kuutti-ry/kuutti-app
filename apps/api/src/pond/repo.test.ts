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

const AT = new Date("2026-10-20T09:00:00.000Z");

describe("the pond and the home of an account", () => {
  test("the ponds are listed parents first, whatever their names", async ({ ctx }) => {
    const zeta = await pondNamed(ctx.client, "test-repo-zeta");
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO ponds (slug, name_nominative, name_inessive, parent_id)
       VALUES ('test-repo-child', 'Aalto', 'Aallossa', $1) RETURNING id`,
      [zeta],
    );
    const ponds = (await listPonds(ctx.client)).map((pond) => pond.id);
    expect(ponds.indexOf(zeta)).toBeLessThan(ponds.indexOf(rows[0]?.id ?? ""));
  });

  test("an account's pond is its own, and nothing before the home set it", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    expect(await findPondOfAccount(ctx.client, a.accountId)).toBeNull();
    const home = { place: "00530", showsArea: false };
    const pondId = await writeHomeOfAccount(ctx.client, a.accountId, home, "suomi", AT);
    expect(await findPondOfAccount(ctx.client, a.accountId)).toMatchObject({
      id: pondId,
      slug: "suomi",
    });
    expect(await findPondOfAccount(ctx.client, b.accountId)).toBeNull();
    expect(await findHomeOfAccount(ctx.client, b.accountId)).toEqual({
      place: null,
      showsArea: false,
      movedAt: null,
    });
  });

  test("the write says what pond the account ends with, none where the slug names no pond", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const home = { place: "00530", showsArea: true };
    expect(await writeHomeOfAccount(ctx.client, a.accountId, home, "nowhere", AT)).toBeNull();
    expect(await writeHomeOfAccount(ctx.client, a.accountId, home, null, AT)).toBeNull();
    const pondId = await pondNamed(ctx.client, "test-repo-held");
    await ctx.client.query("UPDATE account SET pond_id = $2 WHERE id = $1", [a.accountId, pondId]);
    expect(await writeHomeOfAccount(ctx.client, a.accountId, home, "suomi", AT)).toBe(pondId);
  });

  test("a write with no place leaves the kept place, and sets what the card shows", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await writeHomeOfAccount(
      ctx.client,
      a.accountId,
      { place: "00530", showsArea: false },
      "suomi",
      AT,
    );
    await writeHomeOfAccount(
      ctx.client,
      a.accountId,
      { place: null, showsArea: true },
      "suomi",
      AT,
    );
    expect(await findHomeOfAccount(ctx.client, a.accountId)).toEqual({
      place: "00530",
      showsArea: true,
      movedAt: null,
    });
  });

  test("another place than the one held is a move, at the time given, and overwrites the last", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const write = (place: string | null, at: Date) =>
      writeHomeOfAccount(ctx.client, a.accountId, { place, showsArea: false }, "suomi", at);
    const movedAt = async () => (await findHomeOfAccount(ctx.client, a.accountId))?.movedAt;
    const LATER = new Date(AT.getTime() + 60_000);

    // The first home moves nobody, nor does the same place again, nor the choice alone.
    await write("00530", AT);
    expect(await movedAt()).toBeNull();
    await write("00530", LATER);
    expect(await movedAt()).toBeNull();
    await write(null, LATER);
    expect(await movedAt()).toBeNull();

    await write("00100", AT);
    expect(await movedAt()).toEqual(AT);
    await write("00530", LATER);
    expect(await movedAt()).toEqual(LATER);
  });

  test("the lock finds a live account's home, and nothing on a tombstone", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET home_place = '091' WHERE id = $1", [a.accountId]);
    expect(await lockHomeOfAccount(ctx.client, a.accountId)).toEqual({
      place: "091",
      showsArea: false,
      movedAt: null,
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
