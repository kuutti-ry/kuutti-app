import { randomUUID } from "node:crypto";
import { type Queryable, transaction } from "@kuutti/db";
import {
  type Sanction,
  type SanctionEntry,
  type SanctionKind,
  SanctionNote,
  type SanctionReason,
  type SanctionRule,
  SUSPENSION_DAYS_MAX,
} from "@kuutti/schema";
import { closeConversationsOf } from "../chat/index.ts";
import {
  endSessionsForSanction,
  lockAccountForSanction,
  type OpenSanctions,
  settleStanding,
} from "../identity/index.ts";
import { AppError } from "../lib/errors.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { recordWarningNotice } from "../notifications/index.ts";
import { recordAudit } from "./audit.ts";

// Sanctions (#307, ADR-024): the record of what staff did to a person, and the
// one way the account's state and the identity's standing change because of
// it. Every change locks the identity's accounts and the identity first,
// writes its audit row, writes the sanction row, and settles every account of
// the identity from what is still open. Staff's note is the person's data and
// staff's words: it reaches no log line, no error detail, no event and not the
// person's export. Raw parameterised SQL through Queryable, as the other
// slices' repositories, so the test harness's rolled-back transaction passes
// through.

/** Who acts: a member of staff by identity, or nobody (the night, the demo's story, #105's rules). */
type Actor = string | null;

/** Which route a sanction is reached through: a ban's own, for admins, or the rest, for moderators. */
export type SanctionScope = "ban" | "other";

const COLUMNS = `id, identity_id, account_id, kind, reason, note, ends_at, created_by, created_at,
  lifted_at, lifted_by, review_note, reviewed_by, reviewed_at, rule`;

type Row = {
  id: string;
  identity_id: string;
  account_id: string;
  kind: SanctionKind;
  reason: SanctionReason;
  note: string;
  ends_at: Date | null;
  created_by: string | null;
  created_at: Date;
  lifted_at: Date | null;
  lifted_by: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  rule: SanctionRule | null;
};

/** The rule a sanction's audit rows name, when an automatic rule applied it (#105). */
const ruleOf = (row: Row): Record<string, string> => (row.rule ? { rule: row.rule } : {});

const iso = (at: Date | null) => (at ? at.toISOString() : null);

function toItem(row: Row): Sanction {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    reason: row.reason,
    note: row.note,
    endsAt: iso(row.ends_at),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    liftedAt: iso(row.lifted_at),
    liftedBy: row.lifted_by,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: iso(row.reviewed_at),
  };
}

const inScope = (kind: SanctionKind, scope: SanctionScope) =>
  scope === "ban" ? kind === "ban" : kind !== "ban";

/**
 * What is open on an account and its identity: bans and suspensions bind the
 * identity across its accounts (a kept row of an erased account still counts),
 * a shadow ban binds the account it was set on.
 */
async function openOf(
  db: Queryable,
  accountId: string,
  identityId: string,
): Promise<OpenSanctions> {
  const { rows } = await db.query<{
    ban: boolean | null;
    ends: Date | null;
    shadow: boolean | null;
  }>(
    `SELECT bool_or(kind = 'ban') AS ban,
       max(ends_at) FILTER (WHERE kind = 'suspend') AS ends,
       bool_or(kind = 'shadow_ban' AND account_id = $1) AS shadow
     FROM sanction
     WHERE lifted_at IS NULL
       AND ((identity_id = $2 AND kind IN ('ban', 'suspend')) OR account_id = $1)`,
    [accountId, identityId],
  );
  const row = rows[0];
  return {
    ban: row?.ban === true,
    suspensionEndsAt: row?.ends ?? null,
    shadowBan: row?.shadow === true,
  };
}

/** A calendar day plus so many days, as `YYYY-MM-DD`: date arithmetic, so no change of the clocks moves it. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** The day a suspension ends must be after today in Finland and at most SUSPENSION_DAYS_MAX calendar days ahead. */
function checkEndsOn(endsOn: string, at: Date): void {
  const today = finnishDay(at);
  if (endsOn <= today || endsOn > addDays(today, SUSPENSION_DAYS_MAX)) {
    throw new AppError(
      400,
      "ends_on_invalid",
      `A suspension ends after today and at most ${SUSPENSION_DAYS_MAX} days ahead`,
    );
  }
}

/** Staff's note, parsed again here: the routes parse it, and #105's rules will call without a route. */
function noteOf(note: string): string {
  const parsed = SanctionNote.safeParse(note);
  if (!parsed.success)
    throw new AppError(400, "validation_failed", "The note is empty or too long");
  return parsed.data;
}

