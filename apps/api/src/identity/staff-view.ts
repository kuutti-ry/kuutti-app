import type { Account, Queryable } from "@kuutti/db";
import type { IdentityStanding } from "@kuutti/schema";
import * as repo from "./repo.ts";

/**
 * An account as staff read it on a person's page (#306): the row with its raw
 * state (a shadow ban shows here, to staff only), and the identity's
 * standing with its dates. Never the hash, the broker's ids, the research id
 * or the e-mail; the caller picks what it shows. Null for an unknown id.
 */
export async function accountForStaff(
  db: Queryable,
  accountId: string,
): Promise<{
  account: Account;
  standing: IdentityStanding;
  standingChangedAt: Date | null;
  suspensionEndsAt: Date | null;
} | null> {
  const account = await repo.findAccountById(db, accountId);
  if (!account) return null;
  const { rows } = await db.query<{
    standing: IdentityStanding;
    standing_changed_at: Date | null;
    suspension_ends_at: Date | null;
  }>("SELECT standing, standing_changed_at, suspension_ends_at FROM identity WHERE id = $1", [
    account.identityId,
  ]);
  const identity = rows[0];
  if (!identity) throw new Error(`accountForStaff: no identity for ${accountId}`);
  return {
    account,
    standing: identity.standing,
    standingChangedAt: identity.standing_changed_at,
    suspensionEndsAt: identity.suspension_ends_at,
  };
}
