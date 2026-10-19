import { type Queryable, transaction } from "@kuutti/db";
import type { AutomaticBan, SanctionRule } from "@kuutti/schema";
import { firstMessageCounts } from "../chat/index.ts";
import { lockAccountForSanction } from "../identity/index.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { reportersSince } from "./reports.ts";
import { applySanction } from "./sanctions.ts";

// The automatic shadow bans (#105, ADR-033): three rules that take a person
// out of everyone else's sight at once when their behaviour looks like abuse,
// until a moderator confirms or reverses it. Reports by different people;
// conversations opened faster than a person writes; the same first message to
// many. Only ever a shadow ban, by nobody, for the reason "other": the person
// learns nothing from any route, and a machine never warns, suspends or bans
// (the database's sanction_rule_check). Each check runs after the request
// that can trigger it has committed, as one transaction that first takes the
// person's sanction lock (the order an erasure and every sanction take), then
// reads, counts and applies: two triggers at once apply one ban, and a check
// never holds a row its trigger wants. A check that fails changes no answer.
// No line written here names a person: in the reports path the request is
// the reporter's, and whom they reported reaches no log line (ADR-030 §9).

/** matching_config: the reports rule, different people within days (the maintainer, 19/10/2026). */
const AUTO_SHADOW_BAN_REPORTS_KEY = "auto_shadow_ban_reports";
const AUTO_SHADOW_BAN_REPORTS_DAYS_KEY = "auto_shadow_ban_reports_days";
/** matching_config: conversations opened within the minutes. */
const AUTO_SHADOW_BAN_FIRST_MESSAGES_KEY = "auto_shadow_ban_first_messages";
const AUTO_SHADOW_BAN_FIRST_MESSAGES_MINUTES_KEY = "auto_shadow_ban_first_messages_minutes";
/** matching_config: the same first message to people within the hours. */
const AUTO_SHADOW_BAN_SAME_FIRST_MESSAGE_KEY = "auto_shadow_ban_same_first_message";
const AUTO_SHADOW_BAN_SAME_FIRST_MESSAGE_HOURS_KEY = "auto_shadow_ban_same_first_message_hours";
/** matching_config: the hours a moderator has to confirm or reverse one; past them it stays, and says late. */
export const AUTO_SHADOW_BAN_REVIEW_HOURS_KEY = "auto_shadow_ban_review_hours";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Staff's words on the sanction, fixed per rule: what applied it, never what it counted. */
const RULE_NOTE: Record<SanctionRule, string> = {
  reports:
    "Applied by the automatic rule on reports by different people; a moderator confirms or reverses it.",
  first_messages:
    "Applied by the automatic rule on first messages within the window; a moderator confirms or reverses it.",
  same_first_message:
    "Applied by the automatic rule on the same first message to several people; a moderator confirms or reverses it.",
};

export type RuleDeps = { db: Queryable; logger: Logger; now: () => Date };

type Met = { rule: SanctionRule; count: number; firstAt: Date };

/** A rule met at `count` when its threshold is at least 1; a threshold of 0 switches it off. */
const reaches = (count: number, threshold: number) => threshold >= 1 && count >= threshold;

/**
 * One check under the person's sanction lock: nothing for an erased account,
 * nothing for somebody already out of sight (an open shadow ban on the
 * account, an open suspension or ban on the identity), and nothing applied to
 * staff. Every window starts after the last lift of a shadow ban on the
 * account, so a moderator's reversal ends the evidence it judged.
 */
async function underRuleLock(
  deps: RuleDeps,
  check: "reports" | "first_message",
  accountId: string,
  measure: (tx: Queryable, at: Date, floor: Date | null) => Promise<Met | null>,
): Promise<void> {
  try {
    await transaction(deps.db, async (tx) => {
      const locked = await lockAccountForSanction(tx, accountId);
      if (!locked || locked.state === "deleted") return;
      const { rows } = await tx.query<{ staff: boolean; hidden: boolean; floor: Date | null }>(
        `SELECT EXISTS (SELECT 1 FROM moderator_roles WHERE identity_id = $2) AS staff,
                EXISTS (SELECT 1 FROM sanction WHERE lifted_at IS NULL
                         AND ((account_id = $1 AND kind = 'shadow_ban')
                              OR (identity_id = $2 AND kind IN ('suspend', 'ban')))) AS hidden,
                (SELECT max(lifted_at) FROM sanction
                  WHERE account_id = $1 AND kind = 'shadow_ban') AS floor`,
        [accountId, locked.identityId],
      );
      const standing = rows[0];
      if (!standing || standing.hidden) return;
      const at = deps.now();
      const met = await measure(tx, at, standing.floor);
      if (!met) return;
      // ADR-024 §3: staff lose the role before any sanction; a rule never applies one to them.
      if (standing.staff) {
        deps.logger.warn(
          { rule: met.rule },
          "automatic rule met by a member of staff; not applied",
        );
        return;
      }
      await applySanction(tx, {
        accountId,
        kind: "shadow_ban",
        reason: "other",
        note: RULE_NOTE[met.rule],
        actor: null,
        at,
        rule: met,
      });
      deps.logger.info({ rule: met.rule, count: met.count }, "automatic shadow ban");
    });
  } catch (error) {
    // The trigger has committed and its answer stands; the next event checks
    // again. The code and message only: a pg error's detail can quote a row.
    const { code, message } = error as { code?: string; message?: string };
    deps.logger.error({ check, code, message }, "automatic rule check failed");
  }
}

