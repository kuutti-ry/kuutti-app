import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SEED_PONDS } from "@kuutti/db";
// biome-ignore lint/style/noRestrictedImports: a test of the bar over the synthetic population.
import { generatePopulation, POND_PLANS, writePopulation } from "@kuutti/db/demo";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import {
  ErrorResponse,
  moveFigures,
  POND_COUNTER_K_MIN,
  type PondCounterCounts,
  PondCounterPond,
  PondCounterResponse,
  publishCounts,
  type SeeksBands,
} from "@kuutti/schema";
import fc from "fast-check";
import { it } from "vitest";
import { createApp } from "../app.ts";
import { takeSnapshot } from "../jobs/pond-counter.ts";
import { subjectsOfPond } from "../jobs/pool.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { HOME, people, pondNamed } from "../test/people.ts";
import { POND_COUNTER_CACHE_CONTROL } from "./routes.ts";

// features/pond/counter.feature (#54, ADR-013): what the public may read, and
// what a session adds to it.

const DAY = new Date("2026-10-05T01:00:00Z");
const NEXT_DAY = new Date("2026-10-06T01:00:00Z");
const DAY_AFTER = new Date("2026-10-07T01:00:00Z");

async function taken(ctx: TestContext, at = DAY) {
  const { logger } = await captureLogger();
  await takeSnapshot({ db: ctx.client, logger, now: () => at });
}

/** A signed-in person of the pond, who stands in no band: they have no finished profile. */
async function personOf(ctx: TestContext, pond: string) {
  const person = await signedInAccount(ctx.client);
  await ctx.client.query("UPDATE account SET pond_id = $1 WHERE id = $2", [pond, person.accountId]);
  return person;
}

/** The ponds whose bar an asker hears: the caller's own at most. */
const barsHeardBy = async (ctx: TestContext, headers: Record<string, string>) =>
  PondCounterResponse.parse(
    await (await ctx.app.request("/ponds/counter", { headers })).json(),
  ).ponds.filter((entry) => entry.seeks !== null);

const askBar = async (ctx: TestContext, headers: Record<string, string>) => {
  const heard = await barsHeardBy(ctx, headers);
  expect(heard.length).toBeLessThanOrEqual(1);
  return heard[0]?.seeks ?? null;
};

async function pondWithBands(
  ctx: TestContext,
  slug: string,
  [men, everyone, women]: [number, number, number],
) {
  const pond = await pondNamed(ctx.client, slug);
  const finished = { complete: true, consented: true };
  await people(ctx.client, pond, men, { ...finished, seeks: ["man"] });
  await people(ctx.client, pond, everyone, { ...finished, seeks: ["woman", "man"] });
  await people(ctx.client, pond, women, { ...finished, seeks: ["woman"] });
  return pond;
}

const read = async (ctx: TestContext) =>
  PondCounterResponse.parse(await (await ctx.app.request("/ponds/counter")).json());

/** What the public hears of a pond. */
const inPublic = async (ctx: TestContext, pond: string) =>
  (await read(ctx)).ponds.find((p) => p.pond.id === pond);

const numberOf = async (ctx: TestContext, pond: string) => (await inPublic(ctx, pond))?.finished;

/** Long enough to count as a bio, by the rule of the profile. */
const A_BIO = "A bio that is long enough to count as one, by the rule of the profile.";

