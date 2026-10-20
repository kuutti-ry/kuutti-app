import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account, identity } from "./identity.ts";

/**
 * A photo row is the account's; the object behind it is shared (#48, TD-2,
 * TD-8). `key` is the SHA-256 of the re-encoded full variant, so the same
 * picture uploaded twice, by the same person or by two accounts, is one set
 * of objects in the bucket and two rows here. No original is ever stored
 * (rule 4), so nothing here points at one. Width and height are the full
 * variant's; the blurhash is computed from the thumb and lets the app paint
 * before the bytes arrive.
 */
export const photoState = pgEnum("photo_state", ["pending", "approved", "queued", "rejected"]);
export const photoVariant = pgEnum("photo_variant", ["thumb", "card", "full"]);
/**
 * What a photo is for (#350): one of the profile's, ordered and on the card,
 * or one sent in a conversation, seen by its two people only. The profile's
 * reads ask for `profile`; a message photo never reaches a card, a photos
 * screen or the moderators' queue.
 */
export const photoPurpose = pgEnum("photo_purpose", ["profile", "message"]);
/** Why a photo was not accepted, a closed list the owner is told in words (#49): a moderator's choice, the check's, or the night's. */
export const photoRejectionReason = pgEnum("photo_rejection_reason", [
  "nudity",
  "no_person",
  "several_people",
  "minor",
  "violence",
  "contact_details",
  "other",
  // The night's, for a photo nobody decided in time (#376, ADR-006 §2); never a moderator's choice.
  "not_reviewed",
]);

export const photo = pgTable(
  "photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    // Content address: hex SHA-256 of the full variant. Objects live under
    // media/<key>/<variant>.webp and are removed when the last row goes.
    key: text("key").notNull(),
    blurhash: text("blurhash").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    // pending until moderation (#49) says otherwise; the owner sees it, nobody else.
    state: photoState("state").notNull().default("pending"),
    // Set with state rejected, by a moderator or the check; the app shows its text.
    rejectionReason: photoRejectionReason("rejection_reason"),
    // The owner may ask a person to look (#253): set when the check rejects,
    // unless it was sure of nudity; cleared by the appeal or a person's decision.
    appealable: boolean("appealable").notNull().default(false),
    purpose: photoPurpose("purpose").notNull().default("profile"),
    // 0 is the main photo. The owner orders; the API renumbers 0..n-1. A
    // message photo has none.
    position: smallint("position"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The owner's line for the photo (#296): a key of PHOTO_CAPTIONS, never
    // the person's text, so there is nothing to check; the words are the
    // client's, per language.
    caption: text("caption"),
  },
  (table) => [
    index("photo_account_position_idx").on(table.accountId, table.position),
    index("photo_key_idx").on(table.key),
    // The day's message photos of an account (message_photos_per_day, #350).
    index("photo_message_day_idx")
      .on(table.accountId, table.createdAt)
      .where(sql`${table.purpose} = 'message'`),
    check(
      "photo_position_check",
      sql`(${table.purpose} = 'profile') = (${table.position} IS NOT NULL)`,
    ),
  ],
);

/**
 * One row per signed URL issued (rules/api.md Media, security checklist
 * "Signed URL issuance is logged per account"). This is the fetch log the
 * exposure budget of TD-6 counts from (#52), and what makes a leak
 * attributable: with bank-verified accounts, to a person. `photo_id` has no
 * foreign key on purpose: the log outlives the photo it names.
 */
export const photoAccess = pgTable(
  "photo_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    photoId: uuid("photo_id").notNull(),
    variant: photoVariant("variant").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // A message photo's fetch is logged and never counted against the day's
    // budget (#350): written when the URL is issued, since the photo it names
    // may be gone by the time a later fetch is counted.
    purpose: photoPurpose("purpose").notNull().default("profile"),
  },
  // The budget is counted per account per day (#52); the same index serves it.
  (table) => [index("photo_access_account_at_idx").on(table.accountId, table.at)],
);

/**
 * The shown record (#52, TD-6): one row per photo on a card the viewer was
 * served, written by the card route (#47) for the viewer's own account. Another
 * account's photo is issued a URL only against such a row, so a scraper
 * cannot enumerate photos it was never shown. One row per viewer and photo,
 * however often the card comes round: the rule reads set membership, and `at`
 * is the last day the card was served, so it counts against that day's
 * budget once. The row
 * goes with the photo (cascade) and with the viewer's erasure
 * (media/erasure.ts); M4's nightly sweep trims rows older than
 * shown_cooldown_days once the round logic has no use for them (ADR-008).
 */
export const cardShown = pgTable(
  "card_shown",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    photoId: uuid("photo_id")
      .notNull()
      .references(() => photo.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("card_shown_account_photo_idx").on(table.accountId, table.photoId),
    // The cascade from photo looks rows up by photo_id; without this it scans the table.
    index("card_shown_photo_idx").on(table.photoId),
  ],
);

/**
 * What moderation saw and decided for one photo (#49, TD-8, ADR-006). The
 * automatic check writes the labels Rekognition returned (bounded, with
 * confidences) and its outcome; a moderator's decision is written over it
 * with who decided and why. Labels are kept for the profile tips (#56) and
 * nothing else; the image itself never comes back from Rekognition. The row
 * goes with the photo.
 */
export const photoDecision = pgEnum("photo_decision", ["approved", "queued", "rejected"]);

export const photoReview = pgTable(
  "photo_review",
  {
    photoId: uuid("photo_id")
      .primaryKey()
      .references(() => photo.id, { onDelete: "cascade" }),
    // [{ name, parentName, confidence }], at most 50: moderation labels first,
    // then tip signals from DetectLabels / DetectFaces (#56).
    labels: jsonb("labels").notNull(),
    // Faces DetectFaces found above the configured confidence.
    faces: integer("faces").notNull(),
    // What the automatic check did not like, by label name or "no_face"; empty when approved.
    flagged: text("flagged").array().notNull(),
    modelVersion: text("model_version"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    decision: photoDecision("decision").notNull(),
    // A moderator's decision: who (identity, never account) and when. Null while automatic.
    decidedBy: uuid("decided_by").references(() => identity.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: photoRejectionReason("reason"),
    // When the owner asked a person to look at the check's rejection (#253); once per photo.
    appealedAt: timestamp("appealed_at", { withTimezone: true }),
    // What the check saw for everyone to hear (#296, ADR-006 §3): a
    // PhotoDescription of packages/schema, keys of a closed list and never a
    // sentence, written with the labels by the automatic check and read by the
    // owner's list, the card and the export. Null before the check ran, or
    // where none runs. Goes with the row, so with the photo.
    description: jsonb("description"),
  },
  (table) => [index("photo_review_decision_idx").on(table.decision, table.checkedAt)],
);
