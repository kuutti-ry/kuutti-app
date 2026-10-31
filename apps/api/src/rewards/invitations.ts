import { createHash, randomInt } from "node:crypto";
import { type Queryable, transaction } from "@kuutti/db";
import {
  type ExportedInvitations,
  groupInvitationCode,
  INVITATION_CODE_ALPHABET,
  INVITATION_CODE_LENGTH,
  INVITATIONS_OPEN_CAP,
  type InvitationCreated,
  InvitationReward,
  type InvitationState,
  type Invitations,
  normaliseInvitationCode,
} from "@kuutti/schema";
import { currentConsent } from "../identity/index.ts";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber, readMatchingConfig } from "../lib/matching-config.ts";
import { recordInvitationNotices } from "../notifications/index.ts";
import * as repo from "./repo.ts";

// Invitations (#107, ADR-044): a code a person whose profile is complete gives
// a friend, single use; the friend types it after the bank login, before their
// own profile is complete, and the night it is the invitation counts and its
// inviter earns matching_config invitation_reward. Who invites, who may still
// redeem and what counts all hang on one fact, completeness (ADR-060 §7), read
// when asked by the reader the app hands in. The code is shown once and kept
// as its SHA-256; it is in no log line, error detail, event or export, and
// neither is anybody's id but the caller's.

/** Whether the person's profile and onboarding are complete. Handed in: it reads across slices and lives with the jobs (rules/layout.md). */
export type CompleteReader = (db: Queryable, accountId: string) => Promise<boolean>;

export type RewardsDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  complete: CompleteReader;
};

const INVITATION_REWARD_KEY = "invitation_reward";
const INVITATIONS_OPEN_KEY = "invitations_open";
export const INVITATION_TRIES_PER_DAY_KEY = "invitation_tries_per_day";

/** The export's lists, newest first, at most this many rows (ExportedInvitations). */
const EXPORT_LIMIT = 1000;

/**
 * A code from the operating system's generator (ADR-044 §2): each character
 * drawn by `randomInt`, which has no modulo bias, from Crockford's alphabet.
 * Normalised already, as it is hashed.
 */
