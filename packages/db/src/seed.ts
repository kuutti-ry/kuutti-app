import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "./pool.ts";
import { account, identity, matchingConfig, ponds, preferences, profile } from "./schema/index.ts";

/**
 * One pond, the whole country (ADR-061 §8), set by the API with a person's
 * home. The migrations write the same row, and a second pond here would stand
 * on every boot of a preview and nowhere else.
 */
export const SEED_PONDS = [
  {
    slug: "suomi",
    nameNominative: "Suomi",
  },
] as const;

/**
 * matching_config version 1: every key as the migrations write it, each at the
 * value it stood at when the chain was folded (ADR-065; migrate.test.ts holds the
 * two identical). docs/decisions.md says who decided each. Changing a number here
 * is a decision (ADR or a new config version), never a test edit.
 */
export const MATCHING_CONFIG_V1 = {
  like_budget_balanced: 10, // TD-14; #98 (ADR-036): ten a day for everybody, the first cut's
  like_expiry_days: 14, // TD-11
  pass_cooldown_days: 30, // TD-12; #503 (ADR-062 §6): a pass holds thirty days
  silent_match_archive_days: 7, // TD-13
  max_photos: 6, // #48: photos per account; the grid and the upload route read it
  // #49, #253: a moderation label the check does not know goes to a person at or
  // above this confidence; a face counts as present at or above the face line.
  photo_moderation_label_threshold: 60,
  photo_moderation_face_threshold: 90,
  // #253 (ADR-006 §2): each hard group of labels, a person from
  // `review`, the check's own rejection from `reject`.
  photo_moderation_nudity_review: 60,
  photo_moderation_nudity_reject: 90,
  photo_moderation_violence_review: 60,
  photo_moderation_violence_reject: 90,
  photo_moderation_disturbing_review: 60,
  photo_moderation_disturbing_reject: 90,
  photo_moderation_hate_review: 60,
  photo_moderation_hate_reject: 90,
  // #253: a nudity label this sure leaves the owner no appeal.
  photo_moderation_nudity_no_appeal: 95,
  // #253: two hard rejections in 30 days make the check
  // stricter for that account for 30 days, its reject line at 75.
  photo_closer_look_attempts: 2,
  photo_closer_look_window_days: 30,
  photo_closer_look_days: 30,
  photo_closer_look_reject: 75,
  // #376: a photo nobody decided in two weeks is rejected as not reviewed.
  photo_queue_reject_days: 14,
  // #378 (ADR-039): a fish a person may send in each seven
  // days from a Monday, the calendar week (#475; rolling until then).
  fish_budget: 1,
  fish_window_days: 7,
  // #56: profile photo tips; the tips rule reads these against photo_review signals.
  photo_tip_mirror_confidence_min: 50,
  photo_tip_bathroom_confidence_min: 50,
  photo_tip_sunglasses_confidence_min: 50,
  photo_tip_tight_crop_face_area_min: 0.4,
  photo_tip_brightness_below: 40,
  photo_tip_sharpness_below: 20,
  photo_tip_group_photo_min_faces: 2,
  photo_tip_photos_suggested: 3,
  // #253: the main-photo tips, a lot of skin and a fish.
  photo_tip_revealing_confidence_min: 80,
  photo_tip_fish_confidence_min: 80,
  // #253: the fish tip names the species from this confidence.
  photo_tip_fish_species_min: 70,
  // #296 (ADR-006 §3): the automatic description says a scene,
  // an object or a face attribute only from this confidence. Up when wrong
  // descriptions turn out common.
  photo_description_confidence_min: 80,
  // #52 (TD-6, ADR-008): the exposure budget. Cards an account may be served
  // per day (the card route of #47 counts against it) and signed photo URLs
  // per variant per day, counted from the fetch log in the statement that
  // writes it. The day is the Finnish calendar day. 0 is off: #502 (ADR-062 §9)
  // took the ceiling off cards and card photos, the maintainer's of 01/11/2026,
  // and the cards alarm stands instead.
  exposure_cards_per_day: 0,
  photo_fetches_per_day: { thumb: 600, card: 0, full: 60 },
  // #237 (ADR-007 §3): copies of one's own data per Finnish
  // day, counted from account_export in the statement that writes it. The
  // zip carries every full-size photo, so the day's copies bound the exposure.
  exports_per_day: 3,
  // #171 (ADR-023): feedback a person may send per Finnish
  // day, counted from feedback in the statement that writes the row; the
  // sixth is refused in words.
  feedback_per_day: 5,
  // #385 (ADR-043): a code works thirty minutes and three
  // wrong attempts; five codes an account a Finnish day.
  email_code_minutes: 30,
  email_code_attempts: 3,
  email_codes_per_day: 5,
  // #107, #503 (ADR-044 §4): what an invitation that counted earns its inviter and
  // the friend who used it, a fish each, the maintainer's of 29/10 and 31/10/2026,
  // 0 switching a side off; the unredeemed invitations a person may hold at once;
  // the codes a person may try a Finnish day.
  invitation_reward: { inviterFish: 1, friendFish: 1 },
  invitations_open: 5,
  invitation_tries_per_day: 5,
  // #102 (ADR-055 §10): at most one push of a conversation to
  // its recipient in ten minutes; none from 22 to 8 in Helsinki (equal hours
  // mean no quiet hours).
  message_push_min_interval_minutes: 10,
  push_quiet_from_hour: 22,
  push_quiet_to_hour: 8,
  moderation_response_hours: 24, // #303, #299: the hours the association promises to answer within
  // #84 (ADR-030 §4): reports a person may file per Finnish
  // day, counted from report in the statement that writes the row; the sixth
  // is refused in words, and nothing is written, the block included.
  reports_per_day: 5,
  // #351 (ADR-030 §12): the days after a conversation closed
  // during which either person may still report it, so a block cannot be
  // used to dodge a report.
  report_after_close_days: 30,
  // #105 (ADR-033): the automatic shadow bans, the
  // maintainer's of 19/10/2026. Reports by this many different people within
  // the days; this many first messages within the minutes; the same first
  // message to this many people within the hours; and the hours a moderator
  // has to confirm or reverse one. A threshold of 0 switches its rule off.
  auto_shadow_ban_reports: 3,
  auto_shadow_ban_reports_days: 7,
  auto_shadow_ban_first_messages: 20,
  auto_shadow_ban_first_messages_minutes: 60,
  auto_shadow_ban_same_first_message: 5,
  auto_shadow_ban_same_first_message_hours: 24,
  auto_shadow_ban_review_hours: 48,
  // #86 (ADR-041): the velocity rules, the maintainer's of 21/10/2026. URLs of other
  // people's photos in the card and full sizes within the minutes, where an honest
  // reader of the queue stays under the alarm, the maintainer's of 01/11/2026 (#502,
  // ADR-062 §9); different people's cards served within the minutes, the alarm that
  // stands with no ceiling on cards; and reads of the queue within the minutes. A
  // threshold of 0 switches its rule off.
  auto_shadow_ban_photo_fetches: 1500,
  auto_shadow_ban_photo_fetches_minutes: 60,
  auto_shadow_ban_cards_served: 300,
  auto_shadow_ban_cards_served_minutes: 10,
  auto_shadow_ban_round_reads: 30,
  auto_shadow_ban_round_reads_minutes: 1,
  // #348 (ADR-031 §6): the longest message, in characters
  // after trimming, and the messages one account may send in a minute; the
  // send reads both on each request.
  message_max_length: 2000,
  messages_per_minute: 30,
  // #350: photos one account may send in conversations per
  // Finnish day, counted in the statement that writes the photo; the next
  // one is refused in words until midnight.
  message_photos_per_day: 10,
  // #350: the sends one account may try in a day, refused ones included; the
  // route's limiter counts them, since a refused photo is stored nowhere.
  message_photo_attempts_per_day: 30,
  // #54 (ADR-013, rules/schema.md): the public counter says a number
  // only where at least this many people stand behind it.
  pond_counter_k: 10,
  // #147 (the field sheet, ADR-060 §9): a change of gender is possible once in
  // this many days.
  change_cadence_days: 30,
  // #149 (TD-16, the disclose-to-filter rule), #508 (ADR-009 History), #514 (ADR-061
  // §7): how many deal-breakers a person may set: seven, one on every field a
  // deal-breaker can be set on and the distance, which is no field; the
  // maintainer's of 31/10/2026.
  deal_breakers_max: 7,
  // #514 (ADR-061 §2, §3): a place kept has at least this many
  // people, the one number no name, band or probe narrows anybody below; a
  // town on a card has at least the second.
  home_min_inhabitants: 3000,
  home_town_min_inhabitants: 20000,
  // #514 (ADR-061 §5): the outer edges of the distance bands
  // in kilometres, nearby, close and around; far has none.
  distance_nearby_km: 5,
  distance_close_km: 15,
  distance_around_km: 50,
  // #502, #503 (ADR-062 §6): the ladder's clocks, the second
  // pass the maintainer's of 01/11/2026 and the others #503's of 29/10/2026.
  liked_cooldown_days: 90,
  ended_cooldown_days: 90,
  second_pass_cooldown_days: 365,
  // #502 (ADR-062 §5): the conversations on a person's turn at
  // which they can make no new match, and at which the list warns of it.
  your_turn_limit: 8,
  your_turn_warning: 6,
  // #502 (ADR-062 §4): the unread likes that keep a person out
  // of everybody's ordinary queue until they have gone through them.
  inbox_stop: 30,
  // #575 (ADR-064 §5): the most stars a person's list may hold,
  // the maintainer's of 03/11/2026. Those it leaves out do not count, and 0 is off.
  stars_max: 10,
} as const;

