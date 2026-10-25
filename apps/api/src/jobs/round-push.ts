import type { Queryable } from "@kuutti/db";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { unopenedRoundsOf } from "../matching/index.ts";
import { dayWindow } from "../media/index.ts";
import type { Push } from "../notifications/index.ts";
import { msUntilFinnishHour } from "./nightly.ts";

// The round's push (#102, ADR-055 §6): once a day, at round_push_hour in
// Helsinki, one push to each person whose round for the day was built and
// not yet opened, with a card that can still be shown. It lives with the jobs
// for the round builder's reason: it reads rounds, their entries, the
// switches and the tokens across accounts. The switch, the quiet hours and
// the tokens are the notifications slice's to read (`push.round`).

export const ROUND_PUSH_HOUR_KEY = "round_push_hour";

/** When the hour cannot be read, the timer tries again this much later. */
const RETRY_MS = 60 * 60 * 1000;

export type RoundPushDeps = { db: Queryable; logger: Logger; now: () => Date; push: Push };

/** One run: today's unopened rounds, told. The push lives until the day ends, so tomorrow's phone is not told of a round that is gone. */
export async function runRoundPush(
  deps: RoundPushDeps,
): Promise<{ rounds: number; pushed: number }> {
  const at = deps.now();
  const accountIds = await unopenedRoundsOf(deps.db, finnishDay(at));
  const ttlSeconds = Math.max(60, Math.floor((dayWindow(at).end.getTime() - at.getTime()) / 1000));
  const pushed = await deps.push.round(accountIds, ttlSeconds);
  return { rounds: accountIds.length, pushed };
}

/**
 * The round's push on a timer of its own, armed as the night's is (unref'd)
 * to the next round_push_hour, read from matching_config at each arming, so a
 * new value holds from the next day. A run's failure, or an hour that cannot
 * be read, is logged and never thrown; the latter tries again an hour later.
 */
export function scheduleRoundPush(deps: RoundPushDeps): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  // A day is told once, whatever the timer does around the hour.
  let toldDay: string | null = null;
  const after = (ms: number, task: () => Promise<void>) => {
    if (stopped) return;
    timer = setTimeout(() => void task(), ms);
    timer.unref();
  };
  const run = async () => {
    try {
      const day = finnishDay(deps.now());
      if (toldDay !== day) {
        toldDay = day;
        deps.logger.info({ job: "round-push", ...(await runRoundPush(deps)) }, "round push done");
      }
    } catch (err) {
      deps.logger.error({ job: "round-push", err }, "round push failed");
    }
    await arm();
  };
  const arm = async () => {
    try {
      const hour = await matchingConfigNumber(deps.db, ROUND_PUSH_HOUR_KEY);
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
