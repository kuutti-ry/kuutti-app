import { z } from "zod";

// Invitations and the reward ledger they earn into (#107, ADR-044; TD-15): a
// code a person whose profile is complete gives a friend, single use, and what
// it earns its inviter the first night the friend's profile is complete.
// Nothing here names, counts or dates anybody but the caller.

/**
 * The code's format (ADR-044 §2), not a tunable: ten characters of
 * Crockford's base32, 50 bits, shown in two groups of five. The alphabet
 * leaves out I, L, O and U, so a code read aloud or copied by hand is hard to
 * get wrong.
 */
export const INVITATION_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITATION_CODE_LENGTH = 10;
/** A code as typed may carry spaces and hyphens; this bounds it before it is read. */
export const INVITATION_CODE_INPUT_MAX = 32;

const CODE_CHARACTER = "[0-9A-HJKMNP-TV-Z]";
const GROUP_LENGTH = INVITATION_CODE_LENGTH / 2;

/** A code as stored and hashed: the ten characters, normalised. */
export const INVITATION_CODE_PATTERN = new RegExp(`^${CODE_CHARACTER}{${INVITATION_CODE_LENGTH}}$`);
/** A code as shown: two groups of five with a hyphen between. */
export const INVITATION_CODE_GROUPED_PATTERN = new RegExp(
  `^${CODE_CHARACTER}{${GROUP_LENGTH}}-${CODE_CHARACTER}{${GROUP_LENGTH}}$`,
);

/**
 * A code as typed, the way it is stored: upper case, without spaces or
 * hyphens, O read as zero and I or L as one, as Crockford reads them. What
 * comes out still has to match INVITATION_CODE_PATTERN.
 */
export function normaliseInvitationCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** A normalised code in the two groups it is shown in. */
export function groupInvitationCode(code: string): string {
  return `${code.slice(0, GROUP_LENGTH)}-${code.slice(GROUP_LENGTH)}`;
}

/** What one unit of the reward ledger is. Mirrors the database's reward_kind. */
export const RewardKind = z.enum(["like", "fish"]).meta({ id: "RewardKind" });
export type RewardKind = z.infer<typeof RewardKind>;

/** The contract's ceilings on one invitation's reward; the amounts are the tunable. */
export const INVITATION_REWARD_FISH_MAX = 10;
export const INVITATION_REWARD_LIKES_MAX = 50;

/**
 * The shape of matching_config invitation_reward (ADR-044 §4): what an
 * invitation that counted earns its inviter, in units of each kind, 0
 * switching a kind off. One fish and no likes, the maintainer's default of
 * 22/10/2026.
 */
export const InvitationReward = z
  .object({
    fish: z.int().min(0).max(INVITATION_REWARD_FISH_MAX),
    likes: z.int().min(0).max(INVITATION_REWARD_LIKES_MAX),
  })
  .strict()
  .meta({ id: "InvitationReward" });
export type InvitationReward = z.infer<typeof InvitationReward>;

/** Units of each kind, counted: what is earned and not yet used, or what one invitation earned. */
export const RewardUnits = z
  .object({ fish: z.int().min(0), likes: z.int().min(0) })
  .meta({ id: "RewardUnits" });
export type RewardUnits = z.infer<typeof RewardUnits>;

/** The contract's ceiling on open invitations; the rule is the tunable (matching_config invitations_open, 5 at launch). */
export const INVITATIONS_OPEN_CAP = 20;

/** An invitation not redeemed yet: when it was made. Its code was shown once and is kept nowhere. */
export const OpenInvitation = z
  .object({ id: z.uuid(), createdAt: z.iso.datetime() })
  .meta({ id: "OpenInvitation" });
export type OpenInvitation = z.infer<typeof OpenInvitation>;

/**
 * The caller's invitations as the app shows them. Never a code, and nothing
 * of anybody invited: no names, and no invitation said to be redeemed but
 * not counted, which would tell the inviter that one friend joined and has
 * not finished.
 */
export const Invitations = z
  .object({
    canInvite: z.boolean().meta({
      description: "True while the person's profile and onboarding are complete.",
    }),
    redeemable: z.boolean().meta({
      description:
        "True while the person may type a code: their profile is not complete, with the current consents, no code used, and an identity never erased.",
    }),
    reward: InvitationReward.meta({
      description:
        "What an invitation earns today (matching_config invitation_reward), for the app's words.",
    }),
    /** Newest first. */
    open: z.array(OpenInvitation).max(INVITATIONS_OPEN_CAP),
    /** How many of the person's invitations have counted, ever. */
    counted: z.int().min(0),
    earned: RewardUnits.meta({
      description: "What the person's invitations earned that is not used yet.",
    }),
  })
  .meta({ id: "Invitations" });
export type Invitations = z.infer<typeof Invitations>;

/** A new invitation: its code, shown here once and kept nowhere but as a hash. */
export const InvitationCreated = z
  .object({
    id: z.uuid(),
    code: z.string().regex(INVITATION_CODE_GROUPED_PATTERN).meta({
      description: "Two groups of five; shown once, here. Kuutti keeps only its hash.",
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "InvitationCreated" });
export type InvitationCreated = z.infer<typeof InvitationCreated>;

export const InvitationParams = z
  .object({ id: z.uuid() })
  .strict()
  .meta({ id: "InvitationParams" });

/** A code typed by the person invited, after their bank login. */
export const InvitationRedeemRequest = z
  .object({
    code: z
      .string()
      .max(INVITATION_CODE_INPUT_MAX)
      .refine((typed) => INVITATION_CODE_PATTERN.test(normaliseInvitationCode(typed)), {
        error: "not an invitation code",
      })
      .meta({
        description:
          "As typed: case, spaces and hyphens do not matter, and O reads as 0, I and L as 1.",
      }),
  })
  .strict()
  .meta({ id: "InvitationRedeemRequest" });
export type InvitationRedeemRequest = z.infer<typeof InvitationRedeemRequest>;

/** Where an invitation stands, in the export of the person who made it. */
export const InvitationState = z
  .enum(["open", "redeemed", "counted"])
  .meta({ id: "InvitationState" });
export type InvitationState = z.infer<typeof InvitationState>;

/**
 * The invitations in the export (#107, ADR-044, ADR-007): those the person
 * made, the one they used, and the units theirs earned. Never a code, and
 * never the other person or when they joined.
 */
export const ExportedInvitations = z
  .object({
    /** The invitations the person made, newest first, at most 1000. */
    made: z
      .array(
        z.object({
          createdAt: z.iso.datetime(),
          state: InvitationState,
          /** When it counted; null until then. */
          countedAt: z.iso.datetime().nullable(),
        }),
      )
      .max(1000),
    /** The invitation the person joined with: when they typed it and when it counted; null when they used none. Never whose. */
    used: z
      .object({ redeemedAt: z.iso.datetime(), countedAt: z.iso.datetime().nullable() })
      .nullable(),
    /** What the person's invitations earned, one unit a row, newest first, at most 1000. */
    rewards: z
      .array(
        z.object({
          kind: RewardKind,
          earnedAt: z.iso.datetime(),
          /** When a like or a fish past the budget used it; null while it waits. */
          spentAt: z.iso.datetime().nullable(),
        }),
      )
      .max(1000),
  })
  .meta({ id: "ExportedInvitations" });
export type ExportedInvitations = z.infer<typeof ExportedInvitations>;
