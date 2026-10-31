import type { Queryable } from "@kuutti/db";
import type { AdminPond, PondSummary } from "@kuutti/schema";

// Raw parameterised SQL for the same reason as identity/repo.ts: Deps.db is
// the Queryable seam the test harness hands a rolled-back transaction through.
// Ponds are public structure, not user data: the list is the same for
// everyone. The one statement about a person, setPondOfAccount, carries the
// caller's account id (rule 6).

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

/** A pond by its slug: the default pond of matching_config is named that way (#146). */
export async function findPondBySlug(db: Queryable, slug: string): Promise<PondSummary | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM ponds WHERE slug = $1`, [slug]);
  return rows[0] ? pondFrom(rows[0]) : null;
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

/** The choice; a tombstone takes none (#51) and an unknown pond is refused. */
export async function setPondOfAccount(
  db: Queryable,
  accountId: string,
  pondId: string,
): Promise<"set" | "no_pond" | "no_account"> {
  const moved = await db.query(
    `UPDATE account SET pond_id = $2
     WHERE id = $1 AND state <> 'deleted' AND EXISTS (SELECT 1 FROM ponds WHERE id = $2)`,
    [accountId, pondId],
  );
  if (moved.rowCount === 1) return "set";
  const { rows } = await db.query("SELECT 1 FROM ponds WHERE id = $1", [pondId]);
  return rows.length === 0 ? "no_pond" : "no_account";
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
