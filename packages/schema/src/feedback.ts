import { z } from "zod";

/**
 * Feedback from inside the app (#171, ADR-023): a kind, a few lines, and what
 * the app reads for the moderators, its version, the platform and the
 * language, never typed by the person. No attachments. The text reaches no
 * log line and no research event (rule 5); the event carries the kind alone.
 */
export const FeedbackKind = z
  .enum(["bug", "idea", "complaint", "praise"])
  .meta({ id: "FeedbackKind" });
export type FeedbackKind = z.infer<typeof FeedbackKind>;

/** The panel's order: a bug is read first, praise last; a complaint before an idea. */
export const FEEDBACK_KIND_ORDER: readonly FeedbackKind[] = ["bug", "complaint", "idea", "praise"];

export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_VERSION_MAX = 40;
export const FEEDBACK_LOCALE_MAX = 16;

export const FeedbackPlatform = z.enum(["ios", "android", "web"]).meta({ id: "FeedbackPlatform" });
export type FeedbackPlatform = z.infer<typeof FeedbackPlatform>;

export const FeedbackRequest = z
  .object({
    kind: FeedbackKind,
    /** The person's words, trimmed; never empty. */
    text: z.string().trim().min(1).max(FEEDBACK_TEXT_MAX),
    /** The app's counted version (lib/build.ts), such as 0.22.0; "?" when the build carries none. */
    appVersion: z.string().min(1).max(FEEDBACK_VERSION_MAX),
    platform: FeedbackPlatform,
    /** The app's language at the time: a BCP 47 tag (en, fi, sv; en-XA in a dev build). */
    locale: z.string().min(2).max(FEEDBACK_LOCALE_MAX),
  })
  .strict()
  .meta({ id: "FeedbackRequest" });
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;

/** One row as the panel reads it. */
export const FeedbackItem = z
  .object({
    id: z.uuid(),
    /** The sender's account id: pseudonymous to staff, never hetu_hmac or research_id. */
    accountId: z.uuid(),
    kind: FeedbackKind,
    text: z.string().min(1).max(FEEDBACK_TEXT_MAX),
    appVersion: z.string().min(1).max(FEEDBACK_VERSION_MAX),
    platform: FeedbackPlatform,
    locale: z.string().min(2).max(FEEDBACK_LOCALE_MAX),
    createdAt: z.iso.datetime(),
    handledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "FeedbackItem" });
export type FeedbackItem = z.infer<typeof FeedbackItem>;

export const FeedbackList = z
  .object({
    items: z.array(FeedbackItem).max(100),
    /** Unhandled rows in total, beyond this page. */
    total: z.int().min(0),
  })
  .meta({ id: "FeedbackList" });
export type FeedbackList = z.infer<typeof FeedbackList>;

export const FeedbackListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .meta({ id: "FeedbackListQuery" });

export const FeedbackParams = z.object({ id: z.uuid() }).meta({ id: "FeedbackParams" });

export const FeedbackHandledResponse = z
  .object({ id: z.uuid(), handledAt: z.iso.datetime() })
  .meta({ id: "FeedbackHandledResponse" });
export type FeedbackHandledResponse = z.infer<typeof FeedbackHandledResponse>;

/** The person's own feedback in their export (ADR-007 §4), with whether a moderator has read it. */
export const ExportedFeedback = z
  .object({
    at: z.iso.datetime(),
    kind: FeedbackKind,
    text: z.string().max(FEEDBACK_TEXT_MAX),
    appVersion: z.string().max(FEEDBACK_VERSION_MAX),
    platform: FeedbackPlatform,
    locale: z.string().max(FEEDBACK_LOCALE_MAX),
    handledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ExportedFeedback" });
export type ExportedFeedback = z.infer<typeof ExportedFeedback>;
