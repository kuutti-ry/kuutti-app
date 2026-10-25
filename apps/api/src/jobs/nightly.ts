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
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const wait = target - sinceMidnight;
  return wait > 0 ? wait : wait + DAY_MS;
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
