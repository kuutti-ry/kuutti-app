import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool, migrate, type Queryable, withTemporaryDatabase } from "@kuutti/db";
import { GateResponse } from "@kuutti/schema";
import { it } from "vitest";
import { eraseAccount, exportAccount } from "../identity/index.ts";
import { savePreferences } from "../matching/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { countGates, GATE_LOCK_KEY, gateJob, gateOf } from "./pond-gate.ts";

// features/pond/gate.feature (#94, ADR-015): the count over a database, and
// the route a person asks about themselves. The rules are pond/gate.test.ts and
// matching/pool.test.ts.

const NIGHT_1 = new Date("2026-10-05T01:00:00Z"); // 04:00 in Helsinki
const NIGHT_2 = new Date("2026-10-06T01:00:00Z");
const NIGHT_3 = new Date("2026-10-07T01:00:00Z");
const NIGHT_4 = new Date("2026-10-08T01:00:00Z");
const NIGHT_5 = new Date("2026-10-09T01:00:00Z");

/** Women who seek women: they wait with nobody, and every two of them are in the pool of the other. */
const ALIKE: PeopleOptions = {
  gender: "woman",
  seeks: ["woman"],
  complete: true,
  consented: true,
};

async function setUp(ctx: TestContext, slug: string) {
  await withMatchingConfig(ctx.client, { gate_k: 30, majority_share_max: 0.6 });
  return pondNamed(ctx.client, slug);
}

async function counted(ctx: TestContext, at: Date, scope: { pondId?: string } = {}) {
  const { logger, lines } = await captureLogger();
  const result = await countGates({ db: ctx.client, logger, now: () => at }, scope);
  return { result, lines };
}

type Row = {
  account_id: string;
  pond_id: string;
  admitted_at: Date | null;
  place_said: number | null;
  pool_said: number;
  opened_at: Date | null;
  counted_at: Date | null;
};

const COLUMNS = "account_id, pond_id, admitted_at, place_said, pool_said, opened_at, counted_at";

const rowsOf = async (ctx: TestContext, pond: string) =>
  (
    await ctx.client.query<Row>(
      `SELECT ${COLUMNS} FROM gate WHERE pond_id = $1 ORDER BY account_id`,
      [pond],
    )
  ).rows;

const rowOf = async (ctx: TestContext, id: string | undefined) =>
  (await ctx.client.query<Row>(`SELECT ${COLUMNS} FROM gate WHERE account_id = $1`, [id])).rows[0];

async function askedBy(ctx: TestContext, accountId: string | undefined) {
  if (!accountId) throw new Error("nobody to ask as");
  const who = await signInAs(ctx.client, accountId);
  const response = await ctx.app.request("/gate", { headers: who.headers });
  return { response, gate: GateResponse.parse(await response.json()) };
}