describe("the bar of whom a pond seeks (#507)", () => {
  describe("The bar is said only when every band is at least k", () => {
    test.for([
      { men: 20, everyone: 10, women: 20, bar: { men: 40, everyone: 20, women: 40 } },
      { men: 15, everyone: 15, women: 15, bar: { men: 35, everyone: 30, women: 35 } },
      { men: 20, everyone: 9, women: 20, bar: null },
      { men: 20, everyone: 0, women: 20, bar: null },
      { men: 0, everyone: 20, women: 20, bar: null },
    ])("$men, $everyone, $women: $bar", async ({ men, everyone, women, bar }, { ctx }) => {
      const pond = await pondWithBands(ctx, `test-bar-${men}-${everyone}-${women}`, [
        men,
        everyone,
        women,
      ]);
      const person = await personOf(ctx, pond);
      await taken(ctx);
      expect(await askBar(ctx, person.headers)).toEqual(bar);
    });
  });

  test("The bar does not move with a number that moved by k", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-number", [10, 10, 10]);
    const person = await personOf(ctx, pond);
    await taken(ctx);
    const said = await askBar(ctx, person.headers);
    expect(said).toEqual({ men: 35, everyone: 30, women: 35 });
    expect(await numberOf(ctx, pond)).toBe(30);
    await people(ctx.client, pond, 9, { complete: true, consented: true, seeks: ["non_binary"] });
    await people(ctx.client, pond, 1, { complete: true, consented: true, seeks: ["man"] });
    await taken(ctx, NEXT_DAY);
    expect(await numberOf(ctx, pond)).toBe(40);
    // 40, 30 and 30 would say what the one who finished seeks, out loud.
    expect(await askBar(ctx, person.headers)).toEqual(said);
  });

  test("The bar moves once k finished profiles have come or gone", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-moves", [10, 10, 10]);
    const person = await personOf(ctx, pond);
    // Everything a finished profile has, but for its bio.
    const finishing = await people(ctx.client, pond, 10, {
      complete: true,
      consented: true,
      seeks: ["man"],
      bio: "none",
    });
    await taken(ctx);
    const said = await askBar(ctx, person.headers);
    expect(said).toEqual({ men: 35, everyone: 30, women: 35 });
    const before = await inPublic(ctx, pond);
    expect(before).toMatchObject({ day: "2026-10-05", finished: 30 });

    const finish = (ids: string[]) =>
      ctx.client.query("UPDATE profile SET bio = $2 WHERE account_id = ANY($1)", [ids, A_BIO]);
    await finish(finishing.slice(0, 9));
    await taken(ctx, NEXT_DAY);
    expect(await askBar(ctx, person.headers)).toEqual(said);
    expect(await inPublic(ctx, pond)).toEqual(before);

    await finish(finishing.slice(9));
    await taken(ctx, DAY_AFTER);
    expect(await askBar(ctx, person.headers)).toEqual({ men: 50, everyone: 25, women: 25 });
    expect(await inPublic(ctx, pond)).toMatchObject({ day: "2026-10-07", finished: 40 });
  });

  test("The bar moves once k people have changed band", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-bar-change");
    const finished = { complete: true, consented: true };
    const changing = await people(ctx.client, pond, 20, { ...finished, seeks: ["man"] });
    await people(ctx.client, pond, 10, { ...finished, seeks: ["woman", "man"] });
    await people(ctx.client, pond, 10, { ...finished, seeks: ["woman"] });
    const person = await personOf(ctx, pond);
    await taken(ctx);
    expect(await askBar(ctx, person.headers)).toEqual({ men: 50, everyone: 25, women: 25 });
    const before = await inPublic(ctx, pond);
    expect(before).toMatchObject({ day: "2026-10-05", finished: 40 });
    await ctx.client.query(
      `UPDATE preferences SET value = '["woman"]'
       WHERE field = 'seeks' AND account_id = ANY($1)`,
      [changing.slice(0, 10)],
    );
    await taken(ctx, NEXT_DAY);
    expect(await askBar(ctx, person.headers)).toEqual({ men: 25, everyone: 25, women: 50 });
    // Nothing in public says that it moved, not even the day.
    expect(await inPublic(ctx, pond)).toEqual(before);
  });

  test("The bar says shares of the caller's own pond and nothing else", async ({ ctx }) => {
    const here = await pondWithBands(ctx, "test-bar-here", [20, 10, 20]);
    const there = await pondWithBands(ctx, "test-bar-there", [10, 10, 30]);
    const mine = await personOf(ctx, here);
    const theirs = await personOf(ctx, there);
    await taken(ctx);
    expect(await askBar(ctx, mine.headers)).toEqual({ men: 40, everyone: 20, women: 40 });
    expect(await askBar(ctx, theirs.headers)).toEqual({ men: 20, everyone: 20, women: 60 });

    expect((await barsHeardBy(ctx, mine.headers)).map((entry) => entry.pond.id)).toEqual([here]);
    expect((await barsHeardBy(ctx, theirs.headers)).map((entry) => entry.pond.id)).toEqual([there]);

    const response = await ctx.app.request("/ponds/counter", { headers: mine.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary") ?? "").toMatch(/\bAuthorization\b/i);
    const text = await response.text();
    expect(text).not.toContain(mine.accountId);
    expect(text).not.toMatch(/seeksMen|seeksEveryone|seeksWomen/);
  });

  test("Nobody hears a bar without a pond or without a session", async ({ ctx }) => {
    await pondWithBands(ctx, "test-bar-nobody", [20, 10, 20]);
    const nobody = await signedInAccount(ctx.client);
    await taken(ctx);
    expect(await askBar(ctx, nobody.headers)).toBeNull();
    expect(await askBar(ctx, {})).toBeNull();
  });

  test("A session that does not stand is refused, not answered as the public", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-stale", [20, 10, 20]);
    const expired = await personOf(ctx, pond);
    const revoked = await personOf(ctx, pond);
    await taken(ctx);
    await ctx.client.query(
      "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    await ctx.client.query("UPDATE session SET revoked_at = now() WHERE id = $1", [
      revoked.sessionId,
    ]);
    const refusals = [
      [{ authorization: "Bearer not-a-session" }, "unauthenticated"],
      [{ authorization: "Basic a2V5OnZhbHVl" }, "unauthenticated"],
      [{ authorization: "" }, "unauthenticated"],
      [expired.headers, "session_expired"],
      [revoked.headers, "session_revoked"],
    ] as const;
    for (const [headers, code] of refusals) {
      const response = await ctx.app.request("/ponds/counter", { headers });
      expect(response.status).toBe(401);
      expect(ErrorResponse.parse(await response.json()).error.code).toBe(code);
      expect(response.headers.get("cache-control")).not.toBe(POND_COUNTER_CACHE_CONTROL);
    }
  });

  test("a pond nobody has counted yet has no bar", async ({ ctx }) => {
    await ctx.client.query("DELETE FROM pond_counter");
    const pond = await pondNamed(ctx.client, "test-bar-uncounted");
    const person = await personOf(ctx, pond);
    expect(await askBar(ctx, person.headers)).toBeNull();
  });

  test("a row as the migration leaves it keeps its bar for a person of the pond, with no number beside it, until the next count replaces both (#581)", async ({
    ctx,
  }) => {
    const pond = await pondWithBands(ctx, "test-bar-migrated", [10, 10, 10]);
    const person = await personOf(ctx, pond);
    await taken(ctx);
    const said = await askBar(ctx, person.headers);
    expect(said).toEqual({ men: 35, everyone: 30, women: 35 });
    // Migration 0109: the old figures gone, the bands as they stood, and the number at its default.
    await ctx.client.query("UPDATE pond_counter SET finished = 0 WHERE pond_id = $1", [pond]);
    expect(await inPublic(ctx, pond)).toMatchObject({ day: null, finished: null, seeks: null });
    expect(await askBar(ctx, person.headers)).toEqual(said);

    // Zero was never said, so no step holds the row back: one more finished is one more in a band.
    await people(ctx.client, pond, 1, { complete: true, consented: true, seeks: ["man"] });
    await taken(ctx, NEXT_DAY);
    expect(await inPublic(ctx, pond)).toMatchObject({ day: "2026-10-06", finished: 31 });
    expect(await askBar(ctx, person.headers)).toEqual({ men: 40, everyone: 30, women: 30 });
  });

  test("a larger k says less, and a k below the floor no more", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-k", [12, 12, 12]);
    const person = await personOf(ctx, pond);
    await taken(ctx);
    await withMatchingConfig(ctx.client, { pond_counter_k: 13 });
    expect(await askBar(ctx, person.headers)).toBeNull();
    await withMatchingConfig(ctx.client, { pond_counter_k: 1 });
    expect(await askBar(ctx, person.headers)).not.toBeNull();
  });

  test("a failure is answered as a failure, not as a pond with no bar", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-failure", [12, 12, 12]);
    const person = await personOf(ctx, pond);
    await taken(ctx);
    await withMatchingConfig(ctx.client, { pond_counter_k: "ten" });
    const response = await ctx.app.request("/ponds/counter", { headers: person.headers });
    expect(response.status).toBe(500);
  });

  test("the demo population fills the bar, and stays out of every pool and round", {
    timeout: 60_000,
  }, async ({ ctx }) => {
    for (const seeded of SEED_PONDS) {
      await ctx.client.query(
        `INSERT INTO ponds (slug, name_nominative) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING`,
        [seeded.slug, seeded.nameNominative],
      );
    }
    const people = generatePopulation({ homes: { [HOME]: 1 } });
    await writePopulation(ctx.client, people, CONSENT_VERSIONS);
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM ponds WHERE slug = $1",
      [POND_PLANS[0]?.slug],
    );
    const pond = rows[0]?.id ?? "";
    const person = await personOf(ctx, pond);
    await taken(ctx);
    expect(await askBar(ctx, person.headers)).toEqual({ men: 35, everyone: 25, women: 40 });
    expect(await numberOf(ctx, pond)).toBe(50);
    // Nobody here is a subject, so nobody is in a pool, on a card or in a round.
    expect(await subjectsOfPond(ctx.client, pond, DAY)).toEqual([]);
  });

  test("The public counter says nothing of whom anybody seeks", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-public", [20, 10, 20]);
    const person = await personOf(ctx, pond);
    await taken(ctx);
    expect(await askBar(ctx, person.headers)).not.toBeNull();
    const text = await (await ctx.app.request("/ponds/counter")).text();
    expect(text).not.toMatch(/everyone/i);
    const { ponds } = PondCounterResponse.parse(JSON.parse(text));
    expect(ponds.filter((p) => p.seeks !== null)).toEqual([]);
    const listed = ponds.find((p) => p.pond.id === pond);
    expect(Object.keys(listed ?? {}).sort()).toEqual(["day", "finished", "pond", "seeks"]);
  });
});

