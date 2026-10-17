import { randomUUID } from "node:crypto";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { runNightly } from "../jobs/nightly.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testPool,
} from "../test/harness.ts";
import { people, pondNamed } from "../test/people.ts";
import { COPY_LOCK_KEY, copiedBeforeDrop, researchCopyJob, writeResearchCopy } from "./copy.ts";
import { encodeDay } from "./copy-file.ts";
import { type CopyStore, memoryCopyStore } from "./copy-store.ts";
import { ensureEventPartitions, researchEventsJob } from "./partitions.ts";
import { enrolSubject, removeSubject } from "./repo.ts";
import { track } from "./track.ts";

// The research copy against the real database (ADR-029): which days are
// written, what a file carries and what it never does, the census across
// files, and what the prune does with a month whose copy is missing. Every
// test creates its months first, before anything reads or writes `events`
// (the order track.test.ts explains), in years no other test uses, and
// injects the clock: the months the test setup created for today lie ahead.

type Event = {
  at: string;
  researchId: string;
  name?: string;
  pond?: string | null;
  ageBand?: string;
  gender?: string | null;
  intent?: string | null;
  props?: unknown;
  snapshot?: unknown;
};

async function months(ctx: TestContext, ...at: string[]) {
  for (const t of at) await ensureEventPartitions(ctx.client, new Date(t));
}

async function insert(ctx: TestContext, events: Event[]) {
  for (const e of events) {
    await ctx.client.query(
      `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
       VALUES ($1, $2, $3, 'research-test', $4, $5, $6::jsonb, $7::jsonb)`,
      [
        e.at,
        e.name ?? "profile_saved",
        e.researchId,
        e.pond === undefined ? "otaniemi" : e.pond,
        e.ageBand ?? "25-29",
        JSON.stringify(
          e.snapshot === undefined
            ? {
                gender: e.gender === undefined ? "woman" : e.gender,
                fields: e.intent === null ? {} : { intent: e.intent ?? "long_term" },
              }
            : e.snapshot,
        ),
        JSON.stringify(e.props ?? { complete: true, approvedPhotos: 3 }),
      ],
    );
  }
}

/** `count` people in the study, each under a live pseudonym: the only ones the census counts. */
async function subjects(ctx: TestContext, count: number): Promise<string[]> {
  const accounts = await people(ctx.client, null, count);
  const { rows } = await ctx.client.query<{ research_id: string }>(
    `INSERT INTO research_subject (account_id, consent_version, enrolled_at)
     SELECT id, 'research-test', '2019-01-01T00:00:00Z' FROM unnest($1::uuid[]) AS id
     RETURNING research_id::text`,
    [accounts],
  );
  return rows.map((row) => row.research_id);
}

/** `count` people in the study, each with one event at `at`. */
async function each(
  ctx: TestContext,
  count: number,
  at: string,
  over: Partial<Event> = {},
): Promise<Event[]> {
  return (await subjects(ctx, count)).map((researchId) => ({ at, researchId, ...over }));
}

const view = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function read(store: { get(day: string): Promise<Uint8Array> }, day: string) {
  return parquetReadObjects({ file: view(await store.get(day)) });
}

function deps(ctx: TestContext, now: string, store: CopyStore = memoryCopyStore()) {
  return { db: ctx.client, store, now: () => new Date(now) };
}