async function put(ctx: TestContext, accountId: string | undefined, path: string, body: unknown) {
  if (!accountId) throw new Error("nobody to write as");
  const who = await signInAs(ctx.client, accountId);
  return ctx.app.request(path, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WINDOW = { min: 25, max: 40 };
/** An emptied row: neither let in nor in the line. What was said of the pool stays. */
const EMPTIED = { admitted_at: null, place_said: null, opened_at: null, counted_at: null };
/** A time of the day after the first night: people of separate calls register in the order meant. */
const at = (time: string) => new Date(`2026-10-05T${time}:00Z`);
const MEN: PeopleOptions = { ...ALIKE, gender: "man", seeks: ["woman"] };
const WOMEN: PeopleOptions = { ...ALIKE, gender: "woman", seeks: ["man"] };

describe("the gate", () => {
  test("Matching opens when the pool reaches gate_k, and stays open", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-opens");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    const others = await people(ctx.client, pond, 29, ALIKE);
    await counted(ctx, NIGHT_1);
    // Twenty-nine are there for her: said as twenty, so about ten more are needed.
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 20, opened_at: null });
    expect((await askedBy(ctx, she)).gate).toEqual({
      state: "closed",
      within: null,
      needed: 10,
      step: 10,
    });

    await people(ctx.client, pond, 1, ALIKE);
    const { result } = await counted(ctx, NIGHT_2);
    // For all thirty-one of them: each has thirty others now.
    expect(result.opened).toBe(31);
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 30, opened_at: NIGHT_2 });
    expect((await askedBy(ctx, she)).gate.state).toBe("open");

    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = ANY($1)", [
      others.slice(0, 5),
    ]);
    await counted(ctx, NIGHT_3);
    expect(await rowOf(ctx, she)).toMatchObject({ opened_at: NIGHT_2 });
    expect((await askedBy(ctx, she)).gate.state).toBe("open");
  });

  test("What a person is told is said in tens, and follows slowly", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-steps");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    await people(ctx.client, pond, 17, ALIKE);
    await counted(ctx, NIGHT_1);
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 10 });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 20 });

    await people(ctx.client, pond, 2, ALIKE);
    await counted(ctx, NIGHT_2);
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 20 });

    const [twentieth] = await people(ctx.client, pond, 1, ALIKE);
    await counted(ctx, NIGHT_3);
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 20 });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 10 });

    // The twentieth leaves again: back over the ten, and it does not show.
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [twentieth]);
    await counted(ctx, new Date(NIGHT_3.getTime() + 86_400_000));
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 10 });
  });

  test("The place in the line is said in tens", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-line");
    const men = await people(ctx.client, pond, 13, MEN);
    await people(ctx.client, pond, 1, WOMEN);
    // The first man, the woman, and a second man while the groups are equal: eleven wait.
    const { result } = await counted(ctx, NIGHT_1);
    expect(result).toMatchObject({ counted: 14, admitted: 3, waiting: 11 });
    for (const id of men.slice(2, 12)) {
      expect(await rowOf(ctx, id), id).toMatchObject({ admitted_at: null, place_said: 10 });
    }
    expect((await askedBy(ctx, men[2])).gate).toEqual({
      state: "waiting",
      within: 10,
      needed: null,
      step: 10,
    });
    // The first and the tenth in the line are told the same; the eleventh is among the next twenty.
    expect((await askedBy(ctx, men[11])).gate).toEqual((await askedBy(ctx, men[2])).gate);
    expect(await rowOf(ctx, men[12])).toMatchObject({ admitted_at: null, place_said: 20 });
    expect((await askedBy(ctx, men[12])).gate).toMatchObject({ state: "waiting", within: 20 });
  });

  test("A change of the step says nothing anew", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-step");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    const others = await people(ctx.client, pond, 20, ALIKE);
    // Of the larger group one waits, first in line; none of them is in her pool.
    const men = await people(ctx.client, pond, 3, MEN);
    await people(ctx.client, pond, 1, WOMEN);
    await counted(ctx, NIGHT_1);
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 10, step: 10 });
    expect((await askedBy(ctx, men[2])).gate).toMatchObject({
      state: "waiting",
      within: 10,
      step: 10,
    });
    // Five of hers leave: fifteen are there, less than a step away, and twenty is said still.
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = ANY($1)", [
      others.slice(0, 5),
    ]);
    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 20 });

    // The step is raised. What was said is read in twenties, by the route
    // before the next count and by the count itself: a fresh figure of
    // fifteen would say none, and with it that the pool fell below twenty.
    await withMatchingConfig(ctx.client, { waitlist_k: 20 });
    expect((await askedBy(ctx, she)).gate).toEqual({
      state: "closed",
      within: null,
      needed: 10,
      step: 20,
    });
    expect((await askedBy(ctx, men[2])).gate).toEqual({
      state: "waiting",
      within: 20,
      needed: null,
      step: 20,
    });
    await counted(ctx, NIGHT_3);
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 20 });
    expect(await rowOf(ctx, men[2])).toMatchObject({ place_said: 20 });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 10, step: 20 });

    // Lowered again, the figure stands: what was said, not the pool a person later.
    await withMatchingConfig(ctx.client, { waitlist_k: 10 });
    await counted(ctx, NIGHT_4);
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 20 });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 10, step: 10 });
    expect((await askedBy(ctx, men[2])).gate).toMatchObject({
      state: "waiting",
      within: 10,
      step: 10,
    });
  });

  test("Only a finished profile and current consents are counted", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-counted");
    // Ten who are there for each other: nine others each, which is said as none.
    // One more in any of their pools would make it ten, and show.
    const [she] = await people(ctx.client, pond, 10, ALIKE);
    // No profile at all, and so no photos.
    const [unfinished] = await people(ctx.client, pond, 1, {
      gender: "woman",
      state: "active",
      consented: true,
    });
    // Everything, but the consents are for an older wording.
    const [outdated] = await people(ctx.client, pond, 1, { ...ALIKE, consented: false });
    await ctx.client.query(
      `INSERT INTO consent (account_id, kind, version, locale_shown)
       VALUES ($1, 'terms', 'an-older-wording', 'fi'), ($1, 'privacy', 'an-older-wording', 'fi')`,
      [outdated],
    );
    const [shadow] = await people(ctx.client, pond, 1, ALIKE);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [shadow]);
    const [paused] = await people(ctx.client, pond, 1, ALIKE);
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [paused]);
    const [banned] = await people(ctx.client, pond, 1, { ...ALIKE, standing: "banned" });

    const { result } = await counted(ctx, NIGHT_1);
    expect(result).toMatchObject({ ponds: 1, counted: 11, admitted: 11, waiting: 0 });
    expect(await rowOf(ctx, she)).toMatchObject({ pool_said: 0, admitted_at: NIGHT_1 });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 30 });
    // The shadow-banned person has a gate like anybody, and the ten are in it.
    expect(await rowOf(ctx, shadow)).toMatchObject({ pool_said: 10, admitted_at: NIGHT_1 });
    expect((await askedBy(ctx, shadow)).gate).toMatchObject({ state: "closed", needed: 20 });
    for (const id of [unfinished, outdated, paused, banned]) {
      expect(await rowOf(ctx, id), id).toBeUndefined();
    }
    expect((await askedBy(ctx, unfinished)).gate.state).toBe("incomplete");
    expect((await askedBy(ctx, outdated)).gate.state).toBe("incomplete");
  });

  test("Counting twice changes nothing", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-twice");
    await people(ctx.client, pond, 4, MEN);
    await people(ctx.client, pond, 1, WOMEN);
    await people(ctx.client, pond, 12, ALIKE);
    const first = await counted(ctx, NIGHT_1);
    const rows = await rowsOf(ctx, pond);
    expect(rows).toHaveLength(17);
    // One group is the larger: some of it waits.
    expect(first.result.waiting).toBeGreaterThan(0);

    const second = await counted(ctx, new Date(NIGHT_1.getTime() + 1000));
    expect(second.result).toMatchObject({ counted: 17, admitted: 0, opened: 0 });
    expect(await rowsOf(ctx, pond)).toEqual(rows);
    // Nor on the next night, while nothing has moved.
    await counted(ctx, NIGHT_2);
    expect(await rowsOf(ctx, pond)).toEqual(rows);
  });

  test("the count says how many, never who or what they seek", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-log");
    const ids = await people(ctx.client, pond, 3, ALIKE);
    const { lines } = await counted(ctx, NIGHT_1);
    const logged = JSON.stringify(lines());
    expect(logged).toContain("pond gates counted");
    for (const id of [...ids, pond]) expect(logged).not.toContain(id);
    expect(logged).not.toMatch(/seeks|woman|"man"|non_binary/);
  });

  test("the nightly job counts every pond, and the ponds apart", async ({ ctx }) => {
    const one = await setUp(ctx, "test-gate-one");
    const two = await pondNamed(ctx.client, "test-gate-two");
    const [inOne] = await people(ctx.client, one, 5, ALIKE);
    const [inTwo] = await people(ctx.client, two, 16, ALIKE);
    const { logger } = await captureLogger();
    const job = gateJob({ db: ctx.client, logger, now: () => NIGHT_1 });
    expect(job.name).toBe("pond-gate");
    expect(await job.run()).toMatchObject({ counted: 21, admitted: 21, waiting: 0, opened: 0 });
    // Four others in one pond and fifteen in the other; taken together they would be twenty.
    expect(await rowOf(ctx, inOne)).toMatchObject({ pool_said: 0 });
    expect(await rowOf(ctx, inTwo)).toMatchObject({ pool_said: 10 });
  });

  test("nothing finer than what is said is kept", async ({ ctx }) => {
    const { rows } = await ctx.client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'gate' ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(COLUMNS.split(", ").sort());
    const pond = await setUp(ctx, "test-gate-kept");
    await people(ctx.client, pond, 13, MEN);
    await people(ctx.client, pond, 27, ALIKE);
    await counted(ctx, NIGHT_1);
    for (const row of await rowsOf(ctx, pond)) {
      expect(row.pool_said % 10, "a pool is kept in tens").toBe(0);
      expect((row.place_said ?? 0) % 10, "a place is kept in tens").toBe(0);
    }
  });
});