describe("the counter", () => {
  test("A pond below k publishes no number", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-nine");
    await people(ctx.client, pond, 9, { complete: true });
    await taken(ctx);
    const body = await read(ctx);
    expect(body.k).toBe(10);
    expect(body.ponds.find((p) => p.pond.id === pond)).toEqual({
      pond: expect.objectContaining({ id: pond }),
      day: null,
      finished: null,
      seeks: null,
    });
  });

  test("is the same answer with a session and without: no number below k, the number at k (#581)", async ({
    ctx,
  }) => {
    const below = await pondNamed(ctx.client, "test-counter-below");
    const at = await pondNamed(ctx.client, "test-counter-at");
    await people(ctx.client, below, 9, { complete: true });
    await people(ctx.client, at, 10, { complete: true });
    const askers = [{}, (await personOf(ctx, below)).headers, (await personOf(ctx, at)).headers];
    await taken(ctx);
    for (const headers of askers) {
      const response = await ctx.app.request("/ponds/counter", { headers });
      expect(response.status).toBe(200);
      const { k, ponds } = PondCounterResponse.parse(await response.json());
      expect(k).toBe(10);
      expect(ponds.find((p) => p.pond.id === below)).toEqual({
        pond: expect.objectContaining({ id: below }),
        day: null,
        finished: null,
        seeks: null,
      });
      expect(ponds.find((p) => p.pond.id === at)).toEqual({
        pond: expect.objectContaining({ id: at }),
        day: "2026-10-05",
        finished: 10,
        seeks: null,
      });
    }
  });

  test("The counter answers without a session and names nobody", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-public");
    const ids = await people(ctx.client, pond, 12, { gender: "woman", complete: true });
    const someone = await signedInAccount(ctx.client);
    await taken(ctx);
    const response = await ctx.app.request("/ponds/counter");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(POND_COUNTER_CACHE_CONTROL);
    const text = await response.text();
    const body = PondCounterResponse.parse(JSON.parse(text));
    expect(Object.keys(body).sort()).toEqual(["k", "ponds"]);
    expect(body.ponds.find((p) => p.pond.id === pond)).toEqual({
      pond: { id: pond, slug: "test-counter-public", name: "Pond test-counter-public" },
      day: "2026-10-05",
      finished: 12,
      seeks: null,
    });
    // The tree and the case form are gone from what the public reads (#500).
    expect(text).not.toMatch(/parentId|nameInessive/);
    for (const id of [...ids, someone.accountId]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/T\d\d:\d\d/); // a day, never a time of day
    expect(text).not.toContain("Aino");
    expect(text).not.toContain("bio");
    // The same answer to a session with no pond, which a cache may not keep: it is theirs.
    const signedIn = await ctx.app.request("/ponds/counter", { headers: someone.headers });
    expect(signedIn.headers.get("cache-control")).toBe("no-store");
    expect(await signedIn.text()).toBe(text);
  });

  test("The counter says one number and nothing of gender or of a profile that is not complete", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-one-number");
    await people(ctx.client, pond, 10, { gender: "woman", complete: true });
    await people(ctx.client, pond, 10, { gender: "man", complete: true });
    await people(ctx.client, pond, 10, { gender: "woman", complete: true, bio: "none" });
    await taken(ctx);
    const text = await (await ctx.app.request("/ponds/counter")).text();
    // Every field by name: a total of thirty, a split or the ten who have not finished has no place.
    expect(
      PondCounterResponse.parse(JSON.parse(text)).ponds.find((p) => p.pond.id === pond),
    ).toEqual({
      pond: expect.objectContaining({ id: pond }),
      day: "2026-10-05",
      finished: 20,
      seeks: null,
    });
    expect(text).not.toMatch(/verified|split|finishing|wom[ae]n|\bm[ae]n\b|non.?binary|gender/i);
  });

  test("k comes from matching_config, and a larger k publishes less", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-k");
    await people(ctx.client, pond, 16, { complete: true });
    await taken(ctx);
    expect(await numberOf(ctx, pond)).toBe(16);
    await withMatchingConfig(ctx.client, { pond_counter_k: 20 });
    const body = await read(ctx);
    expect(body.k).toBe(20);
    expect(body.ponds.find((p) => p.pond.id === pond)).toMatchObject({ day: null, finished: null });
  });

  test("a k below the floor in matching_config publishes nothing more: the floor holds", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-floor");
    await people(ctx.client, pond, 9, { complete: true });
    await withMatchingConfig(ctx.client, { pond_counter_k: 1 });
    await taken(ctx);
    const body = await read(ctx);
    expect(body.k).toBe(10);
    expect(body.ponds.find((p) => p.pond.id === pond)).toMatchObject({ day: null, finished: null });
  });

  test("a failure is not answered as something a cache may keep", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { pond_counter_k: "ten" });
    const response = await ctx.app.request("/ponds/counter");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  test("the published contract holds the floor too: no number under ten, and nothing that accepts anything", () => {
    const document = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../openapi.json"), "utf8"),
    ) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
    const pond = document.components.schemas.PondCounterPond?.properties ?? {};
    expect(Object.keys(pond).sort()).toEqual(["day", "finished", "pond", "seeks"]);
    expect(pond.finished).toEqual({ type: "integer", nullable: true, minimum: 10 });
    expect(document.components.schemas.PondCounterSplit).toBeUndefined();
    // A schema without a type accepts anything, and the generated client type says `unknown`.
    const generated = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/schema/src/api.generated.ts"),
      "utf8",
    );
    expect(generated).toMatch(/finished: number \| null;/);
    expect(generated).not.toMatch(/PondCounterSplit/);
  });

  test("before any figures exist every pond is listed with no number and no day", async ({
    ctx,
  }) => {
    await ctx.client.query("DELETE FROM pond_counter");
    const pond = await pondNamed(ctx.client, "test-counter-none");
    await people(ctx.client, pond, 30, { complete: true });
    const body = await read(ctx);
    expect(body.ponds.find((p) => p.pond.id === pond)).toEqual({
      pond: expect.objectContaining({ id: pond }),
      day: null,
      finished: null,
      seeks: null,
    });
  });

  test("a browser origin is answered only from the allowlist, and caches are told the answer varies by it", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({ CORS_ALLOWED_ORIGINS: "https://kuutti.app" }),
      logger,
      db: ctx.client,
    });
    const site = await app.request("/ponds/counter", { headers: { origin: "https://kuutti.app" } });
    expect(site.headers.get("access-control-allow-origin")).toBe("https://kuutti.app");
    const other = await app.request("/ponds/counter", {
      headers: { origin: "https://scraper.example" },
    });
    expect(other.status).toBe(200);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const none = await app.request("/ponds/counter");
    // The answer is cacheable, so every form of it must say what it varies by:
    // a cache that kept the site's answer must not hand its header to another
    // origin, nor the public answer to somebody who asks with a session.
    for (const response of [site, other, none]) {
      expect(response.headers.get("cache-control")).toBe(POND_COUNTER_CACHE_CONTROL);
      expect(response.headers.get("vary") ?? "").toMatch(/\bOrigin\b/i);
      expect(response.headers.get("vary") ?? "").toMatch(/\bAuthorization\b/i);
    }
  });
});

