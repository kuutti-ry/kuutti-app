import { z } from "zod";
import { RewardUnits } from "./rewards.ts";
import { SanctionReason } from "./sanction.ts";

// Notification choices and the notices in the app (#176, ADR-032): what a
// person may be told of, each kind on or off, and what must reach them even
// without a push. Nothing here is a push: the senders come later and read the
// switches (#102 the message, #100 the match, #312 a decision).

/** What a person may be notified of, in the order Settings lists them. Mirrors the database's enum. */
export const NotificationKind = z
  .enum(["message", "match", "moderation", "announcement"])
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
export const NoticeKind = z
  .enum(["warning", "invitation_counted", "invitation_friend", "announcement"])
  .meta({ id: "NoticeKind" });
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

/**
 * The invitation the person used, counted (#503, ADR-044 §9): what it earned
 * them, from their own units. Never who invited them.
 */
export const InvitationFriendNotice = NoticeBase.extend({
  kind: z.literal("invitation_friend"),
  reward: RewardUnits,
}).meta({ id: "InvitationFriendNotice" });

// Announcements (#573, ADR-068): one text to everybody, written by an admin
// in the panel and sent once another admin approves it. English and Finnish
// are required, Swedish optional; a Swedish reader of one without Swedish
// reads the English, and Stadi reads the Finnish. Formats, not tunables.

/** The most characters of an announcement's title, its email's subject. */
export const ANNOUNCEMENT_TITLE_MAX = 80;
/** The most characters of an announcement's body. */
export const ANNOUNCEMENT_BODY_MAX = 1000;

/** One language's words of an announcement: plain text, never empty, trimmed. */
export const AnnouncementText = z
  .object({
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
  })
  .strict()
  .meta({ id: "AnnouncementText" });
export type AnnouncementText = z.infer<typeof AnnouncementText>;

/**
 * An announcement to everybody (#573, ADR-068 §3): its title and body in the
 * request's language, as an admin wrote them. The one notice with words of
 * its own, which are Kuutti's, never a person's.
 */
export const AnnouncementNotice = NoticeBase.extend({
  kind: z.literal("announcement"),
  title: z.string().max(ANNOUNCEMENT_TITLE_MAX),
  body: z.string().max(ANNOUNCEMENT_BODY_MAX),
}).meta({ id: "AnnouncementNotice" });

/** A notice in the app: no text of its own, the app says it from the kind and what it points at; an announcement says its own. */
export const Notice = z
  .discriminatedUnion("kind", [
    WarningNotice,
    InvitationCountedNotice,
    InvitationFriendNotice,
    AnnouncementNotice,
  ])
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

// The push (#102, ADR-055): a device's token, and what a push carries for the
// app. A push says that there is something, never what or from whom: its one
// line is the app's own words, and its data names the kind alone. Never a
// message's text, a name, an account, or the conversation, whose id both
// people's phones would share and so tie the two together for Expo, Apple and
// Google (the maintainer's of 25/10/2026).

/** The phone platforms a push reaches. Mirrors the database's enum. */
export const PushPlatform = z.enum(["ios", "android"]).meta({ id: "PushPlatform" });
export type PushPlatform = z.infer<typeof PushPlatform>;

/** An Expo push token as `getExpoPushTokenAsync` gives it, either of Expo's two spellings. */
export const ExpoPushToken = z
  .string()
  .max(200)
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,160}\]$/);

/** The caller's session's token; the language its pushes are worded in is the request's. */
export const PushTokenRequest = z
  .object({ token: ExpoPushToken, platform: PushPlatform })
  .strict()
  .meta({ id: "PushTokenRequest" });
export type PushTokenRequest = z.infer<typeof PushTokenRequest>;

/** What a push's `data` carries: its kind. A tap on a message's or a match's goes to the conversations, on an announcement's home. */
export const PushData = z
  .object({ kind: z.enum(["message", "match", "announcement"]) })
  .strict()
  .meta({ id: "PushData" });
export type PushData = z.infer<typeof PushData>;

/** A session's push in the export (ADR-055 §11): whether it gets them, never the token. */
export const ExportedPush = z
  .object({
    platform: PushPlatform,
    /** The language its pushes are worded in. */
    locale: z.enum(["en", "fi", "sv"]),
    registeredAt: z.iso.datetime(),
  })
  .meta({ id: "ExportedPush" });
export type ExportedPush = z.infer<typeof ExportedPush>;

// The panel's side of the announcements (#573, ADR-068 §2): an admin writes
// one, another approves it, and either may delete it before then.

/** An announcement as an admin writes it: English and Finnish, and Swedish or nothing. */
export const AnnouncementDraft = z
  .object({
    en: AnnouncementText,
    fi: AnnouncementText,
    sv: AnnouncementText.optional(),
  })
  .strict()
  .meta({ id: "AnnouncementDraft" });
export type AnnouncementDraft = z.infer<typeof AnnouncementDraft>;

/**
 * One announcement in the panel: its words, when it was written and approved,
 * and whether the caller wrote it, which is who may not approve it. Never who
 * wrote or approved it: the audit log says that.
 */
export const AdminAnnouncement = z
  .object({
    id: z.uuid(),
    en: AnnouncementText,
    fi: AnnouncementText,
    sv: AnnouncementText.nullable(),
    writtenAt: z.iso.datetime(),
    /** Null while it waits for a second admin; set, it went to everybody then. */
    approvedAt: z.iso.datetime().nullable(),
    yours: z.boolean(),
  })
  .meta({ id: "AdminAnnouncement" });
export type AdminAnnouncement = z.infer<typeof AdminAnnouncement>;

/** How many an announcement approved now reaches: everybody gets the notice; the switch and a device or a confirmed address decide the rest. */
export const AnnouncementReach = z
  .object({
    accounts: z.int().min(0),
    /** People who would be pushed: the switch on and a live device. */
    phones: z.int().min(0),
    /** Confirmed addresses whose person has the switch on. */
    addresses: z.int().min(0),
  })
  .meta({ id: "AnnouncementReach" });
export type AnnouncementReach = z.infer<typeof AnnouncementReach>;

/** The newest announcements the panel lists. */
export const ANNOUNCEMENTS_LISTED = 50;

export const AdminAnnouncementList = z
  .object({
    items: z.array(AdminAnnouncement).max(ANNOUNCEMENTS_LISTED),
    reach: AnnouncementReach,
  })
  .meta({ id: "AdminAnnouncementList" });
export type AdminAnnouncementList = z.infer<typeof AdminAnnouncementList>;

export const AnnouncementParams = z
  .object({ id: z.uuid() })
  .strict()
  .meta({ id: "AnnouncementParams" });
