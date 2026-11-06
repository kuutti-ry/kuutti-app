import { expect, test } from "vitest";
import { withErasureRace } from "../test/erasure-race.ts";
import { listUnhandledFeedback, recordFeedback } from "./feedback.ts";

test.each(["COMMIT", "ROLLBACK"] as const)(
  "feedback waits for erasure's %s and keeps text only for a live account",
  async (finish) => {
    await withErasureRace(
      finish,
      (db, accountId) =>
        recordFeedback(db, {
          accountId,
          kind: "bug",
          text: "Dummy feedback for the erasure regression",
          appVersion: "0.0.0-test",
          platform: "ios",
          locale: "en",
          at: new Date("2026-11-06T10:00:00Z"),
          since: new Date("2026-11-06T00:00:00Z"),
          limit: 1,
        }),
      async (db, accountId, result) => {
        const queue = await listUnhandledFeedback(db, 10);
        if (finish === "COMMIT") {
          expect(result).toEqual({ live: false, used: 0, id: null });
          expect(queue).toEqual({ items: [], total: 0 });
        } else {
          expect(result).toMatchObject({ live: true, used: 0, id: expect.any(String) });
          expect(queue.items).toEqual([
            expect.objectContaining({
              accountId,
              text: "Dummy feedback for the erasure regression",
            }),
          ]);
          expect(queue.total).toBe(1);
        }
        expect(
          (await db.query("SELECT id FROM feedback WHERE account_id = $1", [accountId])).rows,
        ).toHaveLength(finish === "COMMIT" ? 0 : 1);
      },
    );
  },
);