// The two rules of packages/schema over any counts. Here because fast-check is
// this package's, and packages/schema keeps to zod (rules/schema.md).
describe("the rules over any counts (#581)", () => {
  const SEEDED = { seed: 20261104 };
  const NO_BANDS = { seeksMen: 0, seeksEveryone: 0, seeksWomen: 0 };
  /** Tonight's k, under the floor as a broken row of the config would be. */
  const anyK = fc.integer({ min: -5, max: 60 });
  const stepOf = (k: number) => Math.max(k, POND_COUNTER_K_MIN);
  /** A figure about where `n` is, or about a step from it either way, and never below zero. */
  const around = (n: number, step: number) =>
    fc.oneof(
      ...[n - step, n, n + step].map((at) =>
        fc.integer({ min: Math.max(0, at - 2), max: Math.max(0, at + 2) }),
      ),
    );
  /** Tonight's k, the row that stands, and tonight's count: on either side of a step, often. */
  const nights = anyK.chain((k) =>
    fc
      .record({
        finished: fc.nat(200),
        seeksMen: fc.nat(60),
        seeksEveryone: fc.nat(60),
        seeksWomen: fc.nat(60),
      })
      .chain((standing) =>
        fc
          .record({
            finished: around(standing.finished, stepOf(k)),
            seeksMen: around(standing.seeksMen, stepOf(k)),
            seeksEveryone: around(standing.seeksEveryone, stepOf(k)),
            seeksWomen: around(standing.seeksWomen, stepOf(k)),
          })
          .map((today) => ({ k, standing, today })),
      ),
  );
  const bandsOf = ({ seeksMen, seeksEveryone, seeksWomen }: SeeksBands) => ({
    seeksMen,
    seeksEveryone,
    seeksWomen,
  });
  /** How few people a difference of bands can speak of: those who rose, or those who fell. */
  const peopleBehind = (a: SeeksBands, b: SeeksBands) => {
    const moves = [
      b.seeksMen - a.seeksMen,
      b.seeksEveryone - a.seeksEveryone,
      b.seeksWomen - a.seeksWomen,
    ];
    const rose = moves.filter((n) => n > 0).reduce((sum, n) => sum + n, 0);
    const fell = moves.filter((n) => n < 0).reduce((sum, n) => sum - n, 0);
    return Math.max(rose, fell);
  };

  it("publishCounts says the number exactly from a k at or over the floor, and never what the contract would refuse", () => {
    // The whole column's range, and often about k itself.
    const kAndCount = anyK.chain((k) =>
      fc
        .oneof(around(Math.max(k, 0), 0), fc.integer({ min: 0, max: 2 ** 31 - 1 }))
        .map((finished) => ({ k, finished })),
    );
    fc.assert(
      fc.property(kAndCount, ({ k, finished }) => {
        const said = publishCounts({ finished, ...NO_BANDS }, k);
        expect(said).toBe(k >= POND_COUNTER_K_MIN && finished >= k ? finished : null);
        expect(PondCounterPond.shape.finished.safeParse(said).success).toBe(true);
      }),
      SEEDED,
    );
  });

  it("publishCounts fails closed on a k that is not whole and on a count that cannot be", () => {
    // Over the floor and under the count too, where only its being a fraction refuses it.
    const notWhole = fc.oneof(
      fc.double({ min: 10, max: 70, noInteger: true }),
      fc.double({ noInteger: true }),
    );
    fc.assert(
      fc.property(
        notWhole,
        fc.integer({ min: -1000, max: -1 }),
        fc.integer({ min: 70, max: 2 ** 31 - 1 }),
        (broken, negative, whole) => {
          expect(publishCounts({ finished: whole, ...NO_BANDS }, broken)).toBeNull();
          expect(publishCounts({ finished: broken, ...NO_BANDS }, 10)).toBeNull();
          expect(publishCounts({ finished: negative, ...NO_BANDS }, 10)).toBeNull();
        },
      ),
      SEEDED,
    );
  });

  it("moveFigures takes today's figures at once when none stand, or when those that stand were never said", () => {
    fc.assert(
      fc.property(nights, ({ k, standing, today }) => {
        expect(moveFigures(null, today, k)).toBe(today);
        const never: PondCounterCounts = {
          ...standing,
          finished: standing.finished % POND_COUNTER_K_MIN,
        };
        expect(moveFigures(never, today, k)).toEqual(today);
      }),
      SEEDED,
    );
  });

  it("moveFigures moves the number by at least k or not at all, and takes it once it has", () => {
    fc.assert(
      fc.property(nights, ({ k, standing, today }) => {
        fc.pre(standing.finished >= POND_COUNTER_K_MIN);
        const moved = Math.abs(today.finished - standing.finished);
        expect(moveFigures(standing, today, k).finished).toBe(
          moved >= stepOf(k) ? today.finished : standing.finished,
        );
      }),
      SEEDED,
    );
  });

  it("moveFigures moves the bands whole, by at least k people or not at all, whatever the number does", () => {
    fc.assert(
      fc.property(nights, ({ k, standing, today }) => {
        fc.pre(standing.finished >= POND_COUNTER_K_MIN);
        const far = peopleBehind(standing, today) >= stepOf(k);
        expect(bandsOf(moveFigures(standing, today, k))).toEqual(bandsOf(far ? today : standing));
      }),
      SEEDED,
    );
  });

  it("moveFigures never lets what is said move by fewer than k people, and repeats it for the same count", () => {
    fc.assert(
      fc.property(nights, ({ k, standing, today }) => {
        fc.pre(k >= POND_COUNTER_K_MIN);
        const next = moveFigures(standing, today, k);
        const before = publishCounts(standing, k);
        const after = publishCounts(next, k);
        if (before !== null && after !== null) {
          expect(after === before || Math.abs(after - before) >= k).toBe(true);
        }
        expect(publishCounts(moveFigures(next, today, k), k)).toBe(after);
      }),
      SEEDED,
    );
  });
});
