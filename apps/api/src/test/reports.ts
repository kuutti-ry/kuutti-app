import type { Queryable } from "@kuutti/db";
import { type SignedIn, signedInAccount } from "./account.ts";
import type { TestContext } from "./harness.ts";

// Reports as filing and the moderators' decision leave them (#311, #312),
// written straight into the test's database: plain SQL like
// `signedInAccount`, since a test of another slice may not import safety's
// internals.

/** A report from `reporter` about `reported`, filed at `created`; decided when `decided` is given. */
export async function reportIn(
  db: Queryable,
  reporter: string,
  reported: string,
  created: string,
  decided?: { outcome: "dismissed" | "acted"; at: string; by: string },
  source: "card" | "conversation" = "card",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, created_at,
                         outcome, decided_at, decided_by)
     VALUES ($1, $2, $3, 'harassment', $4, $5, $6, $7) RETURNING id`,
    [
      reporter,
      reported,
      source,
      created,
      decided?.outcome ?? null,
      decided?.at ?? null,
      decided?.by ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("test report not written");
  return id;
}

/** A sanction on the account, as #307 leaves it; lifted when `lifted` is given. */
export async function sanctionOn(db: Queryable, accountId: string, lifted?: string): Promise<void> {
  await db.query(
    `INSERT INTO sanction (identity_id, account_id, kind, reason, note, lifted_at)
     SELECT identity_id, id, 'warn', 'harassment', 'Kept asking for an address.', $2
       FROM account WHERE id = $1`,
    [accountId, lifted ?? null],
  );
}

/** Another account of an identity: a member of staff who also uses the app, or a person back after an erasure. */
export async function accountOf(
  db: Queryable,
  identityId: string,
  state = "active",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO account (identity_id, state, birth_year, birth_month)
     VALUES ($1, $2, 1990, 6) RETURNING id`,
    [identityId, state],
  );
  return rows[0]?.id as string;
}

/** `n` signed-in people, each with an identity of their own. */
export async function signedInPeople(db: Queryable, n: number): Promise<SignedIn[]> {
  const out: SignedIn[] = [];
  for (let i = 0; i < n; i++) out.push(await signedInAccount(db));
  return out;
}

/** The audit log as the test's transaction holds it, oldest first. */
export async function auditRows(ctx: TestContext) {
  return (await ctx.client.query("SELECT * FROM audit_log ORDER BY at, id")).rows;
}

export type SanctionRow = {
  kind: string;
  reason: string;
  note: string;
  created_by: string | null;
  rule: string | null;
  rule_count: number | null;
  lifted_at: Date | null;
};

/** The person's sanctions, oldest first. */
export async function sanctionsOf(db: Queryable, accountId: string): Promise<SanctionRow[]> {
  return (
    await db.query<SanctionRow>(
      `SELECT kind, reason, note, created_by, rule, rule_count, lifted_at FROM sanction
        WHERE account_id = $1 ORDER BY created_at, id`,
      [accountId],
    )
  ).rows;
}
