import { createI18n, typedT } from "@kuutti/i18n";
import { describe, expect, it } from "vitest";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, englishT, test } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { exportArchive, exportFileStem } from "./export.ts";

// The archive's name and its guard (#237); the zip itself and the day's cap
// are held through the route in erasure.test.ts.

describe("the export's file name", () => {
  it.each(["en", "fi", "sv"] as const)(
    "is ASCII letters, digits and hyphens with the Finnish day in %s",
    (locale) => {
      const t = typedT(createI18n({ locale }), locale);
      // 23:30 in Helsinki on the first: the day is Finland's, not UTC's.
      const stem = exportFileStem(t, new Date("2026-10-01T20:30:00Z"));
      expect(stem).toMatch(/^[a-z0-9-]+-2026-10-01$/);
      expect(stem).not.toContain("--");
    },
  );
});

describe("the archive", () => {
  test("gives the copy back when the build fails, so a bad minute spends none of the day's three", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { exports_per_day: 3 });
    const { logger } = await captureLogger();
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position) VALUES ($1, 'k', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0)`,
      [a.accountId],
    );
    const { deps: media } = testMediaDeps();
    const broken = {
      ...media,
      store: {
        ...media.store,
        get: async () => {
          throw new Error("the bucket is unreachable");
        },
      },
    };
    const deps = { db: ctx.client, logger, now: () => new Date(), version: "test", media: broken };
    await expect(exportArchive(deps, a.accountId, englishT)).rejects.toThrow(
      "the bucket is unreachable",
    );
    const { rows } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM account_export WHERE account_id = $1",
      [a.accountId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  test("answers 404 for an account that does not exist and records nothing", async ({ ctx }) => {
    const { logger, lines } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => new Date(), version: "test" };
    await expect(
      exportArchive(deps, "00000000-0000-4000-8000-00000000dead", englishT),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    const { rows } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM account_export",
    );
    expect(Number(rows[0]?.n)).toBe(0);
    expect(lines().filter((l) => l.msg === "export built")).toEqual([]);
  });
});
