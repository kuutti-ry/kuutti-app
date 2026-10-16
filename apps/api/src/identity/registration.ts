import type { Account, Identity } from "@kuutti/db";

/**
 * Days after a self-deletion before the same person may register again
 * (TD-7): long enough that deleting and returning is not a way to shed a
 * reputation, short enough not to punish a change of mind. Not a matching
 * parameter, so a constant here rather than a matching_config row.
 */
export const REREGISTER_COOLDOWN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the callback does after the bank has said who this is (rules/api.md). */
export type RegistrationDecision =
  | { kind: "create_identity" }
  | { kind: "create_account"; identityId: string }
  | { kind: "resume"; account: Account }
  | { kind: "refuse"; reason: "banned" }
  | { kind: "refuse"; reason: "suspended"; until: Date | null }
  | { kind: "refuse"; reason: "cooldown"; until: Date };

/**
 * The re-registration rule of features/identity/re-registration.feature,
 * pure: a banned or suspended identity is refused whatever it does, a
 * suspended one with the day its suspension ends when the identity has one
 * (ADR-024 §5); an identity inside its cooldown is refused with the date; an identity with a
 * live account resumes it; anything else gets a fresh account with nothing
 * restored. A person the database has never seen gets an identity first.
 */
export function decideRegistration(input: {
  identity: Identity | null;
  liveAccount: Account | null;
  now: Date;
}): RegistrationDecision {
  const { identity, liveAccount, now } = input;
  if (identity === null) return { kind: "create_identity" };
  if (identity.standing === "banned") return { kind: "refuse", reason: "banned" };
  if (identity.standing === "suspended") {
    return { kind: "refuse", reason: "suspended", until: identity.suspensionEndsAt };
  }
  if (liveAccount !== null) return { kind: "resume", account: liveAccount };
  if (identity.reregisterAfter !== null && now.getTime() < identity.reregisterAfter.getTime()) {
    return { kind: "refuse", reason: "cooldown", until: identity.reregisterAfter };
  }
  return { kind: "create_account", identityId: identity.id };
}

/**
 * What erasure writes on the identity row it keeps (TD-7): one more deletion,
 * and the instant before which no new account may be created.
 */
export function recordDeletion(
  identity: Pick<Identity, "deletionCount">,
  deletedAt: Date,
): { deletionCount: number; reregisterAfter: Date } {
  return {
    deletionCount: identity.deletionCount + 1,
    reregisterAfter: new Date(deletedAt.getTime() + REREGISTER_COOLDOWN_DAYS * DAY_MS),
  };
}
