import type { Queryable } from "@kuutti/db";
import { finnishDay, msUntilFinnishHour } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { asHour, matchingConfigNumber } from "../lib/matching-config.ts";
import { unopenedRoundsOf } from "../matching/index.ts";
import type { Push } from "../notifications/index.ts";

// The round's push (#102, ADR-055 §6): once a day, at round_push_hour in
// Helsinki, one push to each person whose round for the day was built and
// not yet opened, with a card that can still be shown, unless they opened no
// round in round_push_idle_days (the maintainer's of 25/10/2026: the push is
// for those who use the app, not a daily call back). It lives with the jobs
// for the round builder's reason: it reads rounds, their entries, the
// switches and the tokens across accounts. The switch, the quiet hours and
// the tokens are the notifications slice's to read (`push.round`).

export const ROUND_PUSH_HOUR_KEY = "round_push_hour";
export const ROUND_PUSH_IDLE_DAYS_KEY = "round_push_idle_days";

/** When the hour cannot be read, the timer tries again this much later. */
const RETRY_MS = 60 * 60 * 1000;
/** A run that failed is tried again this much later, at most this many times a day. */
export const RUN_RETRY_MS = 5 * 60 * 1000;
export const RUN_RETRIES = 3;

export type RoundPushDeps = { db: Queryable; logger: Logger; now: () => Date; push: Push };

/** One run: today's unopened rounds of people who still open theirs, told. */
export async function runRoundPush(
  deps: RoundPushDeps,
): Promise<{ rounds: number; pushed: number }> {
  const at = deps.now();
  const idleDays = await matchingConfigNumber(deps.db, ROUND_PUSH_IDLE_DAYS_KEY);
  // A whole number of days from 0: anything else would fail at the query's cast, or tell nobody.
  if (!Number.isInteger(idleDays) || idleDays < 0) {
    throw new Error(`matching_config ${ROUND_PUSH_IDLE_DAYS_KEY} is not a number of days`);
  }
  const accountIds = await unopenedRoundsOf(deps.db, finnishDay(at), idleDays);
  const pushed = await deps.push.round(accountIds);
  return { rounds: accountIds.length, pushed };
}

/**
 * The round's push on a timer of its own, armed as the night's is (unref'd)
 * to the next round_push_hour, read from matching_config at each arming, so a
 * new value holds from the next day. A run's failure is logged and tried again
 * RUN_RETRIES times RUN_RETRY_MS apart the same day, then left to tomorrow;
 * an hour that cannot be read is logged and tried again an hour later.
 * Nothing is ever thrown.
 */
export function scheduleRoundPush(deps: RoundPushDeps): () => void {
  // shortcut: a process that starts after round_push_hour arms for tomorrow, so a
  // deploy across the hour skips that day's push; a row of the last day told would lift it.
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  // A day is told once, whatever the timer does around the hour.
  let toldDay: string | null = null;
  // The day of the failed runs, and how many failed.
  let failed = { day: "", runs: 0 };
  const after = (ms: number, task: () => Promise<void>) => {
    if (stopped) return;
    timer = setTimeout(() => void task(), ms);
    timer.unref();
  };
  // A retry carries the day it is for, and is dropped once that day has ended.
  const run = async (retryOf?: string) => {
    const day = finnishDay(deps.now());
    if (retryOf !== undefined && retryOf !== day) {
      deps.logger.warn({ job: "round-push", day: retryOf }, "round push given up: the day ended");
    } else if (toldDay !== day) {
      try {
        const result = await runRoundPush(deps);
        toldDay = day;
        deps.logger.info({ job: "round-push", ...result }, "round push done");
      } catch (err) {
        failed = failed.day === day ? { day, runs: failed.runs + 1 } : { day, runs: 1 };
        const again = failed.runs <= RUN_RETRIES;
        deps.logger.error({ job: "round-push", err, again }, "round push failed");
        if (again) {
          after(RUN_RETRY_MS, () => run(day));
          return;
        }
      }
    }
    await arm();
  };
  const arm = async () => {
    try {
      const hour = asHour(
        ROUND_PUSH_HOUR_KEY,
        await matchingConfigNumber(deps.db, ROUND_PUSH_HOUR_KEY),
      );
      const inMs = msUntilFinnishHour(deps.now(), hour);
      after(inMs, run);
      deps.logger.info({ job: "round-push", inMs }, "round push armed");
    } catch (err) {
      deps.logger.error({ job: "round-push", err }, "round push not armed");
      after(RETRY_MS, arm);
    }
  };
  void arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