/**
 * Identities that make the re-registration rule reachable through the mock
 * IdP (#34): one banned, one inside its deletion cooldown, one active with a
 * live account. Their hetu_hmac is a hash of the label, not of any code, so
 * no bank login ever maps to them: they exist for the seeded environments only.
 */
export const SEED_IDENTITIES = [
  { label: "seed-banned", standing: "banned", cooldownDaysLeft: null, account: null },
  { label: "seed-cooldown", standing: "ok", cooldownDaysLeft: 29, account: null },
  {
    label: "seed-active",
    standing: "ok",
    cooldownDaysLeft: null,
    account: { birthYear: 1990, birthMonth: 1 },
  },
] as const;

/** The seeded live account's home (ADR-061 §2): a key as the home's route keeps it, here Kallio's. */
const SEED_HOME_PLACE = "00530";

/** The seeded live account's profile (#47), so the card preview has something to show against the mock IdP. */
const SEED_PROFILE = {
  displayName: "Seed",
  bio: "A seeded profile for local development: long enough to count as a bio, short enough to read.",
  fields: { languages: ["fi", "en"], intent: "long_term", occupationTitle: "Seed gardener" },
  prompts: [{ key: "sunday", answer: "Sauna, then a long breakfast." }],
} as const;

const seedHetuHmac = (label: string): string =>
  createHash("sha256").update(`kuutti seed identity: ${label}`).digest("hex");

