import { countInvitations, type RewardsDeps } from "../rewards/index.ts";
import type { NightlyJob } from "./nightly.ts";

/**
 * The night's count of invitations (#107, ADR-044 §7), right after the
 * gate's: an invitation counts the first night its redeemer has a gate row,
 * whether or not they were let in, so that the night's batch, not the moment,
 * is what the inviter learns. The work is the rewards slice's; its line in
 * the log carries how many and of what, never who.
 */
export function invitationCountJob(deps: RewardsDeps): NightlyJob {
  return { name: "invitation-count", run: () => countInvitations(deps) };
}
