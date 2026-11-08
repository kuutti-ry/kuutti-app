import type { InvitationReward } from "@kuutti/schema";

/**
 * Which of the two an invitation earns for, for the messages that word it (an
 * ICU select). In `settings.invite.earns` "friend" is the other branch, and
 * "none" is never drawn; in `invite.share.message` "none" is the other branch,
 * which is empty.
 */
type RewardShape = "both" | "inviter" | "friend" | "none";

/**
 * What an invitation earns as the arguments of the messages that say it
 * (`settings.invite.earns`, `invite.redeem.earns`): each says the whole
 * sentence for the sides there are, so nothing is inflected around a number
 * (#107, ADR-044 §9, #503).
 */
export function rewardParams({ inviterFish, friendFish }: InvitationReward): {
  reward: RewardShape;
  inviterFish: number;
  friendFish: number;
} {
  const reward =
    inviterFish > 0 ? (friendFish > 0 ? "both" : "inviter") : friendFish > 0 ? "friend" : "none";
  return { reward, inviterFish, friendFish };
}
