import { expect, test } from "vitest";
import { withErasureRace } from "../test/erasure-race.ts";
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
