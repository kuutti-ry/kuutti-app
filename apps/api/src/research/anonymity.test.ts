import { randomUUID } from "node:crypto";
import { RESEARCH_K_MIN } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { captureLogger, type TestContext, test } from "../test/harness.ts";
import { anonymityCensus, researchAnonymityJob } from "./anonymity.ts";

// The census of ADR-011 §9 on real Postgres. The rows live in the test's
// transaction, so the table is empty before each test and every count is exact;
// nothing deletes them, which the table's triggers would refuse anyway.

/** pino's number for warn. */
const WARN = 40;
const POND = "census-pond";
const WOMAN_LONG_TERM = { gender: "woman", fields: { intent: "long_term" } };
const MAN_CASUAL = { gender: "man", fields: { intent: "casual" } };

/** `subjects` pseudonyms in one cell, `rowsEach` events apiece. */
async function cell(
  ctx: TestContext,
  where: { pond: string | null; ageBand: string; snapshot: unknown },
  subjects: number,
  rowsEach = 1,
) {
  for (let i = 0; i < subjects; i++) {
    const researchId = randomUUID();
    for (let j = 0; j < rowsEach; j++) {
      await ctx.client.query(
        `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
         VALUES (now(), 'profile_saved', $1, 'v1', $2, $3, $4::jsonb, '{}')`,
        [researchId, where.pond, where.ageBand, JSON.stringify(where.snapshot)],
      );
    }
  }
}

describe("the census of the research block (ADR-011 §9)", () => {
  test("counts pseudonyms per cell, not rows, and reports the cells under k", async ({ ctx }) => {
    // At k: ten people, half of them written with the snapshot's keys in the other order.
    await cell(ctx, { pond: POND, ageBand: "25-29", snapshot: WOMAN_LONG_TERM }, 5);
    await cell(
      ctx,
      {
        pond: POND,
        ageBand: "25-29",
        snapshot: { fields: { intent: "long_term" }, gender: "woman" },
      },
      5,
    );
    // Under k: three people, and one person with a dozen events.
    await cell(ctx, { pond: POND, ageBand: "25-29", snapshot: MAN_CASUAL }, 3);
    await cell(ctx, { pond: null, ageBand: "40-49", snapshot: WOMAN_LONG_TERM }, 1, 12);

    expect(await anonymityCensus(ctx.client, RESEARCH_K_MIN)).toEqual({
      cells: 3,
      small: 2,
      smallest: 1,
    });
    // A lower k would let the three through, never the one.
    expect(await anonymityCensus(ctx.client, 3)).toMatchObject({ small: 1 });
  });

  test("an empty table is a census of nothing", async ({ ctx }) => {
    expect(await anonymityCensus(ctx.client, RESEARCH_K_MIN)).toEqual({
      cells: 0,
      small: 0,
      smallest: null,
    });
  });

  test("the job says nothing while every cell holds k, then warns with counts only, never a cell's values", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const job = researchAnonymityJob({ db: ctx.client, logger });
    expect(job.name).toBe("research-anonymity");

    await cell(ctx, { pond: POND, ageBand: "30-34", snapshot: WOMAN_LONG_TERM }, RESEARCH_K_MIN);
    expect(await job.run()).toEqual({ k: RESEARCH_K_MIN, cells: 1, small: 0, smallest: 10 });
    expect(lines().filter((l) => l.level === WARN)).toEqual([]);

    await cell(ctx, { pond: POND, ageBand: "30-34", snapshot: MAN_CASUAL }, 2);
    expect(await job.run()).toEqual({ k: RESEARCH_K_MIN, cells: 2, small: 1, smallest: 2 });
    const warnings = lines().filter((l) => l.level === WARN);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      msg: "research events: cells under k",
      k: RESEARCH_K_MIN,
      cells: 2,
      small: 1,
      smallest: 2,
    });
    const text = JSON.stringify(lines());
    for (const value of [POND, "30-34", "casual", "long_term", "woman", "man"]) {
      expect(text).not.toContain(value);
    }
  });
});