const ownAccount = () =>
  new AppError(409, "own_account", "Nobody lifts or looks again at a sanction on themselves");

/**
 * A member of staff is not sanctioned through the panel (ADR-024 §3, the
 * maintainer's to change): the maintainer revokes the role first with the
 * moderator tool, so a moderator cannot lock an admin or another moderator out
 * of the panel, nor themselves.
 */
async function refuseStaffTarget(db: Queryable, identityId: string): Promise<void> {
  const { rows } = await db.query("SELECT 1 FROM moderator_roles WHERE identity_id = $1", [
    identityId,
  ]);
  if (rows.length > 0) {
    throw new AppError(409, "staff_target", "A member of staff loses the role before a sanction");
  }
}

/**
 * Every account of the identity settled from what is open for it: the target
 * and the live one alike. Then what an erased account kept only because it
 * carried the standing goes, once lifted (ADR-024 §8): the erasure would have
 * deleted it had it been lifted then; the audit log keeps the history.
 */
async function settleAll(
  db: Queryable,
  locked: { identityId: string; accounts: { id: string; state: string }[] },
  at: Date,
): Promise<void> {
  for (const { id } of locked.accounts) {
    await settleStanding(db, { accountId: id, open: await openOf(db, id, locked.identityId), at });
  }
  const erased = locked.accounts.filter((a) => a.state === "deleted").map((a) => a.id);
  if (erased.length > 0) {
    await db.query(
      "DELETE FROM sanction WHERE account_id = ANY($1::uuid[]) AND lifted_at IS NOT NULL",
      [erased],
    );
  }
}

export type ApplyInput = {
  accountId: string;
  kind: SanctionKind;
  reason: SanctionReason;
  note: string;
  /** A suspension's last day out is the day before this one: it ends at the start of it, in Finland. */
  endsOn?: string;
  actor: Actor;
  at: Date;
  /** An automatic rule's shadow ban (#105, ADR-033): which rule, what it counted, its earliest event. */
  rule?: { rule: SanctionRule; count: number; firstAt: Date };
};

/**
 * Applies a sanction (ADR-024 §2-§4): the audit row, the sanction row, the
 * account and identity settled, and for a suspension or a ban every session
 * ended; a ban closes the person's conversations too (#348). A ban binds an
 * erased account's identity too; anything else refuses a tombstone. Nothing
 * the person can read changes for a shadow ban.
 */
