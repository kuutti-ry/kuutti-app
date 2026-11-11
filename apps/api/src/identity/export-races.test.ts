import { expect, test } from "vitest";
import { signedInAccount } from "../test/account.ts";
import { withErasureRace } from "../test/erasure-race.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { recordExport } from "./repo.ts";

test.each(["COMMIT", "ROLLBACK"] as const)(
  "export accounting waits for erasure's %s and records only a live account",
  async (finish) => {
    await withErasureRace(
      finish,
      (db, accountId) =>
        recordExport(db, {
          accountId,
          at: new Date("2026-11-06T10:00:00Z"),
          since: new Date("2026-11-06T00:00:00Z"),
          limit: 1,
        }),
      async (db, accountId, result) => {
        expect(result).toEqual({
          live: finish === "ROLLBACK",
          used: 0,
          recorded: finish === "ROLLBACK",
          id: finish === "ROLLBACK" ? expect.any(String) : null,
        });
        expect(
          (await db.query("SELECT id FROM account_export WHERE account_id = $1", [accountId])).rows,
        ).toHaveLength(finish === "COMMIT" ? 0 : 1);
      },
    );
  },
);

test("two exports at once on the day's last place: the second waits for the first and is refused", async () => {
  await withTwoConnections("export-cap-race", async (pool, first, second) => {
    const { accountId } = await signedInAccount(pool);
    const input = {
      accountId,
      at: new Date("2026-11-06T10:00:00Z"),
      since: new Date("2026-11-06T00:00:00Z"),
      limit: 1,
    };
    // Asked before the second waits: a client queues its queries behind a waiting one.
    const [holder, waiter] = [await pidOf(first), await pidOf(second)];
    await first.query("BEGIN");
    await second.query("BEGIN");
    expect((await recordExport(first, input)).recorded).toBe(true);
    const later = watched(recordExport(second, input));
    expect(await waitsFor(pool, waiter, holder, later.settled)).toBe(true);
    await first.query("COMMIT");

    expect(await later.outcome).toEqual({ live: true, used: 1, recorded: false, id: null });
    await second.query("COMMIT");
    const { rows } = await pool.query("SELECT 1 FROM account_export WHERE account_id = $1", [
      accountId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
