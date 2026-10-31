import { type Queryable, transaction } from "@kuutti/db";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { track } from "../research/index.ts";
import * as repo from "./repo.ts";

// Taking a break (#170, ADR-022): the account to `paused` with the state it
// had kept aside, every device signed out, and nothing else touched. The
// profile, the photos, the preferences and the consents stay as they are; the
// pool, the counter and the card leave a paused account out on their own
// (ADR-013 §2, ADR-060 §3, profile/card.ts). The
// next bank login brings the state back (login.ts). Nothing here deletes:
// erasure.ts is the only delete.
// shortcut: the login exchange takes the account row's share lock
// (insertSession, ADR-024 §4) but admits `paused`, a live state for the guard
// (ADR-022 §5), so a login that commits between the session guard and this
// transaction still leaves one live session on a paused account until the
// app's next start. The round builder (#95) builds nothing for a paused
// account, so such a session can only decide a round built before the break
// (ADR-034 Open 9); refusing `paused` there lifts it, when the round screen
// (#379) makes that matter.

export type PauseDeps = { db: Queryable; logger: Logger; now: () => Date };

/**
 * One transaction: the row under its lock (ADR-015 §8), the state kept aside,
 * every session revoked, one research event. A second device that passed the
 * session guard before the first commit finds the row paused and is told so.
 */
export async function pauseAccount(
  deps: PauseDeps,
  accountId: string,
): Promise<{ sessions: number }> {
  const at = deps.now();
  const result = await transaction(deps.db, async (tx) => {
    const locked = await repo.lockAccountRow(tx, accountId);
    if (!locked || locked.state === "deleted") {
      throw new AppError(404, "not_found", "No live account");
    }
    if (locked.state === "paused") {
      throw new AppError(409, "already_paused", "The account is on a break already");
    }
    if (!(await repo.pauseAccount(tx, accountId, at))) {
      throw new AppError(409, "not_active", "Only a finished account can take a break");
    }
    const sessions = await repo.revokeAccountSessions(tx, accountId, at, "paused");
    await track({ db: tx, logger: deps.logger, now: () => at }, accountId, "account_paused", {});
    return { sessions };
  });
  // The one line a break leaves: the account and how many devices it signed out.
  deps.logger.info({ accountId, sessions: result.sessions }, "account paused");
  return result;
}

/**
 * The bank login that ends a break: the state kept aside comes back, and
 * research hears how long the break was, in whole days. A login on another
 * device that resumed the account first leaves nothing to do.
 */
export async function resumeAccount(
  deps: PauseDeps,
  account: { id: string; stateChangedAt: Date | null },
): Promise<boolean> {
  const at = deps.now();
  if (!(await repo.resumeAccount(deps.db, account.id, at))) return false;
  const since = account.stateChangedAt ?? at;
  await track(deps, account.id, "account_resumed", {
    afterDays: Math.max(0, Math.floor((at.getTime() - since.getTime()) / 86_400_000)),
  });
  deps.logger.info({ accountId: account.id }, "account resumed");
  return true;
}