describe("the days written", () => {
  test("one file per closed day from the oldest month's first day, each once", async ({ ctx }) => {
    await months(ctx, "2019-02-10T00:00:00Z"); // 2019_02, 2019_03
    await insert(ctx, await each(ctx, 10, "2019-02-14T10:00:00Z"));
    const store = memoryCopyStore();
    const copy = deps(ctx, "2019-03-02T02:00:00Z", store);

    const first = await writeResearchCopy(copy);
    // February's 28 days and the 1st of March; the 2nd is not over.
    expect(first).toEqual({
      skipped: 0,
      written: 29,
      rows: 10,
      released: 10,
      generalised: 0,
      dropped: 0,
      unreadable: 0,
    });
    expect([...store.files.keys()].at(0)).toBe("2019-02-01");
    expect([...store.files.keys()].at(-1)).toBe("2019-03-01");
    expect(await read(store, "2019-02-14")).toHaveLength(10);
    // A day without events is a file without rows: a missing file is a missed night.
    expect(parquetMetadata(view(await store.get("2019-02-13"))).num_rows).toBe(0n);

    const files = new Map(store.files);
    expect(await writeResearchCopy(copy)).toMatchObject({ written: 0, rows: 0 });
    expect(store.files).toEqual(files);
  });

  test("a day ends at midnight UTC, closes an hour later, and a missed night catches up in order", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    await insert(ctx, [
      ...(await each(ctx, 10, "2019-02-10T23:00:00Z")),
      ...(await each(ctx, 10, "2019-02-11T00:00:00Z")),
      ...(await each(ctx, 10, "2019-02-11T23:00:00Z")),
    ]);
    const store = memoryCopyStore();
    // Half past midnight: the 11th is over, but an event stamped 23:00 may still commit.
    expect(await writeResearchCopy(deps(ctx, "2019-02-12T00:30:00Z", store))).toMatchObject({
      written: 10,
      rows: 10,
    });
    expect(store.files.has("2019-02-11")).toBe(false);
    const tenth = await read(store, "2019-02-10");
    expect(tenth.map((r) => (r.at as Date).toISOString())).toEqual(
      Array(10).fill("2019-02-10T23:00:00.000Z"),
    );

    // The next night is missed; the one after writes the two days, the 11th first.
    const order: string[] = [];
    const watched: CopyStore = {
      ...store,
      putNew: async (day, body) => {
        order.push(day);
        return store.putNew(day, body);
      },
    };
    expect(await writeResearchCopy(deps(ctx, "2019-02-14T02:00:00Z", watched))).toMatchObject({
      written: 3,
      rows: 20,
    });
    expect(order).toEqual(["2019-02-11", "2019-02-12", "2019-02-13"]);
    const eleventh = await read(store, "2019-02-11");
    expect(eleventh.map((r) => (r.at as Date).toISOString()).sort()).toEqual([
      ...Array(10).fill("2019-02-11T00:00:00.000Z"),
      ...Array(10).fill("2019-02-11T23:00:00.000Z"),
    ]);
  });

  test("nothing before the oldest month has begun", async ({ ctx }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const store = memoryCopyStore();
    expect(await writeResearchCopy(deps(ctx, "2019-02-01T00:30:00Z", store))).toMatchObject({
      written: 0,
    });
    expect(store.files.size).toBe(0);
  });
});