describe("the person's own gate", () => {
  test("A person learns where they stand the first time they ask", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-first");
    await people(ctx.client, pond, 11, ALIKE);
    await counted(ctx, NIGHT_1);
    const before = await rowsOf(ctx, pond);

    const [newcomer] = await people(ctx.client, pond, 1, ALIKE);
    expect(await rowOf(ctx, newcomer)).toBeUndefined();
    const { response, gate } = await askedBy(ctx, newcomer);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(gate).toEqual({ state: "closed", within: null, needed: 20, step: 10 });
    // No figure of anybody else has moved: the night moves those.
    expect((await rowsOf(ctx, pond)).filter((row) => row.account_id !== newcomer)).toEqual(before);
    // And asking again counts nothing again.
    const row = await rowOf(ctx, newcomer);
    await askedBy(ctx, newcomer);
    expect(await rowOf(ctx, newcomer)).toEqual(row);
  });

  test("a first ask lets nobody in on the strength of admissions that are not written", async ({
    ctx,
  }) => {
    const pond = await setUp(ctx, "test-gate-firm");
    await people(ctx.client, pond, 3, MEN);
    await people(ctx.client, pond, 3, WOMEN);
    await counted(ctx, NIGHT_1);
    // Four finish their profile on one day. Counted together all four are let in,
    // the later man after the earlier one and the women between them.
    await people(ctx.client, pond, 1, { ...WOMEN, registeredAt: at("09:00") });
    const [earlier] = await people(ctx.client, pond, 1, { ...MEN, registeredAt: at("10:00") });
    await people(ctx.client, pond, 1, { ...WOMEN, registeredAt: at("11:00") });
    const [later] = await people(ctx.client, pond, 1, { ...MEN, registeredAt: at("12:00") });
    const before = await rowsOf(ctx, pond);

    // The later one asks first. Somebody of his group stands before him and has no row.
    expect((await askedBy(ctx, later)).gate).toEqual({
      state: "pending",
      within: null,
      needed: null,
      step: 10,
    });
    expect(await rowOf(ctx, later)).toMatchObject({ account_id: later, pond_id: pond, ...EMPTIED });
    expect(await rowOf(ctx, earlier)).toBeUndefined();
    expect((await rowsOf(ctx, pond)).filter((row) => row.account_id !== later)).toEqual(before);
    // Asking again counts nothing: the row is there, and it says that the night will.
    expect((await askedBy(ctx, later)).gate.state).toBe("pending");
    expect(await rowOf(ctx, later)).toMatchObject({ account_id: later, pond_id: pond, ...EMPTIED });

    // The earlier one is first of his group, and three and three let him in as they stand.
    expect((await askedBy(ctx, earlier)).gate).toMatchObject({ state: "closed", needed: 30 });
    // Through the route the hour is that of the clock: that he is let in is what is asked.
    expect((await rowOf(ctx, earlier))?.admitted_at).toBeInstanceOf(Date);

    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, later)).toMatchObject({ admitted_at: NIGHT_2, place_said: null });
  });

  test("a first ask lets nobody in through room that a newcomer without a row would make", async ({
    ctx,
  }) => {
    const pond = await setUp(ctx, "test-gate-room");
    await people(ctx.client, pond, 3, MEN);
    await people(ctx.client, pond, 2, WOMEN);
    await counted(ctx, NIGHT_1);
    expect((await rowsOf(ctx, pond)).every((row) => row.admitted_at !== null)).toBe(true);
    // With her there would be room for him; she has not been counted.
    await people(ctx.client, pond, 1, { ...WOMEN, registeredAt: at("09:00") });
    const [he] = await people(ctx.client, pond, 1, { ...MEN, registeredAt: at("10:00") });
    expect((await askedBy(ctx, he)).gate.state).toBe("pending");
    expect(await rowOf(ctx, he)).toMatchObject({ account_id: he, pond_id: pond, ...EMPTIED });

    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, he)).toMatchObject({ admitted_at: NIGHT_2 });
  });

  test("the place of a first ask is the place as the written admissions stand", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-place");
    await people(ctx.client, pond, 6, MEN);
    await people(ctx.client, pond, 4, WOMEN);
    await counted(ctx, NIGHT_1);
    // Three women and twelve men finish their profile on one day, and nobody has asked.
    await people(ctx.client, pond, 3, { ...WOMEN, registeredAt: at("09:00") });
    const men = await people(ctx.client, pond, 12, { ...MEN, registeredAt: at("10:00") });

    // The last of the men asks. Counted together the women would make room for
    // four before him, and he would be eighth. None of that is written: eleven
    // stand before him.
    expect((await askedBy(ctx, men[11])).gate).toEqual({
      state: "waiting",
      within: 20,
      needed: null,
      step: 10,
    });
    expect(await rowOf(ctx, men[11])).toMatchObject({ admitted_at: null, place_said: 20 });

    // The night lets the women and four of the men in, and says his place anew.
    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, men[3])).toMatchObject({ admitted_at: NIGHT_2 });
    expect(await rowOf(ctx, men[11])).toMatchObject({ admitted_at: null, place_said: 10 });
  });

  test("a first ask reads the pond only for somebody who lives in it", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-lives");
    const other = await pondNamed(ctx.client, "test-gate-lives-not");
    await people(ctx.client, pond, 12, ALIKE);
    await counted(ctx, NIGHT_1);
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    const { logger } = await captureLogger();

    // She chooses another pond between the look of the route and the count.
    const read: number[] = [];
    const db = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("pg_try_advisory_xact_lock")) {
          await ctx.client.query("UPDATE account SET pond_id = $2 WHERE id = $1", [she, other]);
        }
        const result = await ctx.client.query(text, values);
        if (text.includes("FROM account me")) read.push(result.rows.length);
        return result;
      },
    } as unknown as Queryable;
    const gate = await gateOf({ db, logger, now: () => NIGHT_2 }, she as string);

    // The statement names her, and finds her gone: nobody of the pond she left is read.
    expect(read).toEqual([0]);
    expect(gate.state).toBe("pending");
    expect(await rowOf(ctx, she)).toBeUndefined();
  });

  test("the pool of a first ask is of the people whose admission is written", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-written");
    await people(ctx.client, pond, 9, ALIKE);
    await counted(ctx, NIGHT_1);
    // Twenty-five more finish their profile and none of them has asked.
    const newcomers = await people(ctx.client, pond, 25, ALIKE);
    const { gate } = await askedBy(ctx, newcomers[24]);
    // Nine are let in, which is said as none: the gate does not open on the other twenty-four.
    expect(gate).toEqual({ state: "closed", within: null, needed: 30, step: 10 });
    expect(await rowOf(ctx, newcomers[24])).toMatchObject({ pool_said: 0, opened_at: null });

    const { result } = await counted(ctx, NIGHT_2);
    expect(result.opened).toBe(34);
    expect((await askedBy(ctx, newcomers[24])).gate.state).toBe("open");
  });

  test("the first count says nothing of its outcome in the log", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-first-log");
    await people(ctx.client, pond, 3, MEN);
    await people(ctx.client, pond, 1, WOMEN);
    await counted(ctx, NIGHT_1);
    const [newcomer] = await people(ctx.client, pond, 1, MEN);
    const { logger, lines } = await captureLogger();
    const gate = await gateOf({ db: ctx.client, logger, now: () => NIGHT_2 }, newcomer as string);
    expect(gate.state).toBe("waiting");
    const logged = JSON.stringify(lines());
    expect(logged).toContain("pond gate counted on a first ask");
    expect(logged).not.toMatch(/waiting|admitted|opened|seeks/);
    expect(logged).not.toContain('"counted":');
    expect(logged).not.toContain(newcomer);
  });

  test("Another person's gate is never served", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-own");
    const men = await people(ctx.client, pond, 3, MEN);
    const [woman] = await people(ctx.client, pond, 1, WOMEN);
    await counted(ctx, NIGHT_1);
    const waiting = await askedBy(ctx, men[2]);
    const other = await askedBy(ctx, woman);
    expect(waiting.gate.state).toBe("waiting");
    // She is let in, and is told hers and nothing of his.
    expect(other.gate).toEqual({ state: "closed", within: null, needed: 30, step: 10 });
    // The route takes no id: there is no other gate to ask for.
    const asOther = await signInAs(ctx.client, woman as string);
    const tried = await ctx.app.request(`/gate?accountId=${men[2]}`, { headers: asOther.headers });
    expect(GateResponse.parse(await tried.json())).toEqual(other.gate);
  });

  test("the gate is not served without a session", async ({ ctx }) => {
    await setUp(ctx, "test-gate-session");
    expect((await ctx.app.request("/gate")).status).toBe(401);
    const forged = await ctx.app.request("/gate", {
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    });
    expect(forged.status).toBe(401);
  });

  test("a person without a pond or a profile is told that something is missing, and is not counted", async ({
    ctx,
  }) => {
    const pond = await setUp(ctx, "test-gate-missing");
    const [noPond] = await people(ctx.client, null, 1, { ...ALIKE });
    const [registered] = await people(ctx.client, pond, 1, { gender: "woman" });
    for (const id of [noPond, registered]) {
      expect((await askedBy(ctx, id)).gate).toEqual({
        state: "incomplete",
        within: null,
        needed: null,
        step: 10,
      });
      expect(await rowOf(ctx, id)).toBeUndefined();
    }
  });

  test("The place stays behind with the pond, and the night says the new one", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-left");
    const next = await pondNamed(ctx.client, "test-gate-next");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    await people(ctx.client, pond, 30, ALIKE);
    await people(ctx.client, next, 12, ALIKE);
    await counted(ctx, NIGHT_1);
    expect(await rowOf(ctx, she)).toMatchObject({ pond_id: pond, opened_at: NIGHT_1 });

    expect((await put(ctx, she, "/account/pond", { pondId: next })).status).toBe(204);
    expect(await rowOf(ctx, she)).toMatchObject({ account_id: she, pond_id: next, ...EMPTIED });

    // Asking counts nothing: however often she moves, she cannot put questions to the figure.
    for (const _ of [1, 2]) {
      expect((await askedBy(ctx, she)).gate).toEqual({
        state: "pending",
        within: null,
        needed: null,
        step: 10,
      });
    }
    expect(await rowOf(ctx, she)).toMatchObject({ account_id: she, pond_id: next, ...EMPTIED });

    await counted(ctx, NIGHT_2);
    // Twelve are there for her. Thirty was said in the pond she left, and the
    // figure follows from that: a whole step away, so it is said anew.
    expect(await rowOf(ctx, she)).toMatchObject({
      pond_id: next,
      admitted_at: NIGHT_2,
      pool_said: 10,
      opened_at: null,
    });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 20 });
    // Choosing the same pond again leaves the place where it is.
    const row = await rowOf(ctx, she);
    expect((await put(ctx, she, "/account/pond", { pondId: next })).status).toBe(204);
    expect(await rowOf(ctx, she)).toEqual(row);
  });

  test("a pond there and back gives no fresh figure", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-back");
    const next = await pondNamed(ctx.client, "test-gate-forth");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    const others = await people(ctx.client, pond, 10, ALIKE);
    await counted(ctx, NIGHT_1);
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 20 });
    // One leaves: nine are there, and twenty is said still.
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [others[0]]);
    await counted(ctx, NIGHT_2);
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 20 });

    // She leaves and comes back on one day. A first figure would say thirty,
    // and with it that somebody left: what was said stays with the row.
    expect((await put(ctx, she, "/account/pond", { pondId: next })).status).toBe(204);
    expect((await put(ctx, she, "/account/pond", { pondId: pond })).status).toBe(204);
    expect(await rowOf(ctx, she)).toMatchObject({ pond_id: pond, pool_said: 10, ...EMPTIED });
    await counted(ctx, NIGHT_3);
    expect(await rowOf(ctx, she)).toMatchObject({ admitted_at: NIGHT_3, pool_said: 10 });
    expect((await askedBy(ctx, she)).gate).toMatchObject({ state: "closed", needed: 20 });
  });

  test("Admission is decided anew for a person who joins a contest that waits", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-anew");
    // Women seeking men are the larger group: the contest for men is at its ratio.
    // Registered on separate days: now() is one instant for the whole test transaction.
    await people(ctx.client, pond, 6, { ...WOMEN, registeredAt: new Date("2026-09-01") });
    await people(ctx.client, pond, 4, { ...MEN, registeredAt: new Date("2026-09-02") });
    await counted(ctx, NIGHT_1);
    // She competes for nobody and is let in at once; two more women seeking men wait.
    const [alike] = await people(ctx.client, pond, 1, {
      ...ALIKE,
      registeredAt: new Date("2026-09-03"),
    });
    const [first, second] = await people(ctx.client, pond, 2, {
      ...WOMEN,
      registeredAt: new Date("2026-09-04"),
    });
    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, alike)).toMatchObject({ admitted_at: NIGHT_2 });
    expect(await rowOf(ctx, first)).toMatchObject({ admitted_at: null, place_said: 10 });
    expect(await rowOf(ctx, second)).toMatchObject({ admitted_at: null, place_said: 10 });

    // She declares that she seeks men too: a contest she was not in, and one that waits.
    const wider = { seeks: ["woman", "man"], ageWindow: WINDOW };
    expect((await put(ctx, alike, "/preferences", wider)).status).toBe(200);
    expect(await rowOf(ctx, alike)).toMatchObject({ account_id: alike, pond_id: pond, ...EMPTIED });
    expect((await askedBy(ctx, alike)).gate.state).toBe("pending");
    await counted(ctx, NIGHT_3);
    // In the line by her registration: before the two who came after her.
    expect(await rowOf(ctx, alike)).toMatchObject({ admitted_at: null, place_said: 10 });
    expect(await rowOf(ctx, first)).toMatchObject({ admitted_at: null, place_said: 10 });

    // A newcomer of the other side makes room for one: the one who registered first.
    await people(ctx.client, pond, 1, { ...MEN, registeredAt: new Date("2026-09-05") });
    await counted(ctx, NIGHT_4);
    expect(await rowOf(ctx, alike)).toMatchObject({ admitted_at: NIGHT_4 });
    expect(await rowOf(ctx, first)).toMatchObject({ admitted_at: null, place_said: 10 });
    expect(await rowOf(ctx, second)).toMatchObject({ admitted_at: null, place_said: 10 });

    // Seeking the own gender too opens no door: the contest for men is the same.
    const own = { seeks: ["woman", "man"], ageWindow: WINDOW };
    expect((await put(ctx, first, "/preferences", own)).status).toBe(200);
    expect(await rowOf(ctx, first)).toMatchObject({ admitted_at: null, place_said: 10 });
    await counted(ctx, NIGHT_5);
    expect(await rowOf(ctx, first)).toMatchObject({ admitted_at: null, place_said: 10 });
  });

  test("a change of gender that keeps the same contests is not decided anew, a wider seek that adds one is", async ({
    ctx,
  }) => {
    const pond = await setUp(ctx, "test-gate-gender");
    await people(ctx.client, pond, 6, { ...MEN, registeredAt: new Date("2026-09-01") });
    await people(ctx.client, pond, 4, { ...WOMEN, registeredAt: new Date("2026-09-02") });
    const [he] = await people(ctx.client, pond, 1, {
      ...MEN,
      registeredAt: new Date("2026-01-01"),
    });
    await counted(ctx, NIGHT_1);
    expect(await rowOf(ctx, he)).toMatchObject({ admitted_at: NIGHT_1 });
    // A non-binary person who seeks women competes with the men for women, and waits with them (#147).
    const [they] = await people(ctx.client, pond, 1, {
      ...ALIKE,
      gender: "non_binary",
      seeks: ["woman"],
      registeredAt: new Date("2026-09-03"),
    });
    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, they)).toMatchObject({ admitted_at: null, place_said: 10 });

    // Declaring themselves a man keeps the one contest they are in: nothing is taken back or given.
    expect((await put(ctx, they, "/account/gender", { gender: "man" })).status).toBe(204);
    expect(await rowOf(ctx, they)).toMatchObject({ admitted_at: null, place_said: 10 });

    // He seeks non-binary people too from now on: a contest he was not in, decided anew.
    const wider = { seeks: ["woman", "non_binary"], ageWindow: WINDOW };
    expect((await put(ctx, he, "/preferences", wider)).status).toBe(200);
    expect(await rowOf(ctx, he)).toMatchObject({ account_id: he, pond_id: pond, ...EMPTIED });
    await counted(ctx, NIGHT_3);
    // Nobody competes for non-binary people yet, and he registered before everybody: let in again.
    expect(await rowOf(ctx, he)).toMatchObject({ admitted_at: NIGHT_3 });
    // A narrower window of ages takes nothing back; whom he seeks is unchanged.
    const narrow = { seeks: ["woman", "non_binary"], ageWindow: { min: 30, max: 31 } };
    expect((await put(ctx, he, "/preferences", narrow)).status).toBe(200);
    expect(await rowOf(ctx, he)).toMatchObject({ admitted_at: NIGHT_3 });
  });

  test("a row that a change of pond or an erasure left behind is put right by the next count", async ({
    ctx,
  }) => {
    const pond = await setUp(ctx, "test-gate-behind");
    const other = await pondNamed(ctx.client, "test-gate-elsewhere");
    const [moved, gone] = await people(ctx.client, pond, 2, ALIKE);
    await counted(ctx, NIGHT_1);
    // As if the statements that see to the row had not run.
    await ctx.client.query("UPDATE account SET pond_id = $2 WHERE id = $1", [moved, other]);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', pond_id = NULL, gender = NULL WHERE id = $1",
      [gone],
    );
    await counted(ctx, NIGHT_2, { pondId: pond });
    expect(await rowsOf(ctx, pond)).toEqual([]);
    expect(await rowOf(ctx, gone)).toBeUndefined();
    // Emptied, in the pond the person lives in, for the count of that pond to decide.
    expect(await rowOf(ctx, moved)).toMatchObject({
      account_id: moved,
      pond_id: other,
      ...EMPTIED,
    });
    expect((await askedBy(ctx, moved)).gate.state).toBe("pending");
  });

  test("Erasure removes the place at the gate", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-erased");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    await people(ctx.client, pond, 9, ALIKE);
    await counted(ctx, NIGHT_1);
    expect(await rowOf(ctx, she)).toBeDefined();
    const { logger } = await captureLogger();
    await eraseAccount({ db: ctx.client, logger, now: () => NIGHT_2 }, she as string);
    expect(await rowOf(ctx, she)).toBeUndefined();
    const { rows } = await ctx.client.query("SELECT 1 FROM gate WHERE account_id = $1", [she]);
    expect(rows).toEqual([]);
    // And she is in no pool from the next count on: with her a newcomer would have ten.
    const [newcomer] = await people(ctx.client, pond, 1, ALIKE);
    await counted(ctx, NIGHT_2);
    expect(await rowOf(ctx, newcomer)).toMatchObject({ pool_said: 0 });
  });

  test("the export has the place at the gate as it is held", async ({ ctx }) => {
    const pond = await setUp(ctx, "test-gate-export");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    await people(ctx.client, pond, 14, ALIKE);
    const [waits] = (await people(ctx.client, pond, 3, MEN)).slice(2);
    await people(ctx.client, pond, 1, WOMEN);
    const { logger } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => NIGHT_2 };
    expect((await exportAccount(deps, she as string)).gate).toBeNull();

    await counted(ctx, NIGHT_1);
    expect((await exportAccount(deps, she as string)).gate).toEqual({
      pondId: pond,
      admittedAt: NIGHT_1.toISOString(),
      placeSaid: null,
      poolSaid: 10,
      openedAt: null,
      countedAt: NIGHT_1.toISOString(),
    });
    expect((await exportAccount(deps, waits as string)).gate).toMatchObject({
      admittedAt: null,
      placeSaid: 10,
      poolSaid: 0,
    });
  });

  test("gateOf counts the person alone: the rows of the others are written by the night", async ({
    ctx,
  }) => {
    const pond = await setUp(ctx, "test-gate-alone");
    const ids = await people(ctx.client, pond, 3, ALIKE);
    const { logger } = await captureLogger();
    const gate = await gateOf({ db: ctx.client, logger, now: () => NIGHT_1 }, ids[0] as string);
    expect(gate).toMatchObject({ state: "closed" });
    expect((await rowsOf(ctx, pond)).map((row) => row.account_id)).toEqual([ids[0]]);
  });
});