export function drawCode(): string {
  let code = "";
  for (let i = 0; i < INVITATION_CODE_LENGTH; i += 1) {
    code += INVITATION_CODE_ALPHABET[randomInt(INVITATION_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * What is stored of a code: the SHA-256 of the normalised code alone. Unlike
 * the e-mail's code (ADR-043) it carries no account id, since the person who
 * types it does not know whose it is; never an HMAC with the hetu's key.
 */
export const hashInvitationCode = (normalised: string): string =>
  createHash("sha256").update(normalised).digest("hex");

/**
 * matching_config invitation_reward, as the contract reads it: a value of
 * another shape is a broken deployment, answered 500 with the key named, as
 * the photo fetch budget's reader answers one (ADR-044 §4).
 */
async function readInvitationReward(db: Queryable): Promise<InvitationReward> {
  const parsed = InvitationReward.safeParse(await readMatchingConfig(db, INVITATION_REWARD_KEY));
  if (!parsed.success) {
    throw new AppError(
      500,
      "internal_error",
      `matching_config ${INVITATION_REWARD_KEY} is not a reward of fish and likes`,
      { key: INVITATION_REWARD_KEY },
    );
  }
  return parsed.data;
}

const noAccount = () => new AppError(404, "not_found", "No live account");

/**
 * Whether the person may still type a code (ADR-044 §6), their profile not
 * being complete, which the caller asks: their identity never had an account
 * erased, they redeemed none, and they gave the current terms and privacy
 * consents, the two that onboarding asks right after its welcome.
 * `deletionCount` is read by the caller, under the account's lock where it
 * writes.
 */
async function mayRedeem(
  db: Queryable,
  accountId: string,
  deletionCount: number,
): Promise<boolean> {
  // shortcut: an identity that had an account erased can never redeem, so a
  // friend who left once and came back earns their inviter nothing; a mark on
  // the identity that it once redeemed would lift it, at the cost of keeping
  // that mark through erasure, a retention change (ADR-044 §6, Open 4).
  if (deletionCount > 0) return false;
  if (await repo.hasRedeemed(db, accountId)) return false;
  // One after the other: inside the redeem's transaction `db` is one connection.
  if (!(await currentConsent(db, accountId, "terms"))) return false;
  return (await currentConsent(db, accountId, "privacy")) !== null;
}

/** The caller's invitations as the app shows them (`Invitations`): nothing of anybody invited. */
export async function invitationsOf(
  deps: Pick<RewardsDeps, "db" | "complete">,
  accountId: string,
): Promise<Invitations> {
  const { db } = deps;
  const deletionCount = await repo.deletionCountOf(db, accountId);
  if (deletionCount === null) throw noAccount();
  const [complete, reward, open, counted, earned] = await Promise.all([
    deps.complete(db, accountId),
    readInvitationReward(db),
    repo.listOpen(db, accountId, INVITATIONS_OPEN_CAP),
    repo.countCounted(db, accountId),
    repo.unspentOf(db, accountId),
  ]);
  return {
    canInvite: complete,
    redeemable: !complete && (await mayRedeem(db, accountId, deletionCount)),
    reward,
    open: open.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString() })),
    counted,
    earned,
  };
}

/**
 * A new invitation for a person whose profile is complete, a shadow-banned
 * one's too (ADR-024 §7): 409 `invitation_not_yet` otherwise.
 * At most `invitations_open` open at once, never more than the contract's
 * ceiling, counted under the account row's lock in the statement that
 * inserts: 409 `invitations_full`. The code is answered here once.
 */
export async function makeInvitation(
  deps: RewardsDeps,
  accountId: string,
): Promise<InvitationCreated> {
  const at = deps.now();
  const code = drawCode();
  const id = await transaction(deps.db, async (tx) => {
    if (!(await repo.lockAccount(tx, accountId))) throw noAccount();
    if (!(await deps.complete(tx, accountId))) {
      throw new AppError(
        409,
        "invitation_not_yet",
        "Invitations open once the profile is complete",
      );
    }
    const limit = Math.min(
      await matchingConfigNumber(tx, INVITATIONS_OPEN_KEY),
      INVITATIONS_OPEN_CAP,
    );
    const made = await repo.insertInvitation(tx, {
      accountId,
      codeHash: hashInvitationCode(code),
      at,
      limit,
    });
    if (!made) throw new AppError(409, "invitations_full", "As many invitations open as allowed");
    return made;
  });
  return { id, code: groupInvitationCode(code), createdAt: at.toISOString() };
}

/** Withdraws an open invitation of the caller's own; one redeemed, another's or nobody's is 404. */
export async function withdrawInvitation(
  db: Queryable,
  input: { accountId: string; invitationId: string },
): Promise<void> {
  if (!(await repo.deleteOpen(db, input))) {
    throw new AppError(404, "not_found", "No such open invitation");
  }
}

/**
 * A code typed by the caller (ADR-044 §6), under their account row's lock.
 * The caller first, before the code is looked up, so the route says nothing
 * about a code to somebody who could not use one: 409
 * `invitation_not_for_you`. Then the code: unknown, redeemed, or the caller's
 * own, one answer, 404 `invitation_unknown`, as ADR-027 §3 answers every
 * sign-in code that does not work. Neither answer's detail names the code.
 */
export async function redeemInvitation(
  deps: RewardsDeps,
  input: { accountId: string; code: string },
): Promise<void> {
  const codeHash = hashInvitationCode(normaliseInvitationCode(input.code));
  const at = deps.now();
  await transaction(deps.db, async (tx) => {
    const caller = await repo.lockAccount(tx, input.accountId);
    if (!caller) throw noAccount();
    const complete = await deps.complete(tx, input.accountId);
    if (complete || !(await mayRedeem(tx, input.accountId, caller.deletionCount))) {
      throw new AppError(409, "invitation_not_for_you", "This account cannot use an invitation");
    }
    if (!(await repo.redeem(tx, { accountId: input.accountId, codeHash, at }))) {
      throw new AppError(404, "invitation_unknown", "No open invitation for that code");
    }
  });
}

/**
 * The night's count (ADR-044 §7), one transaction: every invitation redeemed
 * by somebody whose profile is complete now, and not counted yet, is counted;
 * its inviter gets the units `invitation_reward` says tonight and one notice
 * (ADR-032). Counted once: a second run finds nothing. How many, and of what;
 * never who. One redeemer at a time, on the one connection of the transaction;
 * a night has few, since each redeems once ever.
 */
export async function countInvitations(
  deps: RewardsDeps,
): Promise<{ counted: number; fish: number; likes: number }> {
  const at = deps.now();
  return transaction(deps.db, async (tx) => {
    const reward = await readInvitationReward(tx);
    const redeemers: string[] = [];
    for (const redeemer of await repo.uncountedRedeemers(tx)) {
      if (await deps.complete(tx, redeemer)) redeemers.push(redeemer);
    }
    const inviters = await repo.lockInviters(tx, redeemers);
    if (inviters.length === 0) return { counted: 0, fish: 0, likes: 0 };
    const counted = await repo.markCounted(tx, { inviters, redeemers, at });
    await repo.insertUnits(tx, { counted, reward, at });
    await recordInvitationNotices(tx, {
      counted: counted.map((c) => ({ accountId: c.inviterId, invitationId: c.invitationId })),
      at,
    });
    return {
      counted: counted.length,
      fish: counted.length * reward.fish,
      likes: counted.length * reward.likes,
    };
  });
}

const stateOf = (row: { redeemedAt: Date | null; countedAt: Date | null }): InvitationState =>
  row.countedAt ? "counted" : row.redeemedAt ? "redeemed" : "open";

/**
 * The person's part of the export (ADR-044 §10, ADR-007 §3): the invitations
 * they made, the one they joined with and their units. Never a code, never
 * the other person, and of the one they joined with only its two times.
 */
export async function exportInvitations(
  db: Queryable,
  accountId: string,
): Promise<ExportedInvitations> {
  const [made, used, units] = await Promise.all([
    repo.exportedMade(db, accountId, EXPORT_LIMIT),
    repo.exportedUsed(db, accountId),
    repo.exportedUnits(db, accountId, EXPORT_LIMIT),
  ]);
  return {
    made: made.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      state: stateOf(row),
      countedAt: row.countedAt?.toISOString() ?? null,
    })),
    used: used
      ? {
          redeemedAt: used.redeemedAt.toISOString(),
          countedAt: used.countedAt?.toISOString() ?? null,
        }
      : null,
    rewards: units.map((unit) => ({
      kind: unit.kind,
      earnedAt: unit.earnedAt.toISOString(),
      spentAt: unit.spentAt?.toISOString() ?? null,
    })),
  };
}

/** The person's part of an erasure (ADR-044 §10, ADR-007 §4), in its transaction. */
export async function eraseInvitationsOf(
  tx: Queryable,
  accountId: string,
): Promise<repo.InvitationErasure> {
  return repo.eraseOf(tx, accountId);
}
