import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SEED_PONDS } from "@kuutti/db";
// biome-ignore lint/style/noRestrictedImports: a test of the bar over the synthetic population.
import { generatePopulation, POND_PLANS, writePopulation } from "@kuutti/db/demo";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { ErrorResponse, PondCounterResponse } from "@kuutti/schema";
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

const totalOf = async (ctx: TestContext, pond: string) =>
  (await read(ctx)).ponds.find((p) => p.pond.id === pond)?.verified;

const read = async (ctx: TestContext) =>
  PondCounterResponse.parse(await (await ctx.app.request("/ponds/counter")).json());

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

  test("The bar does not move with a total that moved by k", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-total", [10, 10, 10]);
    const person = await personOf(ctx, pond);
    await taken(ctx);
    const said = await askBar(ctx, person.headers);
    expect(said).toEqual({ men: 35, everyone: 30, women: 35 });
    await people(ctx.client, pond, 9, { gender: "woman" });
    await people(ctx.client, pond, 1, { complete: true, consented: true, seeks: ["man"] });
    await taken(ctx, NEXT_DAY);
    expect(await totalOf(ctx, pond)).toBe(41);
    // 40, 30 and 30 would say what the one who finished seeks, out loud.
    expect(await askBar(ctx, person.headers)).toEqual(said);
  });

  test("The bar moves once k finished profiles have come or gone", async ({ ctx }) => {
    const pond = await pondWithBands(ctx, "test-bar-moves", [10, 10, 10]);
    const person = await personOf(ctx, pond);
    const finishing = await people(ctx.client, pond, 10, {
      complete: true,
      consented: true,
      seeks: ["man"],
    });
    await ctx.client.query("UPDATE account SET state = 'registered' WHERE id = ANY($1)", [
      finishing,
    ]);
    await taken(ctx);
    const said = await askBar(ctx, person.headers);
    expect(await totalOf(ctx, pond)).toBe(41);
    const inPublic = async () => (await read(ctx)).ponds.find((p) => p.pond.id === pond);
    const before = await inPublic();

    const finish = (ids: string[]) =>
      ctx.client.query("UPDATE account SET state = 'active' WHERE id = ANY($1)", [ids]);
    await finish(finishing.slice(0, 9));
    await taken(ctx, NEXT_DAY);
    expect(await askBar(ctx, person.headers)).toEqual(said);

    await finish(finishing.slice(9));
    await taken(ctx, DAY_AFTER);
    expect(await askBar(ctx, person.headers)).toEqual({ men: 50, everyone: 25, women: 25 });
    // Nothing in public says that it moved, not even the day.
    expect(await inPublic()).toEqual(before);
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
    await ctx.client.query(
      `UPDATE preferences SET value = '["woman"]'
       WHERE field = 'seeks' AND account_id = ANY($1)`,
      [changing.slice(0, 10)],
    );
    await taken(ctx, NEXT_DAY);
    expect(await askBar(ctx, person.headers)).toEqual({ men: 25, everyone: 25, women: 50 });
    expect(await totalOf(ctx, pond)).toBe(41);
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
        `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO NOTHING`,
        [seeded.slug, seeded.nameNominative, seeded.nameInessive],
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
    expect(Object.keys(listed ?? {}).sort()).toEqual([
      "day",
      "finishing",
      "pond",
      "seeks",
      "split",
      "verified",
    ]);
  });
});

