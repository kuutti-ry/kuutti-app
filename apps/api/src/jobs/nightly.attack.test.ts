import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withTemporaryDatabase } from "@kuutti/db";
import { beforeAll, expect, it } from "vitest";
import { boot } from "../boot.ts";
import { attack } from "../test/attack.ts";
import { captureLogger, testConfig } from "../test/harness.ts";
import { TEST_KEY_PAIR_ID, testSigningKeys } from "../test/media.ts";
import { type NightlyJob, runNightly } from "./nightly.ts";

// The night itself (#380): runNightly runs the list boot.ts builds, one job
// after another; "Each job runs alone and its failure is logged, never thrown,
// so one broken job does not stop the others or the server" (nightly.ts), a
// line of which carries no address (CLAUDE.md, Logs); the research copy runs
// before the prune that checks it (rules/api.md), the end of suspensions
// before the counter (ADR-024 §5). And the pile of attacks on the jobs is held
// to that list: a job added to it later with no attacks fails here.

/** Every job of the night's list, and the file beside it that attacks it (none is left out). */
const PILE: Record<string, string> = {
  "sweep-sessions": "identity/sessions.attack.test.ts",
  "sweep-admin-sessions": "identity/admin-session.attack.test.ts",
  "research-export": "research/copy.attack.test.ts",
  "research-events-partitions": "research/partitions.attack.test.ts",
  "research-anonymity": "research/anonymity.attack.test.ts",
  "end-suspensions": "safety/sanctions.attack.test.ts",
  "pond-counter": "jobs/pond-counter.attack.test.ts",
  "invitation-count": "jobs/invitation-count.attack.test.ts",
  "prune-rounds": "matching/rounds.attack.test.ts",
  "reject-unreviewed-photos": "media/unreviewed-photos.attack.test.ts",
  "prune-photo-check-notes": "safety/photo-check.attack.test.ts",
  "prune-reports": "safety/reports.attack.test.ts",
  "archive-silent-conversations": "chat/archive.attack.test.ts",
  "moderate-pending-photos": "media/moderation.attack.test.ts",
  "sweep-orphaned-objects": "media/erasure.attack.test.ts",
};

/** The names of the list as boot.ts builds it, booted on a database of its own as boot.test.ts boots. */
let names: string[] = [];

beforeAll(async () => {
  names = await withTemporaryDatabase(async (url) => {
    const { logger } = await captureLogger();
    // Photos on CloudFront, the fullest list: the research copy, the look and the
    // sweep come only with a store. No S3_* key, and no job is run: nothing reaches a bucket.
    const config = testConfig({
      DATABASE_URL: url,
      MEDIA_URL_BASE: "https://api.test",
      CLOUDFRONT_KEY_PAIR_ID: TEST_KEY_PAIR_ID,
      CLOUDFRONT_SIGNING_KEY: testSigningKeys().privateKey,
    });
    const booted = await boot({ config, logger });
    await booted.pool.end();
    return booted.jobs.map((job) => job.name);
  });
}, 120_000);

it("every job of the night's list has its attacks in this pile, and the pile names no job the list lacks", () => {
  expect(Object.keys(PILE).sort()).toEqual([...names].sort());
  for (const file of Object.values(PILE)) {
    expect(existsSync(resolve(import.meta.dirname, "..", file)), file).toBe(true);
  }
});

const job = (name: string, fails = false): NightlyJob => ({
  name,
  run: async () => {
    if (fails) throw new Error(`${name} broke`);
    return { rows: 1 };
  },
});

async function night(jobs: NightlyJob[]) {
  const { logger, lines } = await captureLogger();
  await runNightly(jobs, logger);
  return lines();
}

attack("the night: a job that throws stops the jobs after it", {
  attempt: async () => {
    const lines = await night([job("first"), job("broken", true), job("last")]);
    return { lastDone: lines.some((l) => l.job === "last" && l.msg === "nightly job done") };
  },
  // The last job breaks too: no line says it was done, by right.
  control: async () => {
    const lines = await night([job("first"), job("broken", true), job("last", true)]);
    return { lastDone: lines.some((l) => l.job === "last" && l.msg === "nightly job done") };
  },
  succeeds: (seen) => expect(seen.lastDone).toBe(false),
});

const failuresOf = (lines: Awaited<ReturnType<typeof night>>, name: string) =>
  lines.filter((l) => l.job === name && l.msg === "nightly job failed" && l.level === 50).length;

attack("the night: a job's failure is not logged under its name", {
  attempt: async () => ({ failures: failuresOf(await night([job("broken", true)]), "broken") }),
  control: async () => ({ failures: failuresOf(await night([job("broken")]), "broken") }),
  succeeds: (seen) => expect(seen.failures).toBe(0),
});

const ADDRESS = "attack-person@example.test";

/** A job that fails as Postgres does on a unique e-mail, its detail quoting the value; or with `detail` as given. */
const failingOnAnAddress = (detail: unknown): NightlyJob => ({
  name: "erase",
  run: async () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint "email_key"'), {
      code: "23505",
      constraint: "email_key",
      detail,
    });
  },
});

attack("the night: a job's database error puts the address it quotes into the night's line", {
  attempt: async () => ({
    text: JSON.stringify(
      await night([failingOnAnAddress(`Key (email)=(${ADDRESS}) already exists.`)]),
    ),
  }),
  // Plant the leak after the real logger: a stricter serializer must not
  // make this detector's positive control disappear with the attack.
  control: async () => ({
    text: JSON.stringify([
      ...(await night([failingOnAnAddress({ quoted: ADDRESS })])),
      { detail: ADDRESS },
    ]),
  }),
  succeeds: (seen) => expect(seen.text).toContain(ADDRESS),
});

attack("the night: the research copy runs after the prune that drops its months", {
  attempt: () => ({ order: names }),
  control: () => ({ order: [...names].reverse() }),
  succeeds: (seen) =>
    expect(seen.order.indexOf("research-export")).toBeGreaterThan(
      seen.order.indexOf("research-events-partitions"),
    ),
});

attack("the night: the pond counter runs before the suspensions past their day end", {
  attempt: () => ({ order: names }),
  control: () => ({ order: [...names].reverse() }),
  succeeds: (seen) =>
    expect(seen.order.indexOf("pond-counter")).toBeLessThan(seen.order.indexOf("end-suspensions")),
});
