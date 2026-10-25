import { msUntilFinnishHour } from "../lib/finnish-day.ts";
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

/** Milliseconds from `now` to the next 04:00 Europe/Helsinki. */
export function msUntilNightly(now: Date): number {
  return msUntilFinnishHour(now, NIGHTLY_HOUR);
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