describe("the counter", () => {
  test("A pond below k publishes no number", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-nine");
    await people(ctx.client, pond, 9, { gender: "woman" });
    await taken(ctx);
    const body = await read(ctx);
    expect(body.k).toBe(10);
    expect(body.ponds.find((p) => p.pond.id === pond)).toMatchObject({
      day: null,
      verified: null,
      split: null,
      finishing: null,
    });
  });

  describe("The gender split is published only when every cell is at least k", () => {
    test.for([
      { women: 12, men: 11, nonBinary: 10, undeclared: 0, split: "published" },
      { women: 12, men: 11, nonBinary: 10, undeclared: 10, split: "published" },
      { women: 12, men: 11, nonBinary: 10, undeclared: 4, split: "hidden" },
      { women: 12, men: 11, nonBinary: 3, undeclared: 0, split: "hidden" },
      { women: 12, men: 11, nonBinary: 0, undeclared: 0, split: "hidden" },
      { women: 12, men: 0, nonBinary: 0, undeclared: 0, split: "hidden" },
    ])(
      "$women women, $men men, $nonBinary non-binary, $undeclared undeclared: the split is $split",
      async ({ women, men, nonBinary, undeclared, split }, { ctx }) => {
        const pond = await pondNamed(
          ctx.client,
          `test-counter-split-${women}-${men}-${nonBinary}-${undeclared}`,
        );
        await people(ctx.client, pond, women, { gender: "woman" });
        await people(ctx.client, pond, men, { gender: "man" });
        await people(ctx.client, pond, nonBinary, { gender: "non_binary" });
        await people(ctx.client, pond, undeclared, { gender: null });
        await taken(ctx);
        const listed = (await read(ctx)).ponds.find((p) => p.pond.id === pond);
        expect(listed?.verified).toBe(women + men + nonBinary + undeclared);
        if (split === "published") {
          expect(listed?.split).toEqual({ woman: women, man: men, nonBinary });
        } else {
          expect(listed?.split).toBeNull();
        }
      },
    );
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
      pond: expect.objectContaining({ id: pond }),
      day: "2026-10-05",
      verified: 12,
      // Everyone here declared the same: the split would say it of each of them.
      split: null,
      finishing: 0,
      seeks: null,
    });
    for (const id of [...ids, someone.accountId]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/T\d\d:\d\d/); // a day, never a time of day
    expect(text).not.toContain("Aino");
    expect(text).not.toContain("bio");
    // The same answer to a session with no pond, which a cache may not keep: it is theirs.
    const signedIn = await ctx.app.request("/ponds/counter", { headers: someone.headers });
    expect(signedIn.headers.get("cache-control")).toBe("no-store");
    expect(await signedIn.text()).toBe(text);
  });

  test("k comes from matching_config, and a larger k publishes less", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-k");
    await people(ctx.client, pond, 16, { gender: "man" });
    await taken(ctx);
    expect((await read(ctx)).ponds.find((p) => p.pond.id === pond)?.verified).toBe(16);
    await withMatchingConfig(ctx.client, { pond_counter_k: 20 });
    const body = await read(ctx);
    expect(body.k).toBe(20);
    expect(body.ponds.find((p) => p.pond.id === pond)).toMatchObject({
      day: null,
      verified: null,
      split: null,
      finishing: null,
    });
  });

  test("a k below the floor in matching_config publishes nothing more: the floor holds", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-floor");
    await people(ctx.client, pond, 3, { gender: "woman" });
    await people(ctx.client, pond, 3, { gender: "man" });
    await people(ctx.client, pond, 3, { gender: "non_binary" });
    await withMatchingConfig(ctx.client, { pond_counter_k: 1 });
    await taken(ctx);
    const body = await read(ctx);
    expect(body.k).toBe(10);
    expect(body.ponds.find((p) => p.pond.id === pond)).toMatchObject({
      verified: null,
      split: null,
      finishing: null,
    });
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
    expect(pond.verified).toEqual({ type: "integer", nullable: true, minimum: 10 });
    expect(pond.finishing).toEqual({
      type: "integer",
      nullable: true,
      minimum: 0,
      not: { type: "integer", minimum: 1, maximum: 9 },
    });
    const split = document.components.schemas.PondCounterSplit?.properties ?? {};
    for (const cell of ["woman", "man", "nonBinary"]) {
      expect(split[cell]).toEqual({ type: "integer", minimum: 10 });
    }
    // A schema without a type accepts anything, and the generated client type says `unknown`.
    const generated = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/schema/src/api.generated.ts"),
      "utf8",
    );
    expect(generated).toMatch(/finishing: number \| null;/);
    expect(generated).toMatch(/verified: number \| null;/);
  });

  test("before any figures exist every pond is listed with no number and no day", async ({
    ctx,
  }) => {
    await ctx.client.query("DELETE FROM pond_counter");
    const pond = await pondNamed(ctx.client, "test-counter-none");
    await people(ctx.client, pond, 30, { gender: "woman" });
    const body = await read(ctx);
    expect(body.ponds.find((p) => p.pond.id === pond)).toEqual({
      pond: expect.objectContaining({ id: pond }),
      day: null,
      verified: null,
      split: null,
      finishing: null,
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
