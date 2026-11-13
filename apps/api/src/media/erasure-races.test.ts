import { describe, expect, test } from "vitest";
import { eraseAccount } from "../identity/index.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger } from "../test/harness.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { findPhotoForStaff, insertPhoto } from "./repo.ts";

const NOW = new Date("2026-11-06T10:00:00Z");
const photoInput = (accountId: string) => ({
  accountId,
  key: "a".repeat(64),
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 1,
  height: 1,
  maxPhotos: 6,
});

describe("profile-photo insertion racing account erasure", () => {
  // TD-7: use the real eraser on committed dummy rows. Watching PostgreSQL's
  // lock wait fixes the interleaving without sleeps or a mocked database.
  test.each(["COMMIT", "ROLLBACK"] as const)(
    "an insert waits for an erasure's %s and respects the resulting account state",
    async (finish) => {
      await withTwoConnections("photo-erasure-first", async (pool, erasing, uploading) => {
        const account = await signedInAccount(pool, "photo-erasure-first");
        const { logger } = await captureLogger();
        const erasingPid = await pidOf(erasing);
        const uploadingPid = await pidOf(uploading);
        await uploading.query("SET statement_timeout = '5s'");
        await erasing.query("BEGIN");
        await uploading.query("BEGIN");
        try {
          await eraseAccount({ db: erasing, logger, now: () => NOW }, account.accountId);
          const insert = watched(insertPhoto(uploading, photoInput(account.accountId)));
          expect(await waitsFor(pool, uploadingPid, erasingPid, insert.settled)).toBe(true);
          await erasing.query(finish);
          const result = await insert.outcome;
          await uploading.query("COMMIT");
          const { rows } = await pool.query("SELECT id FROM photo WHERE account_id = $1", [
            account.accountId,
          ]);
          if (finish === "COMMIT") {
            expect(result).toBeNull();
            expect(rows).toEqual([]);
          } else {
            expect(result).toMatchObject({ key: photoInput(account.accountId).key, position: 0 });
            expect(typeof result).not.toBe("string");
            if (!result || typeof result === "string") throw new Error("photo not inserted");
            expect(rows).toEqual([{ id: result.id }]);
            expect(await findPhotoForStaff(pool, result.id)).toMatchObject({ id: result.id });
          }
          const state = await pool.query("SELECT state FROM account WHERE id = $1", [
            account.accountId,
          ]);
          expect(state.rows[0]?.state).toBe(finish === "COMMIT" ? "deleted" : "active");
        } finally {
          await erasing.query("ROLLBACK");
          await uploading.query("ROLLBACK");
        }
      });
    },
  );

  test("erasure waits for an earlier insert and then removes its photo", async () => {
    await withTwoConnections("photo-insert-first", async (pool, uploading, erasing) => {
      const account = await signedInAccount(pool, "photo-insert-first");
      const { logger } = await captureLogger();
      const uploadingPid = await pidOf(uploading);
      const erasingPid = await pidOf(erasing);
      await erasing.query("BEGIN");
      await erasing.query("SET LOCAL statement_timeout = '5s'");
      await uploading.query("BEGIN");
      try {
        const photo = await insertPhoto(uploading, photoInput(account.accountId));
        if (!photo) throw new Error("photo not inserted");
        const erasure = watched(
          eraseAccount({ db: erasing, logger, now: () => NOW }, account.accountId),
        );
        expect(await waitsFor(pool, erasingPid, uploadingPid, erasure.settled)).toBe(true);
        await uploading.query("COMMIT");
        expect(await erasure.outcome).toMatchObject({ photos: 1 });
        await erasing.query("COMMIT");
        expect(await findPhotoForStaff(pool, photo.id)).toBeNull();
        expect(
          (await pool.query("SELECT id FROM photo WHERE account_id = $1", [account.accountId]))
            .rows,
        ).toEqual([]);
      } finally {
        await uploading.query("ROLLBACK");
        await erasing.query("ROLLBACK");
      }
    });
  });
});

describe("profile-photo insertion racing the cap", () => {
  test.each(["COMMIT", "ROLLBACK"] as const)(
    "the last place waits for an earlier upload's %s and counts its committed result",
    async (finish) => {
      await withTwoConnections("photo-cap", async (pool, first, second) => {
        const account = await signedInAccount(pool, "photo-cap");
        const input = { ...photoInput(account.accountId), maxPhotos: 2 };
        expect(await insertPhoto(pool, input)).toMatchObject({ position: 0 });
        const firstPid = await pidOf(first);
        const secondPid = await pidOf(second);
        await first.query("BEGIN");
        await second.query("BEGIN");
        await second.query("SET LOCAL statement_timeout = '5s'");
        try {
          expect(await insertPhoto(first, input)).toMatchObject({ position: 1 });
          const later = watched(insertPhoto(second, input));
          expect(await waitsFor(pool, secondPid, firstPid, later.settled)).toBe(true);
          await first.query(finish);
          expect(await later.outcome).toEqual(
            finish === "COMMIT" ? null : expect.objectContaining({ position: 1 }),
          );
          await second.query("COMMIT");
          expect(
            (
              await pool.query(
                "SELECT position FROM photo WHERE account_id = $1 ORDER BY position",
                [account.accountId],
              )
            ).rows,
          ).toEqual([{ position: 0 }, { position: 1 }]);
        } finally {
          await first.query("ROLLBACK");
          await second.query("ROLLBACK");
        }
      });
    },
  );
});
