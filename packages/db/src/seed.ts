import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "./pool.ts";
import { account, identity, matchingConfig, ponds, preferences, profile } from "./schema/index.ts";

/**
 * One pond for now, the capital region (#146, ADR-010 §10 and §11): everybody
 * is in Pääkaupunkiseutu, assigned by the API from matching_config.default_pond,
 * and the pond step does not exist. The postal-code ponds of the field sheet
 * come later; the tree (parent_id) is ready for them.
 */
export const SEED_PONDS = [
  {
    slug: "paakaupunkiseutu",
    nameNominative: "Pääkaupunkiseutu",
    nameInessive: "Pääkaupunkiseudulla",
    parent: null,
  },
  // The rest of the country, a sibling of the capital region (#174, ADR-010 §12); migration 0027 writes the same row.
  {
    slug: "suomi",
    nameNominative: "Suomi",
    nameInessive: "Suomessa",
    parent: null,
  },
] as const;

/**
 * matching_config version 1: the defaults from the decisions log. Changing a
 * number here is a decision (ADR or a new config version), never a test edit.
 */
export const MATCHING_CONFIG_V1 = {
  gate_k: 30, // TD-10: matching opens per person at an eligible pool of 30
  majority_share_max: 0.6, // TD-10, TD-13: majority gender at most 60 % of active accounts
  round_size: 12, // TD-11
  impression_cap_per_day: 40, // TD-11: per candidate
  like_budget_balanced: 12, // TD-14
  like_budget_contested: 5, // TD-14
  contest_ratio_threshold: 1.5, // TD-13, TD-14: above this, the contested budget applies
  liked_you_cap: 10, // TD-11: pending likes appended per day
  like_expiry_days: 14, // TD-11
  pass_cooldown_days: 90, // TD-12
  shown_cooldown_days: 30, // TD-12
  silent_match_archive_days: 7, // TD-13
  max_photos: 6, // #48: photos per account; the grid and the upload route read it
  // #49: a moderation label at or above this confidence sends the photo to a person,
  // and a photo needs one face found at or above this confidence to be approved without one.
  photo_moderation_label_threshold: 60,
  photo_moderation_face_threshold: 90,
  // #52 (TD-6, ADR-008): the exposure budget. Cards an account may be served
  // per day (the card route of #47 counts against it; a round of 12 and up to
  // 10 pending likes fit several times over) and signed photo URLs per
  // variant per day, counted from the fetch log in the statement that writes
  // it. The day is the Finnish calendar day.
  exposure_cards_per_day: 60,
  photo_fetches_per_day: { thumb: 600, card: 300, full: 60 },
  // #54 (ADR-013, rules/schema.md): the public waitlist counter says a number
  // only where at least this many people stand behind it.
  waitlist_k: 10,
  // #146 (ADR-010 §10): the pond every account is put in when it has none;
  // the slug of a row in ponds. Version 2 names another (below); null once
  // people choose among several.
  default_pond: "suomi",
  // #147 (the field sheet, ADR-015 §9): a change of gender or of whom one
  // seeks is possible once in this many days, effective from the next count.
  change_cadence_days: 30,
  // #149 (TD-16, the disclose-to-filter rule): how many deal-breakers a person
  // may set; two at launch, so a small pond is not cut to nothing.
  deal_breakers_max: 2,
} as const;

/**
 * matching_config version 2 (ADR-010 §11, migration 0025): the one pond is the
 * capital region. Version 1 keeps its row as migration 0020 wrote it; the
 * latest version of a key wins (apps/api/src/lib/matching-config.ts).
 */
export const MATCHING_CONFIG_V2 = {
  default_pond: "paakaupunkiseutu",
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

/** The seeded live account's profile (#47), so the card preview has something to show against the mock IdP. */
export const SEED_PROFILE = {
  displayName: "Seed",
  bio: "A seeded profile for local development: long enough to count as a bio, short enough to read.",
  fields: { languages: ["fi", "en"], intent: "long_term", occupationTitle: "Seed gardener" },
  prompts: [{ key: "sunday", answer: "Sauna, then a long breakfast." }],
} as const;

export const seedHetuHmac = (label: string): string =>
  createHash("sha256").update(`kuutti seed identity: ${label}`).digest("hex");

export type SeedResult = { ponds: number; matchingConfig: number; identities: number };

/** Idempotent: upserts keyed by slug and by (key, version). Safe to run on every boot of a preview. */
export async function seed(pool: Pool, createdBy = "seed"): Promise<SeedResult> {
  const db = drizzle(pool);

  for (const pond of SEED_PONDS) {
    const parentId = pond.parent
      ? (await db.select({ id: ponds.id }).from(ponds).where(eq(ponds.slug, pond.parent)))[0]?.id
      : null;
    if (pond.parent && !parentId) throw new Error(`seed order: parent ${pond.parent} missing`);
    await db
      .insert(ponds)
      .values({
        slug: pond.slug,
        nameNominative: pond.nameNominative,
        nameInessive: pond.nameInessive,
        parentId: parentId ?? null,
      })
      .onConflictDoUpdate({
        target: ponds.slug,
        set: {
          nameNominative: pond.nameNominative,
          nameInessive: pond.nameInessive,
          parentId: parentId ?? null,
        },
      });
  }

  for (const [version, rows] of [
    [1, MATCHING_CONFIG_V1],
    [2, MATCHING_CONFIG_V2],
  ] as const) {
    for (const [key, value] of Object.entries(rows)) {
      await db
        .insert(matchingConfig)
        .values({ version, key, value, createdBy })
        .onConflictDoUpdate({
          target: [matchingConfig.key, matchingConfig.version],
          set: { value },
        });
    }
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
        // Onboarding (#46): gender, pond and the two hard rows; the consents
        // are left for the flow to ask, so the screens can be tried locally.
        const [pond] = await db
          .select({ id: ponds.id })
          .from(ponds)
          .where(eq(ponds.slug, MATCHING_CONFIG_V2.default_pond));
        await db
          .update(account)
          .set({ gender: "woman", pondId: pond?.id ?? null })
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
          .values({
            accountId: current.id,
            displayName: SEED_PROFILE.displayName,
            bio: SEED_PROFILE.bio,
            fields: SEED_PROFILE.fields,
            prompts: SEED_PROFILE.prompts,
          })
          .onConflictDoUpdate({
            target: profile.accountId,
            set: {
              displayName: SEED_PROFILE.displayName,
              bio: SEED_PROFILE.bio,
              fields: SEED_PROFILE.fields,
              prompts: SEED_PROFILE.prompts,
            },
          });
      }
    }
  }

  return {
    ponds: SEED_PONDS.length,
    matchingConfig: Object.keys(MATCHING_CONFIG_V1).length + Object.keys(MATCHING_CONFIG_V2).length,
    identities: SEED_IDENTITIES.length,
  };
}
