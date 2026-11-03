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
});

const COLUMNS = "id, slug, name_nominative";

/** Every pond by name; there is one, the country (ADR-061 §8). */
export async function listPonds(db: Queryable): Promise<PondSummary[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM ponds ORDER BY name_nominative`);
  return rows.map(pondFrom);
}

export async function findPondOfAccount(
  db: Queryable,
  accountId: string,
): Promise<PondSummary | null> {
  const { rows } = await db.query<Row>(
    `SELECT p.id, p.slug, p.name_nominative
     FROM account a JOIN ponds p ON p.id = a.pond_id WHERE a.id = $1`,
    [accountId],
  );
  return rows[0] ? pondFrom(rows[0]) : null;
}

/** A home as `account` holds it: the kept place's key, and whether the card shows its area (ADR-061 §2, §3). */
export type StoredHome = { place: string | null; showsArea: boolean };

type HomeRow = {
  home_place: string | null;
  home_shows_area: boolean;
};

const storedHome = (row: HomeRow): StoredHome => ({
  place: row.home_place,
  showsArea: row.home_shows_area,
});

/** The person's own home; a tombstone holds none, and nobody else's is read here (rule 6). */
export async function findHomeOfAccount(
  db: Queryable,
  accountId: string,
): Promise<StoredHome | null> {
  const { rows } = await db.query<HomeRow>(
    "SELECT home_place, home_shows_area FROM account WHERE id = $1",
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
    `SELECT home_place, home_shows_area FROM account
     WHERE id = $1 AND state <> 'deleted' FOR UPDATE`,
    [accountId],
  );
  return rows[0] ? storedHome(rows[0]) : null;
}

/**
 * The write of a home, and the one write of a pond (ADR-061 §8): in one
 * statement, so that nobody has a home without one and the counter's
 * `verified` still starts after a gender is declared. The slug is the row every
 * database has (migration 0027, kept by 0095); a pond already held stays.
 * `place` null leaves the kept place as it is.
 */
export async function writeHomeOfAccount(
  tx: Queryable,
  accountId: string,
  home: StoredHome,
): Promise<void> {
  await tx.query(
    `UPDATE account
        SET home_place = COALESCE($2, home_place), home_shows_area = $3,
            pond_id = COALESCE(pond_id, (SELECT id FROM ponds WHERE slug = 'suomi'))
      WHERE id = $1`,
    [accountId, home.place, home.showsArea],
  );
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