describe("what a file carries", () => {
  test("the registry's values under the research_id, and never the account, the event's id, the snapshot or any text", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const pond = await pondNamed(ctx.client, "test-copy-pond");
    const accounts = await people(ctx.client, pond, 10, {
      gender: "woman",
      complete: true,
      intent: "long_term",
    });
    const { rows: subjects } = await ctx.client.query<{ research_id: string }>(
      `INSERT INTO research_subject (account_id, consent_version, enrolled_at)
       SELECT id, 'research-test', '2019-01-01T00:00:00Z' FROM unnest($1::uuid[]) AS id
       RETURNING research_id::text`,
      [accounts],
    );
    const { logger } = await captureLogger();
    const at = new Date("2019-02-14T10:15:00Z"); // 28 by the Finnish calendar
    for (const account of accounts) {
      expect(
        await track({ db: ctx.client, logger, now: () => at }, account, "profile_saved", {
          complete: true,
          approvedPhotos: 3,
        }),
      ).toEqual({ recorded: true });
    }
    const someone = subjects[0]?.research_id as string;
    await insert(ctx, [
      // Read: a stored snapshot with keys the registry dropped, which never reach the file.
      {
        at: "2019-02-14T11:00:00Z",
        researchId: someone,
        pond: "test-copy-pond",
        snapshot: {
          gender: "woman",
          fields: {
            intent: "long_term",
            languages: ["fi", "sv"],
            occupationTitle: "Secret handshake coach",
          },
          note: "a stray key",
        },
      },
      // Unreadable, each for its own reason: left out and counted.
      {
        at: "2019-02-14T12:00:00Z",
        researchId: someone,
        name: "message_sent",
        props: { text: "hello there" },
      },
      {
        at: "2019-02-14T12:00:00Z",
        researchId: someone,
        props: { complete: true, approvedPhotos: 1, note: "a private note" },
      },
      { at: "2019-02-14T12:00:00Z", researchId: someone, ageBand: "seventy" },
      { at: "2019-02-14T12:00:00Z", researchId: someone, snapshot: null },
      {
        at: "2019-02-14T12:00:00Z",
        researchId: someone,
        snapshot: { gender: "robot", fields: {} },
      },
    ]);
    const { rows: ids } = await ctx.client.query<{ id: string }>(
      "SELECT id::text FROM events WHERE at >= '2019-02-14' AND at < '2019-02-15'",
    );
    expect(ids).toHaveLength(16);

    const store = memoryCopyStore();
    const run = await writeResearchCopy(deps(ctx, "2019-02-15T02:00:00Z", store));
    expect(run).toMatchObject({ rows: 16, released: 11, dropped: 0, unreadable: 5 });
    const file = await store.get("2019-02-14");
    expect(parquetMetadata(view(file)).key_value_metadata).toEqual(
      expect.arrayContaining([{ key: "kuutti.unreadable", value: "5" }]),
    );
    const rows = await read(store, "2019-02-14");
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual({
      at: new Date("2019-02-14T10:00:00Z"),
      name: "profile_saved",
      research_id: expect.any(String),
      consent_version: "research-test",
      pond: "test-copy-pond",
      age_band: "25-29",
      gender: "woman",
      field_intent: "long_term",
      props: { approvedPhotos: 3, complete: true },
    });
    expect(new Set(rows.map((r) => r.research_id))).toEqual(
      new Set(subjects.map((s) => s.research_id)),
    );

    // Every value of every column of every file, and every file's metadata.
    let everything = "";
    for (const day of store.files.keys()) {
      const bytes = await store.get(day);
      everything += JSON.stringify(await parquetReadObjects({ file: view(bytes) }));
      everything += JSON.stringify(parquetMetadata(view(bytes)).key_value_metadata);
    }
    for (const value of [...accounts, ...ids.map((r) => r.id)]) {
      expect(everything).not.toContain(value);
    }
    for (const text of [
      "hello",
      "private note",
      "Secret",
      "languages",
      "stray",
      "robot",
      "seventy",
      "Aino",
    ]) {
      expect(everything).not.toContain(text);
    }
  });
});