export async function applySanction(db: Queryable, input: ApplyInput): Promise<Sanction> {
  const note = noteOf(input.note);
  if (input.kind === "suspend") {
    if (!input.endsOn) throw new AppError(400, "ends_on_invalid", "A suspension needs its end");
    checkEndsOn(input.endsOn, input.at);
  }
  return transaction(db, async (tx) => {
    const account = await lockAccountForSanction(tx, input.accountId);
    if (!account) throw new AppError(404, "not_found", "No such account");
    if (account.state === "deleted" && input.kind !== "ban") {
      throw new AppError(409, "account_deleted", "Only a ban binds an erased account");
    }
    await refuseStaffTarget(tx, account.identityId);
    const id = randomUUID();
    // A person's sanction names them; an automatic rule's names the rule and
    // no actor (#105, the maintainer, 19/10/2026). What else nobody does (the
    // demo's story) writes no row.
    if (input.actor || input.rule) {
      await recordAudit(tx, {
        actorIdentityId: input.actor,
        action: "sanction.apply",
        subjectType: "account",
        subjectId: input.accountId,
        detail: {
          sanctionId: id,
          kind: input.kind,
          reason: input.reason,
          ...(input.rule ? { rule: input.rule.rule, count: input.rule.count } : {}),
        },
      });
    }
    const { rows } = await tx.query<Row>(
      `INSERT INTO sanction (id, identity_id, account_id, kind, reason, note, ends_at, created_by, created_at,
                             rule, rule_count, rule_first_at)
       VALUES ($1, $2, $3, $4, $5, $6,
         CASE WHEN $7::date IS NULL THEN NULL ELSE ($7::date)::timestamp AT TIME ZONE 'Europe/Helsinki' END,
         $8, $9, $10, $11, $12)
       RETURNING ${COLUMNS}`,
      [
        id,
        account.identityId,
        input.accountId,
        input.kind,
        input.reason,
        note,
        input.kind === "suspend" ? input.endsOn : null,
        input.actor,
        input.at,
        input.rule?.rule ?? null,
        input.rule?.count ?? null,
        input.rule?.firstAt ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("sanction insert returned no row");
    // A warning tells the person in the app (ADR-024 §7, #176), in its transaction.
    if (input.kind === "warn") {
      await recordWarningNotice(tx, { accountId: input.accountId, sanctionId: id, at: input.at });
    }
    await settleAll(tx, account, input.at);
    if (input.kind === "suspend" || input.kind === "ban") {
      await endSessionsForSanction(tx, {
        accountIds: account.accounts.filter((a) => a.state !== "deleted").map((a) => a.id),
        identityId: account.identityId,
        at: input.at,
      });
    }
    // A ban closes the person's conversations for good (#348, ADR-031 §2);
    // a suspension closes none, and they wait for its end.
    if (input.kind === "ban") {
      await closeConversationsOf(tx, {
        accountIds: account.accounts.filter((a) => a.state !== "deleted").map((a) => a.id),
        how: "sanction",
        at: input.at,
      });
    }
    return toItem(row);
  });
}

async function findSanction(db: Queryable, id: string): Promise<Row | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM sanction WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** A sanction reached through the route of its scope; another scope's is not found there. */
async function sanctionIn(db: Queryable, id: string, scope: SanctionScope): Promise<Row> {
  const row = await findSanction(db, id);
  if (!row || !inScope(row.kind, scope)) throw new AppError(404, "not_found", "No such sanction");
  return row;
}

const lifted = () => new AppError(409, "sanction_lifted", "The sanction is already lifted");

/**
 * Lifts a sanction: the audit row, the lift, the account settled from what is
 * still open. Lifting restores no session: the person signs in again.
 */
export async function liftSanction(
  db: Queryable,
  input: { sanctionId: string; scope: SanctionScope; actor: string; at: Date },
): Promise<Sanction> {
  const found = await sanctionIn(db, input.sanctionId, input.scope);
  if (found.identity_id === input.actor) throw ownAccount();
  return transaction(db, async (tx) => {
    const account = await lockAccountForSanction(tx, found.account_id);
    if (!account) throw new Error(`liftSanction: no account ${found.account_id}`);
    await recordAudit(tx, {
      actorIdentityId: input.actor,
      action: "sanction.lift",
      subjectType: "account",
      subjectId: found.account_id,
      detail: { sanctionId: found.id, kind: found.kind, reason: found.reason, ...ruleOf(found) },
    });
    // Keyed on the open state: of two staff lifting at once one writes, and the
    // other's audit row is rolled back with its refusal.
    const { rows } = await tx.query<Row>(
      `UPDATE sanction SET lifted_at = $2, lifted_by = $3
       WHERE id = $1 AND lifted_at IS NULL RETURNING ${COLUMNS}`,
      [found.id, input.at, input.actor],
    );
    const row = rows[0];
    if (!row) throw lifted();
    await settleAll(tx, account, input.at);
    return toItem(row);
  });
}

/**
 * A second member of staff's look (ADR-024 §3): somebody other than who
 * applied it, once; keep it, or lift it in the same step. The note is the
 * reviewer's words, kept like the sanction's own.
 */
export async function reviewSanction(
  db: Queryable,
  input: {
    sanctionId: string;
    scope: SanctionScope;
    actor: string;
    note: string;
    outcome: "keep" | "lift";
    at: Date;
  },
): Promise<Sanction> {
  const note = noteOf(input.note);
  const found = await sanctionIn(db, input.sanctionId, input.scope);
  if (found.identity_id === input.actor) throw ownAccount();
  if (found.created_by === input.actor) {
    throw new AppError(409, "own_sanction", "A sanction is looked at again by somebody else");
  }
  const reviewed = () =>
    new AppError(409, "sanction_reviewed", "The sanction was looked at already");
  if (found.reviewed_at) throw reviewed();
  const lift = input.outcome === "lift";
  if (lift && found.lifted_at) throw lifted();
  return transaction(db, async (tx) => {
    const account = await lockAccountForSanction(tx, found.account_id);
    if (!account) throw new Error(`reviewSanction: no account ${found.account_id}`);
    await recordAudit(tx, {
      actorIdentityId: input.actor,
      action: "sanction.review",
      subjectType: "account",
      subjectId: found.account_id,
      detail: {
        sanctionId: found.id,
        kind: found.kind,
        reason: found.reason,
        outcome: input.outcome,
        ...ruleOf(found),
      },
    });
    const { rows } = await tx.query<Row>(
      `UPDATE sanction SET review_note = $2, reviewed_by = $3, reviewed_at = $4,
         lifted_at = CASE WHEN $5 THEN $4 ELSE lifted_at END,
         lifted_by = CASE WHEN $5 THEN $3 ELSE lifted_by END
       WHERE id = $1 AND reviewed_at IS NULL AND (NOT $5 OR lifted_at IS NULL)
       RETURNING ${COLUMNS}`,
      [found.id, note, input.actor, input.at, lift],
    );
    const row = rows[0];
    if (!row) {
      const now = await findSanction(tx, found.id);
      throw now?.reviewed_at ? reviewed() : lifted();
    }
    if (lift) await settleAll(tx, account, input.at);
    return toItem(row);
  });
}

/**
 * The night's end of suspensions (ADR-024 §5): every open suspension past its
 * end is closed by nobody and its account settled, one account per
 * transaction. Idempotent: a second process arming the same night finds
 * nothing left.
 */
// shortcut: lifted at the night's run; a login on the end day before 04:00 is
// still refused. A lift at the login would close those hours.
export async function endSuspensions(db: Queryable, at: Date): Promise<number> {
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT DISTINCT account_id FROM sanction
     WHERE kind = 'suspend' AND lifted_at IS NULL AND ends_at <= $1`,
    [at],
  );
  let ended = 0;
  for (const { account_id: accountId } of rows) {
    ended += await transaction(db, async (tx) => {
      const account = await lockAccountForSanction(tx, accountId);
      if (!account) return 0;
      const result = await tx.query(
        `UPDATE sanction SET lifted_at = $2
         WHERE account_id = $1 AND kind = 'suspend' AND lifted_at IS NULL AND ends_at <= $2`,
        [accountId, at],
      );
      await settleAll(tx, account, at);
      return result.rowCount ?? 0;
    });
  }
  return ended;
}

/**
 * A person's sanctions for the panel, newest first: the account's own and the
 * identity's bans set on any of its accounts. Null for an unknown account.
 * Staff read across accounts here by design (the panel's page of #306).
 */
export async function listSanctions(
  db: Queryable,
  accountId: string,
): Promise<SanctionEntry[] | null> {
  const { rows: found } = await db.query<{ identity_id: string }>(
    "SELECT identity_id FROM account WHERE id = $1",
    [accountId],
  );
  const identityId = found[0]?.identity_id;
  if (!identityId) return null;
  // The staff's roles now (#308), each by its key: moderator_roles has one row per identity.
  const roleOf = (column: string) =>
    `(SELECT m.role FROM moderator_roles m WHERE m.identity_id = sanction.${column})`;
  const { rows } = await db.query<
    Row & {
      created_by_role: SanctionEntry["createdByRole"];
      lifted_by_role: SanctionEntry["liftedByRole"];
      reviewed_by_role: SanctionEntry["reviewedByRole"];
    }
  >(
    `SELECT ${COLUMNS}, ${roleOf("created_by")} AS created_by_role,
       ${roleOf("lifted_by")} AS lifted_by_role, ${roleOf("reviewed_by")} AS reviewed_by_role
     FROM sanction
     WHERE account_id = $1 OR (identity_id = $2 AND kind = 'ban')
     ORDER BY created_at DESC, id DESC LIMIT 1000`,
    [accountId, identityId],
  );
  return rows.map((row) => ({
    ...toItem(row),
    createdByRole: row.created_by_role,
    liftedByRole: row.lifted_by_role,
    reviewedByRole: row.reviewed_by_role,
  }));
}

/** One sanction in the person's own export, before its words are added in the request's language. */
export type OwnSanction = {
  kind: SanctionKind;
  reason: SanctionReason;
  appliedAt: string;
  endsAt: string | null;
  liftedAt: string | null;
  lookedAtAgain: boolean;
};

/**
 * The export's half (ADR-024 §8): the account's sanctions, newest first;
 * never who, never a note, and not an open shadow ban (#105).
 */
export async function listSanctionsOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<OwnSanction[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM sanction
     WHERE account_id = $1 AND NOT (kind = 'shadow_ban' AND lifted_at IS NULL)
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    kind: row.kind,
    reason: row.reason,
    appliedAt: row.created_at.toISOString(),
    endsAt: iso(row.ends_at),
    liftedAt: iso(row.lifted_at),
    lookedAtAgain: row.reviewed_at !== null,
  }));
}

/**
 * Erasure's half (ADR-024 §8): the account's sanctions go, except the open
 * bans and suspensions, which carry the identity's standing (TD-7's kept
 * side). Inside the caller's transaction.
 */
export async function deleteSanctionsOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query(
    `DELETE FROM sanction
     WHERE account_id = $1 AND NOT (lifted_at IS NULL AND kind IN ('ban', 'suspend'))`,
    [accountId],
  );
  return result.rowCount ?? 0;
}
