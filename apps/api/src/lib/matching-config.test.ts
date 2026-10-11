import type { Queryable } from "@kuutti/db";
import { describe, expect, test } from "../test/harness.ts";
import { AppError } from "./errors.ts";
import {
  matchingConfigNumber,
  matchingConfigNumbers,
  readMatchingConfig,
} from "./matching-config.ts";

// Every tunable is a row (CLAUDE.md Product constraints). Keys of this file
// only, inside the test's transaction: the seed's own rows are not touched.

async function row(db: Queryable, key: string, version: number, value: unknown): Promise<void> {
  await db.query(
    "INSERT INTO matching_config (version, key, value, created_by) VALUES ($1, $2, $3::jsonb, 'lib test')",
    [version, key, JSON.stringify(value)],
  );
}

/** The refusal a missing or malformed tunable is: a 500 that names the key in its detail, never a default. */
async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("readMatchingConfig", () => {
  test("the latest version of a key wins, whatever its shape", async ({ ctx }) => {
    await row(ctx.client, "lib_test.window", 1, { min: 18, max: 99 });
    await row(ctx.client, "lib_test.window", 3, { min: 25, max: 40 });
    await row(ctx.client, "lib_test.window", 2, { min: 20, max: 60 });
    expect(await readMatchingConfig(ctx.client, "lib_test.window")).toEqual({ min: 25, max: 40 });
  });

  test("a key with no row is a deployment without its seed: an error, not a default", async ({
    ctx,
  }) => {
    const error = await refusal(readMatchingConfig(ctx.client, "lib_test.absent"));
    expect(error).toMatchObject({ status: 500, code: "internal_error" });
    expect(error.message).toBe("matching_config has no row for lib_test.absent");
    expect(error.detail).toEqual({ key: "lib_test.absent" });
  });
});

describe("matchingConfigNumber", () => {
  test("a number is read as one", async ({ ctx }) => {
    await row(ctx.client, "lib_test.k", 1, 5);
    expect(await matchingConfigNumber(ctx.client, "lib_test.k")).toBe(5);
  });

  test("a value that is not a number is refused, a numeric string included", async ({ ctx }) => {
    await row(ctx.client, "lib_test.text", 1, "5");
    await row(ctx.client, "lib_test.object", 1, { value: 5 });
    for (const key of ["lib_test.text", "lib_test.object"]) {
      const error = await refusal(matchingConfigNumber(ctx.client, key));
      expect(error).toMatchObject({ status: 500, code: "internal_error", detail: { key } });
      expect(error.message).toBe(`matching_config ${key} is not a number`);
    }
  });

  test("a missing key fails as readMatchingConfig does", async ({ ctx }) => {
    const error = await refusal(matchingConfigNumber(ctx.client, "lib_test.absent"));
    expect(error.message).toBe("matching_config has no row for lib_test.absent");
  });
});

describe("matchingConfigNumbers", () => {
  test("reads several keys in one statement, the latest version of each", async ({ ctx }) => {
    await row(ctx.client, "lib_test.a", 1, 1);
    await row(ctx.client, "lib_test.a", 2, 10);
    await row(ctx.client, "lib_test.b", 1, 0.5);
    expect(await matchingConfigNumbers(ctx.client, ["lib_test.a", "lib_test.b"])).toEqual({
      "lib_test.a": 10,
      "lib_test.b": 0.5,
    });
  });

  test("one missing key fails the whole read and is named", async ({ ctx }) => {
    await row(ctx.client, "lib_test.a", 1, 1);
    const error = await refusal(matchingConfigNumbers(ctx.client, ["lib_test.a", "lib_test.gone"]));
    expect(error.message).toBe("matching_config has no row for lib_test.gone");
    expect(error.detail).toEqual({ key: "lib_test.gone" });
  });

  test("one value that is not a number fails the whole read and is named", async ({ ctx }) => {
    await row(ctx.client, "lib_test.a", 1, 1);
    await row(ctx.client, "lib_test.flag", 1, true);
    // Only the latest version counts: a number in an older one does not save it.
    await row(ctx.client, "lib_test.b", 1, 2);
    await row(ctx.client, "lib_test.b", 2, null);
    const flag = await refusal(matchingConfigNumbers(ctx.client, ["lib_test.a", "lib_test.flag"]));
    expect(flag.message).toBe("matching_config lib_test.flag is not a number");
    const nulled = await refusal(matchingConfigNumbers(ctx.client, ["lib_test.b"]));
    expect(nulled.message).toBe("matching_config lib_test.b is not a number");
  });
});