export type SeedResult = { ponds: number; matchingConfig: number; identities: number };

/**
 * Idempotent: upserts keyed by slug and by (key, version). Safe to run on every
 * boot of a preview. It opens the ponds it writes on every run, the row the
 * migrations wrote first among them, so that development, previews and
 * CI have rounds from the first start (ADR-060 §10). Production refuses it.
 */
export async function seed(pool: Pool, createdBy = "seed"): Promise<SeedResult> {
  const db = drizzle(pool);

  for (const pond of SEED_PONDS) {
    await db
      .insert(ponds)
      .values({
        slug: pond.slug,
        nameNominative: pond.nameNominative,
        matchingOpen: true,
      })
      .onConflictDoUpdate({
        target: ponds.slug,
        set: { nameNominative: pond.nameNominative, matchingOpen: true },
      });
  }

  for (const [key, value] of Object.entries(MATCHING_CONFIG_V1)) {
    await db
      .insert(matchingConfig)
      .values({ version: 1, key, value, createdBy })
      .onConflictDoUpdate({
        target: [matchingConfig.key, matchingConfig.version],
        set: { value },
      });
  }

  const now = Date.now();
  for (const person of SEED_IDENTITIES) {
    const reregisterAfter =
      person.cooldownDaysLeft === null
        ? null
        : new Date(now + person.cooldownDaysLeft * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(identity)
      .values({ hetuHmac: seedHetuHmac(person.label), standing: person.standing, reregisterAfter })
      .onConflictDoUpdate({
        target: identity.hetuHmac,
        set: { standing: person.standing, reregisterAfter },
      })
      .returning({ id: identity.id });
    if (!row) throw new Error(`seed: identity ${person.label} not written`);
    if (person.account) {
      const live = await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.identityId, row.id), ne(account.state, "deleted")));
      if (live.length === 0) {
        await db.insert(account).values({
          identityId: row.id,
          state: "active",
          birthYear: person.account.birthYear,
          birthMonth: person.account.birthMonth,
        });
      }
      const [current] = await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.identityId, row.id), ne(account.state, "deleted")));
      if (current) {
        // Onboarding (#46): gender, home, pond and the two hard rows; the consents
        // are left for the flow to ask, so the screens can be tried locally.
        const [pond] = await db
          .select({ id: ponds.id })
          .from(ponds)
          .where(eq(ponds.slug, SEED_PONDS[0].slug));
        await db
          .update(account)
          .set({ gender: "woman", pondId: pond?.id ?? null, homePlace: SEED_HOME_PLACE })
          .where(eq(account.id, current.id));
        for (const [field, value] of [
          ["seeks", ["man", "non_binary"]],
          ["age_window", { min: 25, max: 40 }],
        ] as const) {
          await db
            .insert(preferences)
            .values({ accountId: current.id, field, value, mode: "hard" })
            .onConflictDoUpdate({
              target: [preferences.accountId, preferences.field],
              set: { value },
            });
        }
        await db
          .insert(profile)
          .values({ accountId: current.id, ...SEED_PROFILE })
          .onConflictDoUpdate({ target: profile.accountId, set: SEED_PROFILE });
      }
    }
  }

  return {
    ponds: SEED_PONDS.length,
    matchingConfig: Object.keys(MATCHING_CONFIG_V1).length,
    identities: SEED_IDENTITIES.length,
  };
}
