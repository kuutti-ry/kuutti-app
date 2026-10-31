import { countInvitations, type RewardsDeps } from "../rewards/index.ts";
import type { NightlyJob } from "./nightly.ts";
import { isComplete } from "./pool.ts";

/**
 * The night's count of invitations (#107, ADR-044 §7): an invitation counts
 * the first night its redeemer's profile is complete, whether or not their
 * pond is open, so that the night's batch, not the moment, is what the inviter
 * learns. The work is the rewards slice's; its line in the log carries how
 * many and of what, never who.
 */
export function invitationCountJob(deps: Omit<RewardsDeps, "complete">): NightlyJob {
  const complete: RewardsDeps["complete"] = (db, accountId) =>
    isComplete(db, accountId, deps.now());
  return { name: "invitation-count", run: () => countInvitations({ ...deps, complete }) };
}