describe("the census across files", () => {
  test("a value is released once the copy carries it for k, never by the live table's count", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const store = memoryCopyStore();
    const exact = { intent: "long_term" };
    await insert(ctx, [
      // The 5th: three of the exact cell and seven of another intent: released generalised.
      ...(await each(ctx, 3, "2019-02-05T10:00:00Z", exact)),
      ...(await each(ctx, 7, "2019-02-05T10:00:00Z", { intent: "casual" })),
      // The 6th: seven newcomers of the exact cell. The table now holds ten of
      // it, but the copy has released none of them exactly: generalised again.
      ...(await each(ctx, 7, "2019-02-06T10:00:00Z", exact)),
      // The 7th: ten of the exact cell on one day: released as they are.
      ...(await each(ctx, 10, "2019-02-07T10:00:00Z", exact)),
      // The 8th: one more, whom the copy's ten carry.
      ...(await each(ctx, 1, "2019-02-08T10:00:00Z", exact)),
      // The 9th: three nobody's file carries, under k at every step.
      ...(await each(ctx, 3, "2019-02-09T10:00:00Z", {
        pond: "kallio",
        gender: "man",
        intent: null,
      })),
    ]);
    const run = await writeResearchCopy(deps(ctx, "2019-02-10T02:00:00Z", store));
    expect(run).toMatchObject({ rows: 31, released: 28, generalised: 17, dropped: 3 });
    const intents = async (day: string) => (await read(store, day)).map((r) => r.field_intent);
    expect(await intents("2019-02-05")).toEqual(Array(10).fill("*"));
    expect(await intents("2019-02-06")).toEqual(Array(7).fill("*"));
    expect(await intents("2019-02-07")).toEqual(Array(10).fill("long_term"));
    expect(await intents("2019-02-08")).toEqual(["long_term"]);
    expect(await read(store, "2019-02-09")).toEqual([]);
    expect(parquetMetadata(view(await store.get("2019-02-09"))).key_value_metadata).toEqual(
      expect.arrayContaining([{ key: "kuutti.dropped", value: "3" }]),
    );
  });

  test("one person who gives, withdraws and gives the research consent ten times in a day opens nothing", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const pond = await pondNamed(ctx.client, "test-churn-pond");
    const [account] = await people(ctx.client, pond, 1, {
      gender: "woman",
      complete: true,
      intent: "long_term",
    });
    const { logger } = await captureLogger();
    const at = new Date("2019-02-14T10:15:00Z");
    // The consent's own steps in this slice (identity/onboarding.ts): the
    // mapping row and the opt-in, then a withdrawal, and again: a fresh
    // pseudonym each time, ten of them in one cell, one of them live.
    for (let i = 0; i < 10; i += 1) {
      if (i > 0) expect(await removeSubject(ctx.client, account as string)).toBe(1);
      expect(await enrolSubject(ctx.client, account as string, "research-test", at)).toBe(
        "enrolled",
      );
      expect(
        await track(
          { db: ctx.client, logger, now: () => at },
          account as string,
          "research_opt_in",
          {
            sinceRegistrationD: 0,
            accountActive: true,
          },
        ),
      ).toEqual({ recorded: true });
    }
    // The next day, a profile saved under the pseudonym that is live.
    const next = new Date("2019-02-15T10:15:00Z");
    expect(
      await track({ db: ctx.client, logger, now: () => next }, account as string, "profile_saved", {
        complete: true,
        approvedPhotos: 3,
      }),
    ).toEqual({ recorded: true });

    const store = memoryCopyStore();
    const run = await writeResearchCopy(deps(ctx, "2019-02-16T02:00:00Z", store));
    // One person is one carrier, at every step of the cascade, on both days.
    expect(run).toMatchObject({ rows: 11, released: 0, dropped: 11 });
    expect(await read(store, "2019-02-14")).toEqual([]);
    expect(await read(store, "2019-02-15")).toEqual([]);
  });

  test("pseudonyms withdrawn since an earlier file count for nobody on the nights after", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const earlier = await each(ctx, 10, "2019-02-05T10:00:00Z");
    await insert(ctx, earlier);
    const store = memoryCopyStore();
    expect(await writeResearchCopy(deps(ctx, "2019-02-06T02:00:00Z", store))).toMatchObject({
      released: 10,
      generalised: 0,
    });
    // Nine of the ten withdraw; one newcomer of the same cell the next day.
    await ctx.client.query("DELETE FROM research_subject WHERE research_id = ANY($1::uuid[])", [
      earlier.slice(1).map((e) => e.researchId),
    ]);
    await insert(ctx, await each(ctx, 1, "2019-02-06T10:00:00Z"));
    expect(await writeResearchCopy(deps(ctx, "2019-02-07T02:00:00Z", store))).toMatchObject({
      written: 1,
      released: 0,
      dropped: 1,
    });
  });

  test("another writer's file stands, and is the day's for the census after it", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    await insert(ctx, await each(ctx, 1, "2019-02-02T10:00:00Z"));
    const theirs = encodeDay(
      (await subjects(ctx, 10)).map((researchId) => ({
        at: new Date("2019-02-01T10:00:00Z"),
        name: "profile_saved",
        researchId,
        consentVersion: "research-test",
        cell: {
          pond: "otaniemi",
          ageBand: "25-29",
          gender: "woman",
          fields: { intent: "long_term" },
        },
        props: { complete: true, approvedPhotos: 3 },
      })),
      { day: "2019-02-01", k: 10, dropped: 0, unreadable: 0 },
    );
    const store = memoryCopyStore();
    // It writes the 1st between this run's listing and its put.
    const racing: CopyStore = {
      ...store,
      days: async (from) => {
        const listed = await store.days(from);
        await store.putNew("2019-02-01", theirs);
        return listed;
      },
    };
    const run = await writeResearchCopy(deps(ctx, "2019-02-03T02:00:00Z", racing));
    expect(run).toMatchObject({ written: 1, released: 1 });
    expect(await store.get("2019-02-01")).toBe(theirs);
    expect((await read(store, "2019-02-02")).map((r) => r.field_intent)).toEqual(["long_term"]);
  });

  test("a prior file that cannot be read stops the run before anything is released", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    await insert(ctx, await each(ctx, 10, "2019-02-02T10:00:00Z"));
    const store = memoryCopyStore();
    store.files.set("2019-02-01", new TextEncoder().encode("not parquet"));
    await expect(writeResearchCopy(deps(ctx, "2019-02-03T02:00:00Z", store))).rejects.toThrow();
    expect([...store.files.keys()]).toEqual(["2019-02-01"]);
  });

  test("a file of a day not yet closed stops the run: no night of ours wrote it", async ({
    ctx,
  }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    await insert(ctx, await each(ctx, 1, "2019-02-02T10:00:00Z"));
    // Ten invented pseudonyms of the exact cell, for a day after the last
    // closed one: read as prior later, they would release the lone person
    // of a later day as they are.
    const planted = encodeDay(
      Array.from({ length: 10 }, () => ({
        at: new Date("2019-02-20T10:00:00Z"),
        name: "profile_saved",
        researchId: randomUUID(),
        consentVersion: "research-test",
        cell: {
          pond: "otaniemi",
          ageBand: "25-29",
          gender: "woman",
          fields: { intent: "long_term" },
        },
        props: { complete: true, approvedPhotos: 3 },
      })),
      { day: "2019-02-20", k: 10, dropped: 0, unreadable: 0 },
    );
    const store = memoryCopyStore();
    store.files.set("2019-02-20", planted);
    await expect(writeResearchCopy(deps(ctx, "2019-02-03T02:00:00Z", store))).rejects.toThrow(
      "research copy: 1 file(s) of a day not yet closed",
    );
    expect([...store.files.keys()]).toEqual(["2019-02-20"]);
  });
});

