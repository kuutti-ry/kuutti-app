import { finnishHour } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * The nightly jobs run inside the API process (rules/api.md): one timer to
 * the next 04:00 in Helsinki, then every 24 hours. Each job runs alone and its
 * failure is logged, never thrown, so one broken job does not stop the others
 * or the server. Tests call `runNightly` directly; the timer is unref'd so a
 * process with nothing else to do can exit.
 */
export type NightlyJob = { name: string; run: () => Promise<Record<string, number>> };

const NIGHTLY_HOUR = 4;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Milliseconds from `now` to the next 04:00 Europe/Helsinki. */
export function msUntilNightly(now: Date): number {
  return msUntilFinnishHour(now, NIGHTLY_HOUR);
}

/** Milliseconds from `now` to the next `hour`:00 Europe/Helsinki: the night's jobs, the round's push (#102). */
export function msUntilFinnishHour(now: Date, hour: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const sinceMidnight = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  const target = hour * 3600 * 1000;
  const counted =
    target - sinceMidnight > 0 ? target - sinceMidnight : target - sinceMidnight + DAY_MS;
  // The count is the wall clock's, which a change of clocks between now and
  // then moves an hour against the real one (the last Sundays of March and
  // October): the hour the counted instant shows in Helsinki says by how
  // much. An hour the change skips (03:00 in March) keeps the count.
  const drift = (finnishHour(new Date(now.getTime() + counted)) - hour + 24) % 24;
  const corrected = drift === 1 ? counted - HOUR_MS : drift === 23 ? counted + HOUR_MS : counted;
  return corrected > 0 && finnishHour(new Date(now.getTime() + corrected)) === hour
    ? corrected
    : counted;
}

export async function runNightly(jobs: NightlyJob[], logger: Logger): Promise<void> {
  for (const job of jobs) {
    try {
      const result = await job.run();
      logger.info({ job: job.name, ...result }, "nightly job done");
    } catch (err) {
      logger.error({ job: job.name, err }, "nightly job failed");
    }
  }
}

export function scheduleNightly(
  jobs: NightlyJob[],
  logger: Logger,
  now: () => Date = () => new Date(),
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    timer = setTimeout(async () => {
      await runNightly(jobs, logger);
      arm();
    }, msUntilNightly(now()));
    timer.unref();
  };
  arm();
  logger.info({ jobs: jobs.map((j) => j.name), inMs: msUntilNightly(now()) }, "nightly jobs armed");
  return () => clearTimeout(timer);
}
