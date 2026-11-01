import type { Queryable } from "@kuutti/db";
import type { AdminPond, PondSummary } from "@kuutti/schema";

// Raw parameterised SQL for the same reason as identity/repo.ts: Deps.db is
// the Queryable seam the test harness hands a rolled-back transaction through.
// Ponds are public structure, not user data: the list is the same for
// everyone. Every statement about a person carries the caller's account id
// (rule 6).

type Row = Record<string, unknown>;

const pondFrom = (r: Row): PondSummary => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name_nominative as string,
  nameInessive: r.name_inessive as string,
  parentId: (r.parent_id as string | null) ?? null,
});

const COLUMNS = "id, slug, name_nominative, name_inessive, parent_id";

/** Every pond in tree order: each parent right before its descendants, siblings by name. */
export async function listPonds(db: Queryable): Promise<PondSummary[]> {
  const { rows } = await db.query<Row>(
    `WITH RECURSIVE tree AS (
       SELECT ${COLUMNS}, ARRAY[name_nominative] AS path FROM ponds WHERE parent_id IS NULL
       UNION ALL
       SELECT p.id, p.slug, p.name_nominative, p.name_inessive, p.parent_id, t.path || p.name_nominative
       FROM ponds p JOIN tree t ON p.parent_id = t.id)
     SELECT ${COLUMNS} FROM tree ORDER BY path`,
  );
  return rows.map(pondFrom);
}

export async function findPondOfAccount(
  db: Queryable,
  accountId: string,
): Promise<PondSummary | null> {
  const { rows } = await db.query<Row>(
    `SELECT p.id, p.slug, p.name_nominative, p.name_inessive, p.parent_id
     FROM account a JOIN ponds p ON p.id = a.pond_id WHERE a.id = $1`,
    [accountId],
  );
  return rows[0] ? pondFrom(rows[0]) : null;
}

/** A home as `account` holds it: the kept place's key, and whether the card shows its area (ADR-061 §2, §3). */
export type StoredHome = { place: string | null; showsArea: boolean; movedAt: Date | null };

type HomeRow = {
  home_place: string | null;
  home_shows_area: boolean;
  home_moved_at: Date | null;
};

const storedHome = (row: HomeRow): StoredHome => ({
  place: row.home_place,
  showsArea: row.home_shows_area,
  movedAt: row.home_moved_at,
});

/** The person's own home; a tombstone holds none, and nobody else's is read here (rule 6). */
export async function findHomeOfAccount(
  db: Queryable,
  accountId: string,
): Promise<StoredHome | null> {
  const { rows } = await db.query<HomeRow>(
    "SELECT home_place, home_shows_area, home_moved_at FROM account WHERE id = $1",
    [accountId],
  );
  return rows[0] ? storedHome(rows[0]) : null;
}

/**
 * The home, under the lock erasure takes first (ADR-009 §8): a write racing an
 * erasure lands before the tombstone, or finds it here and writes nothing.
 * Null for no live account.
 */
export async function lockHomeOfAccount(
  tx: Queryable,
  accountId: string,
): Promise<StoredHome | null> {
  const { rows } = await tx.query<HomeRow>(
    `SELECT home_place, home_shows_area, home_moved_at FROM account
     WHERE id = $1 AND state <> 'deleted' FOR UPDATE`,
    [accountId],
  );
  return rows[0] ? storedHome(rows[0]) : null;
}

/**
 * The write of a home, and the one write of a pond (ADR-061 §8): in one
 * statement, so that nobody has a home without one and the counter's
 * `verified` still starts after a gender is declared. A pond already held
 * stays. `place` null leaves the kept place as it is, and another place than
 * the one held is a move, at `at` (§5). The pond the account has after it, null
 * for none.
 */
export async function writeHomeOfAccount(
  tx: Queryable,
  accountId: string,
  home: Pick<StoredHome, "place" | "showsArea">,
  defaultPond: string | null,
  at: Date,
): Promise<string | null> {
  const { rows } = await tx.query<{ pond_id: string | null }>(
    `UPDATE account
        SET home_moved_at = CASE WHEN $2::text <> home_place THEN $5 ELSE home_moved_at END,
            home_place = COALESCE($2, home_place), home_shows_area = $3,
            pond_id = COALESCE(pond_id, (SELECT id FROM ponds WHERE slug = $4))
      WHERE id = $1
      RETURNING pond_id`,
    [accountId, home.place, home.showsArea, defaultPond, at],
  );
  return rows[0]?.pond_id ?? null;
}

const adminPondFrom = (r: Row): AdminPond => ({
  ...pondFrom(r),
  matchingOpen: r.matching_open as boolean,
});

/** Every pond with its switch, by name, for the panel (ADR-060 §2). */
export async function listPondsForAdmin(db: Queryable): Promise<AdminPond[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}, matching_open FROM ponds ORDER BY name_nominative`,
  );
  return rows.map(adminPondFrom);
}

/**
 * Sets a pond's switch, under the row's lock, and says what it was: `changed`
 * is false for a press that met the switch as it was asked to be already, so
 * two admins pressing at once write one audit row. Null for no such pond.
 */
export async function setMatchingOpen(
  db: Queryable,
  pondId: string,
  open: boolean,
): Promise<{ pond: AdminPond; changed: boolean } | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}, matching_open FROM ponds WHERE id = $1 FOR UPDATE`,
    [pondId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.matching_open === open) return { pond: adminPondFrom(row), changed: false };
  await db.query("UPDATE ponds SET matching_open = $2 WHERE id = $1", [pondId, open]);
  return { pond: adminPondFrom({ ...row, matching_open: open }), changed: true };
}