/** The later of a window's start and the last lift. */
const since = (at: Date, windowMs: number, floor: Date | null) => {
  const start = new Date(at.getTime() - windowMs);
  return floor && floor > start ? floor : start;
};

/** After a report was filed: reports by different people about the account within the days. */
export async function checkReports(deps: RuleDeps, reportedAccountId: string): Promise<void> {
  await underRuleLock(deps, "reports", reportedAccountId, async (tx, at, floor) => {
    const config = await matchingConfigNumbers(tx, [
      AUTO_SHADOW_BAN_REPORTS_KEY,
      AUTO_SHADOW_BAN_REPORTS_DAYS_KEY,
    ]);
    const counted = await reportersSince(
      tx,
      reportedAccountId,
      since(at, config[AUTO_SHADOW_BAN_REPORTS_DAYS_KEY] * DAY_MS, floor),
    );
    if (!counted.firstAt || !reaches(counted.count, config[AUTO_SHADOW_BAN_REPORTS_KEY])) {
      return null;
    }
    return { rule: "reports", count: counted.count, firstAt: counted.firstAt };
  });
}

/**
 * After a conversation's first message was sent: the same first message to
 * many people, else conversations opened faster than a person writes. The
 * chat measures; nothing of the words crosses into this slice.
 */
export async function checkFirstMessage(
  deps: RuleDeps,
  input: { accountId: string; conversationId: string },
): Promise<void> {
  await underRuleLock(deps, "first_message", input.accountId, async (tx, at, floor) => {
    const config = await matchingConfigNumbers(tx, [
      AUTO_SHADOW_BAN_FIRST_MESSAGES_KEY,
      AUTO_SHADOW_BAN_FIRST_MESSAGES_MINUTES_KEY,
      AUTO_SHADOW_BAN_SAME_FIRST_MESSAGE_KEY,
      AUTO_SHADOW_BAN_SAME_FIRST_MESSAGE_HOURS_KEY,
    ]);
    const { first, same } = await firstMessageCounts(tx, {
      ...input,
      firstSince: since(at, config[AUTO_SHADOW_BAN_FIRST_MESSAGES_MINUTES_KEY] * MINUTE_MS, floor),
      sameSince: since(at, config[AUTO_SHADOW_BAN_SAME_FIRST_MESSAGE_HOURS_KEY] * HOUR_MS, floor),
    });
    // The same opener is the more specific evidence, said first when both are met.
    if (same.firstAt && reaches(same.count, config[AUTO_SHADOW_BAN_SAME_FIRST_MESSAGE_KEY])) {
      return { rule: "same_first_message", count: same.count, firstAt: same.firstAt };
    }
    if (first.firstAt && reaches(first.count, config[AUTO_SHADOW_BAN_FIRST_MESSAGES_KEY])) {
      return { rule: "first_messages", count: first.count, firstAt: first.firstAt };
    }
    return null;
  });
}

/** The rules' shadow bans waiting for a person: neither looked at again nor lifted, never the reader's own. */
const WAITING = `s.rule IS NOT NULL AND s.reviewed_at IS NULL AND s.lifted_at IS NULL
  AND s.identity_id <> $1`;

// shortcut: one page of a hundred, oldest first; a keyset cursor like the
// audit log's (#309) once more than that wait at once.
const PAGE = 100;

/** The moderators' list (#105): the oldest first, since every one has the same deadline. */
export async function listAutomaticBans(
  db: Queryable,
  staffIdentityId: string,
): Promise<{ items: AutomaticBan[]; total: number }> {
  const { rows } = await db.query<{
    id: string;
    account_id: string;
    rule: SanctionRule;
    rule_count: number;
    rule_first_at: Date;
    created_at: Date;
  }>(
    `SELECT s.id, s.account_id, s.rule, s.rule_count, s.rule_first_at, s.created_at
       FROM sanction s WHERE ${WAITING}
      ORDER BY s.created_at, s.id
      LIMIT ${PAGE}`,
    [staffIdentityId],
  );
  const { waiting } = await automaticBanSummary(db, staffIdentityId);
  return {
    items: rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      rule: row.rule,
      count: row.rule_count,
      firstAt: row.rule_first_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    })),
    total: waiting,
  };
}

/** What waits in the list for the front page (#303): how many, and since when the oldest. */
export async function automaticBanSummary(
  db: Queryable,
  staffIdentityId: string,
): Promise<{ waiting: number; oldestSince: Date | null }> {
  const { rows } = await db.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(s.created_at) AS oldest FROM sanction s WHERE ${WAITING}`,
    [staffIdentityId],
  );
  return { waiting: rows[0]?.n ?? 0, oldestSince: rows[0]?.oldest ?? null };
}
