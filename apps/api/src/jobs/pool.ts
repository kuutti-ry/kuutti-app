import type { Queryable } from "@kuutti/db";
import { type DealBreaker, type GateResponse, PROFILE_FIELDS } from "@kuutti/schema";
import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import {
  type DealBreakerRow,
  dealBreakersFrom,
  type PoolPerson,
  preferencesFrom,
  type RoundCandidate,
} from "../matching/index.ts";
import { ageInYears, answeredFieldsOf, answeredPromptsOf, completeness } from "../profile/index.ts";

/**
 * Who of a pond is complete, and what their pools ask of them (#94, #500,
 * ADR-060): one reader for the round builder, for what a person is told of
 * their matching, and for the invitations. It lives here and not in a slice
 * because it reads across several (accounts, consents, profiles, photos,
 * preferences, ponds, blocks) and none of them should depend on the others for
 * it (rules/layout.md). The rules it applies are pure functions of the slices:
 * `inEachOthersPool` of matching, `completeness` of the profile.
 *
 * Raw parameterised SQL for the same reason as pond/repo.ts. No statement
 * takes input from a request but the caller's own account id; what is put
 * into a statement's text is a constant of the code.
 */
type FactsRow = {
  id: string;
  identity_id: string;
  gender: string | null;
  state: string;
  birth_year: number | null;
  birth_month: number | null;
  display_name: string | null;
  bio: string | null;
  bio_preset: string | null;
  prompts: unknown;
  fields: unknown;
  intent: string | null;
  approved_photos: string;
  seeks: unknown;
  age_window: unknown;
  terms: boolean;
  privacy: boolean;
  special_category: boolean;
};

/** A person whose profile and onboarding are complete, as the round builder sees them (#95). */
export type Subject = RoundCandidate & {
  /** Seen by others: a shadow-banned person has rounds of their own and is in nobody's pool. */
  visible: boolean;
};

// Who can be complete: live accounts in good standing. `registered` is not
// (no consents yet), paused, suspended and banned accounts are hidden or gone.
const FACTS = `
  SELECT a.id, a.identity_id, a.gender, a.state, a.birth_year, a.birth_month,
         p.display_name, p.bio, p.bio_preset, p.prompts, p.fields, p.fields->>'intent' AS intent,
         (SELECT count(*) FROM photo ph
           WHERE ph.account_id = a.id AND ph.purpose = 'profile' AND ph.state = 'approved') AS approved_photos,
         (SELECT r.value FROM preferences r
           WHERE r.account_id = a.id AND r.mode = 'hard' AND r.field = 'seeks') AS seeks,
         (SELECT r.value FROM preferences r
           WHERE r.account_id = a.id AND r.mode = 'hard' AND r.field = 'age_window') AS age_window,
         EXISTS (SELECT 1 FROM consent c WHERE c.account_id = a.id AND c.kind = 'terms'
                  AND c.withdrawn_at IS NULL AND c.version = $3) AS terms,
         EXISTS (SELECT 1 FROM consent c WHERE c.account_id = a.id AND c.kind = 'privacy'
                  AND c.withdrawn_at IS NULL AND c.version = $4) AS privacy,
         EXISTS (SELECT 1 FROM consent c WHERE c.account_id = a.id AND c.kind = 'special_category'
                  AND c.withdrawn_at IS NULL AND c.version = $5) AS special_category
  FROM account a
  JOIN identity i ON i.id = a.identity_id
  LEFT JOIN profile p ON p.account_id = a.id
  WHERE a.pond_id = $1 AND a.id = ANY($2::uuid[])
    AND a.state IN ('active', 'shadow_banned')
    AND i.standing = 'ok'`;

/** Somebody who blocked nobody here. */
const NO_BLOCKS: ReadonlySet<string> = new Set();
/** Somebody with no deal-breaker. */
const NO_DEAL_BREAKERS: readonly DealBreaker[] = [];

/**
 * The row as a subject, or null while something is missing: the profile's
 * completeness (#47) and onboarding's (ADR-010 §6: a consent for an older
 * wording reads as none) are both asked, by the rules the person's own
 * screens are told by. `blocks` are the identities the person blocked (#84),
 * `dealBreakers` the person's deal-breakers as stored (#87).
 */
function subjectFrom(
  row: FactsRow,
  at: Date,
  blocks: ReadonlySet<string>,
  dealBreakers: readonly DealBreaker[],
): Subject | null {
  const preferences = preferencesFrom({ seeks: row.seeks, ageWindow: row.age_window });
  const gender = row.gender as PoolPerson["gender"] | null;
  if (!gender || !preferences.seeks || !preferences.ageWindow) return null;
  if (row.birth_year === null || row.birth_month === null) return null;
  // Intent is a hard filter both ways (#147): an onboarding step, so a person without one is not done.
  const intent = PROFILE_FIELDS.intent.schema.safeParse(row.intent).data;
  if (!intent) return null;
  // The seek answer counts only with the special-category consent (ADR-019 §4), as the status reads it.
  if (!row.terms || !row.privacy || !row.special_category) return null;
  const complete = completeness({
    displayName: row.display_name,
    bio: row.bio,
    bioPreset: row.bio_preset,
    answeredPrompts: answeredPromptsOf(row.prompts),
    approvedPhotos: Number(row.approved_photos),
    seeks: preferences.seeks,
    ageWindow: preferences.ageWindow,
  }).complete;
  if (!complete) return null;
  return {
    id: row.id,
    person: {
      gender,
      seeks: preferences.seeks,
      ageWindow: preferences.ageWindow,
      age: ageInYears(row.birth_year, row.birth_month, at),
      intent,
      identityId: row.identity_id,
      blocks,
      fields: answeredFieldsOf(row.fields),
      dealBreakers,
    },
    visible: row.state === "active",
  };
}