describe("two containers", () => {
  test("the second finds the lock held and leaves the night to the first", async ({ ctx }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const first = await testPool().connect();
    try {
      await first.query("BEGIN");
      await first.query("SELECT pg_advisory_xact_lock($1)", [COPY_LOCK_KEY]);
      const store = memoryCopyStore();
      expect(await writeResearchCopy(deps(ctx, "2019-02-03T02:00:00Z", store))).toEqual({
        skipped: 1,
        written: 0,
        rows: 0,
        released: 0,
        generalised: 0,
        dropped: 0,
        unreadable: 0,
      });
      expect(store.files.size).toBe(0);
    } finally {
      await first.query("ROLLBACK");
      first.release();
    }
  });
});

describe("the nightly job", () => {
  test("says what it wrote in counts, and names nobody", async ({ ctx }) => {
    await months(ctx, "2019-02-10T00:00:00Z");
    const events = await each(ctx, 10, "2019-02-02T10:00:00Z");
    await insert(ctx, events);
    const job = researchCopyJob(deps(ctx, "2019-02-03T02:00:00Z"));
    expect(job.name).toBe("research-export");
    const { logger, lines } = await captureLogger();
    await runNightly([job], logger);
    // The logger's own fields, the job's name and its counts: nothing else.
    expect(lines()).toEqual([
      {
        level: 30,
        time: expect.any(Number),
        pid: expect.any(Number),
        hostname: expect.any(String),
        msg: "nightly job done",
        job: "research-export",
        skipped: 0,
        written: 2,
        rows: 10,
        released: 10,
        generalised: 0,
        dropped: 0,
        unreadable: 0,
      },
    ]);
    const logged = JSON.stringify(lines());
    for (const e of events) expect(logged).not.toContain(e.researchId);
  });
});

