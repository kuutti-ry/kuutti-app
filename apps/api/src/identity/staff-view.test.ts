import { signedInAccount } from "../test/account.ts";
import { describe, expect, test } from "../test/harness.ts";
import { accountForStaff } from "./staff-view.ts";

// A person's page in the panel (#306): the account and the identity's standing for staff.

describe("accountForStaff", () => {
  test("answers the account with its raw state and the identity's standing and dates", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const ends = new Date("2026-10-21T21:00:00Z");
    const changed = new Date("2026-10-16T09:00:00Z");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      a.accountId,
    ]);
    await ctx.client.query(
      `UPDATE identity SET standing = 'suspended', standing_changed_at = $2, suspension_ends_at = $3
       WHERE id = (SELECT identity_id FROM account WHERE id = $1)`,
      [a.accountId, changed, ends],
    );
    const found = await accountForStaff(ctx.client, a.accountId);
    expect(found?.account).toMatchObject({ id: a.accountId, state: "shadow_banned" });
    expect(found).toMatchObject({
      standing: "suspended",
      standingChangedAt: changed,
      suspensionEndsAt: ends,
    });
  });

  test("answers null for an account that does not exist", async ({ ctx }) => {
    expect(await accountForStaff(ctx.client, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
