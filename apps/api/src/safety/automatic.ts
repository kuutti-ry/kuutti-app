import { type Queryable, transaction } from "@kuutti/db";
import type { AutomaticBan, SanctionReason, SanctionRule } from "@kuutti/schema";
import { firstMessageCounts } from "../chat/index.ts";
import { lockAccountForSanction } from "../identity/index.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { cardsServedSince, othersPhotoFetchesSince } from "../media/index.ts";
import { reportersSince } from "./reports.ts";
import { applySanction } from "./sanctions.ts";

// The automatic shadow bans (#105, ADR-033): rules that take a person out of
// everyone else's sight at once when their behaviour looks like abuse, until
// a moderator confirms or reverses it. Reports by different people;
// conversations opened faster than a person writes; the same first message to
// many; and #86's velocity (ADR-041): other people's photos fetched, cards
// served and the round read faster than a person does, for the reason
// "scraping". Only ever a shadow ban, by nobody: the person
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
/** matching_config: URLs of other people's photos in the card and full sizes within the minutes (the maintainer, 21/10/2026). */
const AUTO_SHADOW_BAN_PHOTO_FETCHES_KEY = "auto_shadow_ban_photo_fetches";
const AUTO_SHADOW_BAN_PHOTO_FETCHES_MINUTES_KEY = "auto_shadow_ban_photo_fetches_minutes";
/** matching_config: different people's cards served within the minutes; 0, off, while the round bounds them. */
const AUTO_SHADOW_BAN_CARDS_SERVED_KEY = "auto_shadow_ban_cards_served";
const AUTO_SHADOW_BAN_CARDS_SERVED_MINUTES_KEY = "auto_shadow_ban_cards_served_minutes";
/** matching_config: reads of the day's round within the minutes. */
const AUTO_SHADOW_BAN_ROUND_READS_KEY = "auto_shadow_ban_round_reads";
const AUTO_SHADOW_BAN_ROUND_READS_MINUTES_KEY = "auto_shadow_ban_round_reads_minutes";
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
  photo_fetches:
    "Applied by the automatic rule on other people's photos fetched within the window; a moderator confirms or reverses it.",
  cards_served:
    "Applied by the automatic rule on cards served within the window; a moderator confirms or reverses it.",
  round_reads:
    "Applied by the automatic rule on reads of the round within the window; a moderator confirms or reverses it.",
};

/** The reason on the sanction: the velocity rules' is scraping (the maintainer, 21/10/2026), the others' other. */
const RULE_REASON: Record<SanctionRule, SanctionReason> = {
  reports: "other",
  first_messages: "other",
  same_first_message: "other",
  photo_fetches: "scraping",
  cards_served: "scraping",
  round_reads: "scraping",
};

export type RuleDeps = { db: Queryable; logger: Logger; now: () => Date };

type Met = { rule: SanctionRule; count: number; firstAt: Date };

/** A threshold of 0 switches its rule off. */
const on = (threshold: number) => threshold >= 1;

/** A rule met at `count` when it is on. */
const reaches = (count: number, threshold: number) => on(threshold) && count >= threshold;

type Standing = { erased: boolean; staff: boolean; hidden: boolean; floor: Date | null };

/**
 * What a rule asks of the person before it counts, in one statement: erased,
 * staff, already out of sight (an open shadow ban on the account, an open
 * suspension or ban on the identity), and the last lift of a shadow ban on
 * the account, after which every window starts, so a moderator's reversal
 * ends the evidence it judged.
 */
