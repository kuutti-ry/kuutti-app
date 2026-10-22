import { z } from "zod";
import { RewardUnits } from "./rewards.ts";
import { SanctionReason } from "./sanction.ts";

// Notification choices and the notices in the app (#176, ADR-032): what a
// person may be told of, each kind on or off, and what must reach them even
// without a push. Nothing here is a push: the senders come later and read the
// switches (#102 the message, #95 the round, #100 the match, #312 a decision).

/** What a person may be notified of, in the order Settings lists them. Mirrors the database's enum. */
export const NotificationKind = z
  .enum(["round", "message", "match", "moderation"])
  .meta({ id: "NotificationKind" });
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationKindParams = z
  .object({ kind: NotificationKind })
  .strict()
  .meta({ id: "NotificationKindParams" });

/** One kind and whether it is on: on until the person switches it off. */
export const NotificationChoice = z
  .object({ kind: NotificationKind, enabled: z.boolean() })
  .meta({ id: "NotificationChoice" });
export type NotificationChoice = z.infer<typeof NotificationChoice>;

/** Every kind, in NotificationKind's order. */
export const NotificationChoices = z
  .object({ choices: z.array(NotificationChoice).max(NotificationKind.options.length) })
  .meta({ id: "NotificationChoices" });
export type NotificationChoices = z.infer<typeof NotificationChoices>;

export const PutNotificationChoice = z
  .object({ enabled: z.boolean() })
  .strict()
  .meta({ id: "PutNotificationChoice" });
export type PutNotificationChoice = z.infer<typeof PutNotificationChoice>;

/** What a notice is about. Mirrors the database's enum; #312 and M5 add theirs. */
export const NoticeKind = z.enum(["warning", "invitation_counted"]).meta({ id: "NoticeKind" });
export type NoticeKind = z.infer<typeof NoticeKind>;

/** The newest notices the home screen is given; fewer than a screen, never a feed. */
export const NOTICES_MAX = 20;

const NoticeBase = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  /** Null until the person has read it. */
  readAt: z.iso.datetime().nullable(),
});

/** A moderator's warning (ADR-024 §7): its reason, which the app words; one lifted since is not shown. */
export const WarningNotice = NoticeBase.extend({
  kind: z.literal("warning"),
  reason: SanctionReason,
}).meta({ id: "WarningNotice" });

/**
 * An invitation of the person's that counted (#107, ADR-044 §9): what it
 * earned, from its own units. Never who was invited.
 */
export const InvitationCountedNotice = NoticeBase.extend({
  kind: z.literal("invitation_counted"),
  reward: RewardUnits,
}).meta({ id: "InvitationCountedNotice" });

/** A notice in the app: no text of its own, the app says it from the kind and what it points at. */
export const Notice = z
  .discriminatedUnion("kind", [WarningNotice, InvitationCountedNotice])
  .meta({ id: "Notice" });
export type Notice = z.infer<typeof Notice>;

export const Notices = z
  .object({ notices: z.array(Notice).max(NOTICES_MAX) })
  .meta({ id: "Notices" });
export type Notices = z.infer<typeof Notices>;

export const NoticeParams = z.object({ id: z.uuid() }).strict().meta({ id: "NoticeParams" });

/** The person's choices and notices in their export (#176, ADR-007): every kind as it stands, and every notice with when it was read. */
export const ExportedNotifications = z
  .object({
    choices: z.array(NotificationChoice).max(NotificationKind.options.length),
    notices: z
      .array(
        z.object({ kind: NoticeKind, at: z.iso.datetime(), readAt: z.iso.datetime().nullable() }),
      )
      .max(1000),
  })
  .meta({ id: "ExportedNotifications" });
export type ExportedNotifications = z.infer<typeof ExportedNotifications>;