/** The complete people of a pond among `accounts`, with whom each blocked and their deal-breakers. */
async function subjectsOf(
  db: Queryable,
  pondId: string,
  accounts: readonly string[],
  at: Date,
): Promise<Subject[]> {
  const { rows } = await db.query<FactsRow>(FACTS, [
    pondId,
    accounts,
    CURRENT_CONSENT_VERSIONS.terms,
    CURRENT_CONSENT_VERSIONS.privacy,
    CURRENT_CONSENT_VERSIONS.special_category,
  ]);
  const blocks = await blocksWithin(
    db,
    rows.map((row) => row.identity_id),
  );
  const dealBreakers = await dealBreakersOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.flatMap(
    (row) =>
      subjectFrom(
        row,
        at,
        blocks.get(row.identity_id) ?? NO_BLOCKS,
        dealBreakers.get(row.id) ?? NO_DEAL_BREAKERS,
      ) ?? [],
  );
}

/**
 * Everybody of a pond who is complete, for the round builder (#95, ADR-035):
 * whether they are seen by others, and their pool facts. Read with no lock:
 * the builder's one writer asks each candidate's liveness and the blocks again
 * in the statements that write (ADR-034 §8).
 */
export async function subjectsOfPond(db: Queryable, pondId: string, at: Date): Promise<Subject[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM account WHERE pond_id = $1 AND state IN ('active', 'shadow_banned')",
    [pondId],
  );
  return subjectsOf(
    db,
    pondId,
    rows.map((row) => row.id),
    at,
  );
}

/** One person of a pond, or null while they are not complete: the round builder's first look (#95, ADR-035 §5). */
export async function subjectOf(
  db: Queryable,
  pondId: string,
  accountId: string,
  at: Date,
): Promise<Subject | null> {
  return (await subjectsOf(db, pondId, [accountId], at))[0] ?? null;
}

/**
 * The blocks between the people of a pond, by who set them (#84, ADR-030
 * §3): a blocked pair is not in each other's pool, so the rounds never show
 * them to each other. Read here, not through the safety slice: this reader
 * reads every slice's rows itself.
 */
async function blocksWithin(
  db: Queryable,
  identities: readonly string[],
): Promise<Map<string, Set<string>>> {
  const { rows } = await db.query<{ blocker_identity_id: string; blocked_identity_id: string }>(
    `SELECT blocker_identity_id, blocked_identity_id FROM block
     WHERE blocker_identity_id = ANY($1::uuid[]) AND blocked_identity_id = ANY($1::uuid[])`,
    [identities],
  );
  const byBlocker = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byBlocker.get(row.blocker_identity_id) ?? new Set<string>();
    set.add(row.blocked_identity_id);
    byBlocker.set(row.blocker_identity_id, set);
  }
  return byBlocker;
}

/**
 * The deal-breakers of the people of a pond (#87, #149), by account, read as
 * the person's own screen reads them (`dealBreakersFrom`): a pair one of them
 * excludes is not in each other's pool. Whether one is paused is the pool's to
 * ask, from the holder's own answers. Nothing of them is logged or written here.
 */
async function dealBreakersOf(
  db: Queryable,
  accounts: readonly string[],
): Promise<Map<string, DealBreaker[]>> {
  const { rows } = await db.query<DealBreakerRow & { account_id: string }>(
    `SELECT account_id, field, value, include_unknown FROM preferences
     WHERE account_id = ANY($1::uuid[]) AND mode = 'hard'
       AND field NOT IN ('seeks', 'age_window')
     ORDER BY account_id, field`,
    [accounts],
  );
  const byAccount = new Map<string, DealBreakerRow[]>();
  for (const row of rows) {
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }
  return new Map([...byAccount].map(([account, list]) => [account, dealBreakersFrom(list)]));
}

/** The ponds an admin has opened (ADR-060 §1): the night builds their rounds. */
export async function openPondIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM ponds WHERE matching_open ORDER BY id",
  );
  return rows.map((row) => row.id);
}

/** The pond a live person is in, with its switch (rule 6: the statement names the caller). */
async function ownPond(
  db: Queryable,
  accountId: string,
): Promise<{ id: string; matching_open: boolean } | null> {
  const { rows } = await db.query<{ id: string; matching_open: boolean }>(
    `SELECT p.id, p.matching_open FROM account a JOIN ponds p ON p.id = a.pond_id
      WHERE a.id = $1 AND a.state IN ('active', 'shadow_banned')`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** The person's pond while matching is open in it; null otherwise. */
export async function openPondOf(db: Queryable, accountId: string): Promise<string | null> {
  const pond = await ownPond(db, accountId);
  return pond?.matching_open ? pond.id : null;
}

/** Whether the person's profile and onboarding are complete (ADR-060 §3, §7): read when asked, kept nowhere. */
export async function isComplete(db: Queryable, accountId: string, at: Date): Promise<boolean> {
  const pond = await ownPond(db, accountId);
  return pond !== null && (await subjectOf(db, pond.id, accountId, at)) !== null;
}

/**
 * Whether matching is open for the caller (ADR-060 §3, §4): their pond's
 * switch and their own completeness, nothing else, and nothing said of
 * anybody but the caller (rule 6: every statement names them).
 */
export async function matchingStatusOf(
  deps: { db: Queryable; now: () => Date },
  accountId: string,
): Promise<GateResponse> {
  const pond = await ownPond(deps.db, accountId);
  if (!pond || !(await subjectOf(deps.db, pond.id, accountId, deps.now()))) {
    return { state: "incomplete" };
  }
  return { state: pond.matching_open ? "open" : "closed" };
}