// A change of declaration beside the count, in sessions of their own: a pool
// and a database of its own, as for the two counts of the waitlist.
//
// Inside the harness every test is one transaction, and the lock of a count
// is the transaction's: it is held until the test is rolled back. While this
// is the only file that counts gates nothing meets it. A second file that
// does (#95) would make a first ask here find the lock held now and then and
// answer `pending`; it then needs a database of its own like the two below.
describe("a count and a change of declaration at once", () => {
  it("the count waits for the change, and writes what stands after it", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 4, applicationName: "kuutti-gates" });
      try {
        await migrate(pool, resolve(import.meta.dirname, "../../../../packages/db/drizzle"));
        await withMatchingConfig(pool, { gate_k: 30, majority_share_max: 0.6 });
        const { logger } = await captureLogger();
        const pond = await pondNamed(pool, "test-gate-parallel");
        await people(pool, pond, 6, MEN);
        await people(pool, pond, 4, WOMEN);
        // He seeks only his own gender, so he competes for nobody and is let in.
        const [he] = await people(pool, pond, 1, { ...MEN, seeks: ["man"] });
        await countGates({ db: pool, logger, now: () => NIGHT_1 });
        const row = async () =>
          (await pool.query<Row>(`SELECT ${COLUMNS} FROM gate WHERE account_id = $1`, [he]))
            .rows[0];
        expect(await row()).toMatchObject({ admitted_at: NIGHT_1 });

        // He seeks women instead, and the night begins before he has committed.
        const writer = await pool.connect();
        let count: Promise<unknown>;
        try {
          await writer.query("BEGIN");
          const back = { seeks: ["woman" as const], ageWindow: WINDOW };
          expect(await savePreferences(writer, he as string, back, NIGHT_2)).toBe(true);
          count = countGates({ db: pool, logger, now: () => NIGHT_2 });
          const waited = await Promise.race([count.then(() => "ran"), sleep(300, "waited")]);
          expect(waited).toBe("waited");
          await writer.query("COMMIT");
        } finally {
          writer.release();
        }
        await count;
        // Read before the change, the count would have found him let in and
        // written that over the emptied row. Seven competing for four is over the ratio: he waits.
        expect(await row()).toMatchObject({
          admitted_at: null,
          place_said: 10,
          opened_at: null,
          counted_at: NIGHT_2,
        });
      } finally {
        await pool.end();
      }
    });
  });

  it("a first ask that finds a count running does not wait, and counts the next time", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 4, applicationName: "kuutti-gates" });
      try {
        await migrate(pool, resolve(import.meta.dirname, "../../../../packages/db/drizzle"));
        await withMatchingConfig(pool, { gate_k: 30, majority_share_max: 0.6 });
        const { logger } = await captureLogger();
        const pond = await pondNamed(pool, "test-gate-held");
        const [she] = await people(pool, pond, 1, ALIKE);
        const deps = { db: pool, logger, now: () => NIGHT_1 };

        const counting = await pool.connect();
        try {
          await counting.query("BEGIN");
          await counting.query("SELECT pg_advisory_xact_lock($1)", [GATE_LOCK_KEY]);
          const asked = gateOf(deps, she as string);
          const answer = await Promise.race([asked, sleep(1000, "waited")]);
          expect(answer).toMatchObject({ state: "pending" });
          const { rows } = await pool.query("SELECT 1 FROM gate WHERE account_id = $1", [she]);
          expect(rows).toEqual([]);
          await counting.query("COMMIT");
        } finally {
          counting.release();
        }
        expect(await gateOf(deps, she as string)).toMatchObject({ state: "closed", needed: 30 });
      } finally {
        await pool.end();
      }
    });
  });
});