// The prune of ADR-029 §6. November and December 2018 are past the retention
// on 5 March 2019 (their first days are more than ninety days old).
const PRUNE_NOW = "2019-03-05T02:00:00Z";

async function pruned(ctx: TestContext, store: CopyStore) {
  await months(ctx, "2018-11-10T00:00:00Z"); // 2018_11, 2018_12
  const { logger, lines } = await captureLogger();
  const copy = { ...deps(ctx, PRUNE_NOW, store), logger };
  const job = researchEventsJob({
    db: ctx.client,
    now: () => new Date(PRUNE_NOW),
    beforeDrop: (m) => copiedBeforeDrop(copy, m),
  });
  const result = await job.run();
  const { rows } = await ctx.client.query<{ relname: string }>(
    "SELECT relname FROM pg_class WHERE relname IN ('events_2018_11', 'events_2018_12')",
  );
  return { result, lines, left: rows.map((r) => r.relname) };
}

const errors = (lines: () => { level?: number; msg?: string; days?: number }[]) =>
  lines()
    .filter((l) => (l.level ?? 0) >= 50)
    .map((l) => (l.days === undefined ? l.msg : `${l.msg}: ${l.days}`));

describe("the prune and the copy", () => {
  test("a month goes once every day of it has its file", async ({ ctx }) => {
    const store = memoryCopyStore();
    const { result, lines, left } = await pruned(ctx, store);
    expect(result).toMatchObject({ created: 2, dropped: 2, uncopied: 0 });
    expect(left).toEqual([]);
    expect(store.files.has("2018-11-01")).toBe(true);
    expect(store.files.has("2018-12-31")).toBe(true);
    expect(errors(lines)).toEqual([]);
  });

  test("a month whose copy failed goes anyway, and its lost days are an error", async ({ ctx }) => {
    const store = memoryCopyStore();
    const down: CopyStore = {
      ...store,
      putNew: async () => {
        throw new Error("bucket down");
      },
    };
    const { result, lines, left } = await pruned(ctx, down);
    // The binding text's ninety days win over the copy (P1).
    expect(result).toMatchObject({ dropped: 2, uncopied: 61 });
    expect(left).toEqual([]);
    expect(errors(lines)).toEqual([
      "research copy failed before the prune",
      "research events dropped without their copy: 61",
    ]);
  });

  test("a bucket that cannot even be listed counts every day as lost", async ({ ctx }) => {
    const unreachable: CopyStore = {
      days: async () => {
        throw new Error("bucket down");
      },
      get: async () => {
        throw new Error("bucket down");
      },
      putNew: async () => {
        throw new Error("bucket down");
      },
    };
    const { result, lines } = await pruned(ctx, unreachable);
    expect(result).toMatchObject({ dropped: 2, uncopied: 61 });
    expect(errors(lines)).toEqual([
      "research copy failed before the prune",
      "research copy could not be listed before the prune",
      "research events dropped without their copy: 61",
    ]);
  });

  test("a night with no month to drop asks the bucket nothing", async ({ ctx }) => {
    const untouched: CopyStore = {
      days: async () => {
        throw new Error("asked");
      },
      get: async () => {
        throw new Error("asked");
      },
      putNew: async () => {
        throw new Error("asked");
      },
    };
    const { logger, lines } = await captureLogger();
    expect(await copiedBeforeDrop({ ...deps(ctx, PRUNE_NOW, untouched), logger }, [])).toBe(0);
    expect(lines()).toEqual([]);
  });
});
