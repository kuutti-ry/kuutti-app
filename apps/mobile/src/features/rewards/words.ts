/** Which kinds a reward holds, for the messages that word it (an ICU select): "none" falls to their other branch. */
type RewardShape = "fish" | "likes" | "both" | "none";

/**
 * A reward's units as the arguments of the messages that say it
 * (`settings.invite.earns`, `notices.invitationCounted.body`): each says the
 * whole sentence for the kinds there are, so nothing is inflected around a
 * number (#107, ADR-044 §9). What an invitation earns today and what one
 * earned have the same shape.
 */
export function rewardParams({ fish, likes }: { fish: number; likes: number }): {
  reward: RewardShape;
  fish: number;
  likes: number;
} {
  const reward = fish > 0 ? (likes > 0 ? "both" : "fish") : likes > 0 ? "likes" : "none";
  return { reward, fish, likes };
}