async function standingOf(db: Queryable, accountId: string): Promise<Standing | null> {
  const { rows } = await db.query<Standing>(
    `SELECT a.state = 'deleted' AS erased,
            EXISTS (SELECT 1 FROM moderator_roles r WHERE r.identity_id = a.identity_id) AS staff,
            EXISTS (SELECT 1 FROM sanction s WHERE s.lifted_at IS NULL
                     AND ((s.account_id = a.id AND s.kind = 'shadow_ban')
                          OR (s.identity_id = a.identity_id AND s.kind IN ('suspend', 'ban')))) AS hidden,
            (SELECT max(s.lifted_at) FROM sanction s
              WHERE s.account_id = a.id AND s.kind = 'shadow_ban') AS floor
       FROM account a WHERE a.id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/**
 * A check after a read (ADR-041 §2), far more frequent than one after a
 * report or an opener: `record` writes the read down first, where nothing
 * else stores it, so the last read of a burst is counted with every earlier
 * one.
 */
type ReadCheck = { record?: (at: Date) => Promise<void> };

/**
 * One check under the person's sanction lock: nothing for an erased account,
 * nothing for somebody already out of sight, and nothing applied to staff.
 *
 * A check after a read is measured first without the lock, the person's
 * standing with it, and takes the lock only when a rule is met there and
 * the person is in sight: so the request that applies a ban is the only one
 * that pays for the lock, and a ban shows in no later answer's time. The
 * count only grows until the check under the lock (the last lift only
 * narrows it), and the last request of a burst to commit is measured after
 * every earlier one, so the burst is still caught.
 */
async function underRuleLock(
  deps: RuleDeps,
  check: "reports" | "first_message" | "photo_fetch" | "round_read",
  accountId: string,
  measure: (tx: Queryable, at: Date, floor: Date | null) => Promise<Met | null>,
  read?: ReadCheck,
): Promise<void> {
  try {
    if (read) {
      const at = deps.now();
      await read.record?.(at);
      const standing = await standingOf(deps.db, accountId);
      if (!standing || standing.erased || standing.hidden) return;
      if (!(await measure(deps.db, at, standing.floor))) return;
    }
    await transaction(deps.db, async (tx) => {
      const locked = await lockAccountForSanction(tx, accountId);
      if (!locked || locked.state === "deleted") return;
      const standing = await standingOf(tx, accountId);
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
        reason: RULE_REASON[met.rule],
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

/**
 * After a URL of a photo in the card or full size was issued (#86, ADR-041):
 * other people's photos fetched faster than the app shows them. A thumb
 * never counts, so the route does not check after one.
 */
export async function checkPhotoFetches(deps: RuleDeps, accountId: string): Promise<void> {
  const measure = async (db: Queryable, at: Date, floor: Date | null): Promise<Met | null> => {
    const config = await matchingConfigNumbers(db, [
      AUTO_SHADOW_BAN_PHOTO_FETCHES_KEY,
      AUTO_SHADOW_BAN_PHOTO_FETCHES_MINUTES_KEY,
    ]);
    const threshold = config[AUTO_SHADOW_BAN_PHOTO_FETCHES_KEY];
    if (!on(threshold)) return null;
    const counted = await othersPhotoFetchesSince(
      db,
      accountId,
      since(at, config[AUTO_SHADOW_BAN_PHOTO_FETCHES_MINUTES_KEY] * MINUTE_MS, floor),
    );
    if (!counted.firstAt || !reaches(counted.count, threshold)) return null;
    return { rule: "photo_fetches", count: counted.count, firstAt: counted.firstAt };
  };
  await underRuleLock(deps, "photo_fetch", accountId, measure, {});
}

/**
 * The round's reads, in memory (ADR-041 §3, the maintainer's of 21/10/2026):
 * nothing stores a read, so nothing is erased or exported, and a restart
 * forgets them. An account keeps the times of its reads within the window,
 * at most the threshold's worth, which is all a count needs to reach it, and
 * none while the rule is off. Once a window, whether or not more reads come,
 * every account is trimmed to the window and the empty ones are dropped, so
 * a time is held two windows at most, as the limiter holds a key (ADR-026
 * §7); the timer runs only while something is kept and never holds the
 * process open.
 */
function roundReadLog(now: () => Date) {
  const reads = new Map<string, number[]>();
  let windowMs = 0;
  let sweeping = false;
  const within = (times: number[], start: number) => times.filter((t) => t > start);
  const sweepLater = () => {
    sweeping = true;
    setTimeout(sweep, windowMs).unref();
  };
  const sweep = () => {
    const start = now().getTime() - windowMs;
    for (const [accountId, times] of reads) {
      const kept = within(times, start);
      if (kept.length > 0) reads.set(accountId, kept);
      else reads.delete(accountId);
    }
    sweeping = false;
    if (reads.size > 0) sweepLater();
  };
  return {
    add(accountId: string, at: Date, window: number, keep: number) {
      windowMs = window;
      if (keep < 1) {
        reads.delete(accountId);
        return;
      }
      const kept = within(reads.get(accountId) ?? [], at.getTime() - window);
      kept.push(at.getTime());
      reads.set(accountId, kept.slice(-keep));
      if (!sweeping) sweepLater();
    },
    since(accountId: string, start: Date): number[] {
      return within(reads.get(accountId) ?? [], start.getTime());
    },
  };
}

/**
 * The check after a read of the day's round (#86, ADR-041): cards served,
 * then the reads themselves. One per app, since it holds the reads; app.ts
 * hands it to the round's routes, so the matching slice never imports
 * safety.
 */
export function roundReadRule(deps: RuleDeps): (accountId: string) => Promise<void> {
  const reads = roundReadLog(deps.now);
  return async (accountId) => {
    const measure = async (db: Queryable, at: Date, floor: Date | null): Promise<Met | null> => {
      const config = await matchingConfigNumbers(db, [
        AUTO_SHADOW_BAN_CARDS_SERVED_KEY,
        AUTO_SHADOW_BAN_CARDS_SERVED_MINUTES_KEY,
        AUTO_SHADOW_BAN_ROUND_READS_KEY,
        AUTO_SHADOW_BAN_ROUND_READS_MINUTES_KEY,
      ]);
      // The cards are the more direct evidence of what was seen, said first when both are met.
      const cards = config[AUTO_SHADOW_BAN_CARDS_SERVED_KEY];
      if (on(cards)) {
        const served = await cardsServedSince(
          db,
          accountId,
          since(at, config[AUTO_SHADOW_BAN_CARDS_SERVED_MINUTES_KEY] * MINUTE_MS, floor),
        );
        if (served.firstAt && reaches(served.count, cards)) {
          return { rule: "cards_served", count: served.count, firstAt: served.firstAt };
        }
      }
      const times = reads.since(
        accountId,
        since(at, config[AUTO_SHADOW_BAN_ROUND_READS_MINUTES_KEY] * MINUTE_MS, floor),
      );
      const first = times[0];
      if (first === undefined || !reaches(times.length, config[AUTO_SHADOW_BAN_ROUND_READS_KEY])) {
        return null;
      }
      return { rule: "round_reads", count: times.length, firstAt: new Date(first) };
    };
    await underRuleLock(deps, "round_read", accountId, measure, {
      record: async (at) => {
        const config = await matchingConfigNumbers(deps.db, [
          AUTO_SHADOW_BAN_ROUND_READS_KEY,
          AUTO_SHADOW_BAN_ROUND_READS_MINUTES_KEY,
        ]);
        reads.add(
          accountId,
          at,
          config[AUTO_SHADOW_BAN_ROUND_READS_MINUTES_KEY] * MINUTE_MS,
          config[AUTO_SHADOW_BAN_ROUND_READS_KEY],
        );
      },
    });
  };
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
