import { describe, expect, test } from "vitest";
import { withErasureRace } from "../test/erasure-race.ts";
import { captureLogger } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { issueMessagePhotoUrls } from "./photos.ts";
import { insertPhotoAccess, logMessagePhotoAccess, logPhotoAccess } from "./repo.ts";

const AT = new Date("2026-11-06T10:00:00Z");
// The log deliberately has no photo FK: it also records files already removed.
const PHOTO = "00000000-0000-4000-8000-000000000001";

describe.each(["COMMIT", "ROLLBACK"] as const)("photo access during erasure's %s", (finish) => {
  test("the budgeted fetch refuses an erased viewer without retaining a log row", async () => {
    await withErasureRace(
      finish,
      (db, accountId) =>
        insertPhotoAccess(db, {
          accountId,
          photoId: PHOTO,
          variant: "thumb",
          at: AT,
          since: AT,
          limit: 5,
        }),
      async (db, accountId, result) => {
        expect(result).toEqual({
          live: finish === "ROLLBACK",
          used: 0,
          recorded: finish === "ROLLBACK",
          blocked: false,
        });
        expect(
          (await db.query("SELECT id FROM photo_access WHERE account_id = $1", [accountId])).rows,
        ).toHaveLength(finish === "COMMIT" ? 0 : 1);
      },
    );
  });

  test("an export fetch writes a log row only if the viewer remains live", async () => {
    await withErasureRace(
      finish,
      (db, accountId) =>
        logPhotoAccess(db, {
          accountId,
          photoId: PHOTO,
          variant: "full",
          at: AT,
        }),
      async (db, accountId, result) => {
        expect(result).toBeUndefined();
        expect(
          (await db.query("SELECT id FROM photo_access WHERE account_id = $1", [accountId])).rows,
        ).toHaveLength(finish === "COMMIT" ? 0 : 1);
      },
    );
  });

  test.each([false, true])(
    "message URLs require a live viewer even when already logged: %s",
    async (alreadyLogged) => {
      const { logger } = await captureLogger();
      const media = testMediaDeps();
      await withErasureRace(
        finish,
        (db, accountId) =>
          issueMessagePhotoUrls(
            { ...media.deps, db, logger, now: () => AT },
            { viewerAccountId: accountId, photos: [{ id: PHOTO, key: "a".repeat(64) }] },
          ),
        async (db, accountId, result) => {
          if (finish === "COMMIT") {
            expect(result).toBeNull();
          } else {
            expect(result).toBeInstanceOf(Map);
            if (!(result instanceof Map)) throw new Error("message URLs not returned");
            expect(result.get(PHOTO)).toMatchObject({
              thumb: expect.any(String),
              full: expect.any(String),
              expiresAt: expect.any(String),
            });
          }
          const { rows } = await db.query(
            "SELECT variant FROM photo_access WHERE account_id = $1 ORDER BY variant::text",
            [accountId],
          );
          expect(rows).toEqual(
            finish === "COMMIT" ? [] : [{ variant: "full" }, { variant: "thumb" }],
          );
        },
        alreadyLogged
          ? (db, accountId) =>
              logMessagePhotoAccess(db, {
                accountId,
                photoIds: [PHOTO],
                at: AT,
                since: AT,
              })
          : undefined,
      );
    },
  );
});
