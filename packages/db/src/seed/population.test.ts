import { resolve } from "node:path";
import { bioOrPromptsComplete, Gender, PreferencesUpdate, ProfileUpdate } from "@kuutti/schema";
import { ageFromYearMonth } from "@kuutti-ry/tunnistus-oidc/hetu";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool } from "../pool.ts";
import { MATCHING_CONFIG_V1, SEED_IDENTITIES, seed } from "../seed.ts";
import { withTemporaryDatabase } from "../test/temporary-database.ts";
import {
  apportion,
  BAR_PEOPLE,
  barOf,
  DEMO_EPOCH,
  DEMO_SIZE_MAX,
  generatePopulation,
  type HomePlaces,
  plannedPonds,
  planSizes,
  type SyntheticPerson,
  summarise,
} from "./population.ts";
import { createRandom } from "./rng.ts";
import {
  DEMO_SUBJECT_PREFIX,
  demoHetuHmac,
  PLACEHOLDER_PHOTO_PREFIX,
  removePopulation,
  writePopulation,
} from "./write-population.ts";

// The synthetic population of #73 (ADR-014): the same people everywhere,
// valid against the contracts, and across the thresholds on purpose.

const MIGRATIONS = resolve(import.meta.dirname, "../..", "drizzle");
const VERSIONS = {
  terms: "test-terms-1",
  privacy: "test-privacy-1",
  special_category: "test-special-1",
};
/** A few places by the people behind them, as the API hands them in; the real list and what it keeps are tested beside it (apps/api/scripts/demo/demo-homes.test.ts). */
const HOMES: HomePlaces = { "00530": 18, "33100": 9, "20100": 6, "091": 2, "149": 1 };

describe("the random number generator", () => {
  it("gives the same numbers for the same seed, and others for another", () => {
    const draw = (seed: number) => {
      const random = createRandom(seed);
      return Array.from({ length: 8 }, () => random.next());
    };
    expect(draw(73)).toEqual(draw(73));
    expect(draw(73)).not.toEqual(draw(74));
    // Pinned to the numbers themselves: a change of the generator is a change
    // of every demo, and must fail here.
    expect(draw(73).slice(0, 3)).toEqual([
      0.7474775793962181, 0.8875488217454404, 0.9900041129440069,
    ]);
    expect(createRandom(73).int(1, 1_000_000)).toBe(747478);
    for (const x of draw(1)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("picks by weight, samples without repeating, and refuses nothing to pick from", () => {
    const random = createRandom(5);
    const seen = { a: 0, b: 0 };
    for (let i = 0; i < 2000; i += 1) seen[random.weighted({ a: 9, b: 1 })] += 1;
    expect(seen.a).toBeGreaterThan(seen.b * 5);
    const sample = random.sample([1, 2, 3, 4, 5], 3);
    expect(new Set(sample).size).toBe(3);
    expect(random.sample([1, 2], 5)).toHaveLength(2);
    expect(() => random.pick([])).toThrow();
  });
});

describe("apportion", () => {
  it("gives whole numbers in the proportions asked, summing to the total", () => {
    expect(apportion(24, { woman: 9, man: 13, non_binary: 2 })).toEqual({
      woman: 9,
      man: 13,
      non_binary: 2,
    });
    for (const total of [0, 1, 7, 96, 156, 4577]) {
      const counts = apportion(total, { a: 0.42, b: 0.5, c: 0.08 });
      expect(counts.a + counts.b + counts.c).toBe(total);
    }
  });
});

describe("the synthetic population", () => {
  const people = generatePopulation();

  it("is the same on every run, to the byte", () => {
    expect(JSON.stringify(generatePopulation())).toBe(JSON.stringify(people));
    expect(JSON.stringify(generatePopulation({ seed: 7 }))).not.toBe(JSON.stringify(people));
  });

  it("is as many people as asked, each with a label of its own", () => {
    for (const size of [1, 24, 100, 300, 1234, DEMO_SIZE_MAX]) {
      const made = generatePopulation({ size });
      expect(made).toHaveLength(size);
      expect(new Set(made.map((p) => p.label)).size).toBe(size);
      const sizes = planSizes(size);
      expect(Object.values(sizes.ponds).reduce((s, n) => s + n, 0) + sizes.neverOnboarded).toBe(
        size,
      );
    }
    expect(people[0]?.label).toBe("demo-0001");
    for (const size of [0, -1, 1.5, DEMO_SIZE_MAX + 1]) {
      expect(() => generatePopulation({ size })).toThrow();
    }
  });

  it("puts everybody who onboarded in the one pond, in the planned shares", () => {
    const ponds = summarise(people);
    // The one pond (ADR-061 §8).
    expect(ponds.suomi).toMatchObject({
      people: 276,
      woman: 88,
      man: 171,
      non_binary: 17,
    });
    expect(Object.keys(ponds)).toEqual(["suomi"]);
    expect(people.filter((p) => p.pond === null)).toHaveLength(24);
  });

  it("draws the people it plans, at any size", () => {
    for (const size of [1, 26, 100, 300, 1234]) {
      expect(summarise(generatePopulation({ size })), String(size)).toEqual(plannedPonds(size));
    }
  });

  it("passes the contracts a person's own answers pass", () => {
    for (const person of people) {
      if (person.pond === null) {
        expect(person).toMatchObject({
          state: "registered",
          home: null,
          gender: null,
          preferences: null,
          profile: null,
          consents: [],
        });
        continue;
      }
      expect(person.state).toBe("active");
      expect(Gender.safeParse(person.gender).success, person.label).toBe(true);
      expect(PreferencesUpdate.safeParse(person.preferences).success, person.label).toBe(true);
      // No research consent: the product writes it with its mapping row, and nobody here takes part.
      expect(person.consents.map((c) => c.kind)).toEqual(["terms", "privacy", "special_category"]);
      if (person.profile) {
        const { specialCategoryConsentedAt, ...document } = person.profile;
        const parsed = ProfileUpdate.safeParse(document);
        expect(parsed.success, `${person.label}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
          true,
        );
        // Stored as it would be after the API's own trim: nothing to trim.
        expect(parsed.data).toEqual(document);
        // An article 9 answer only behind the consent, given with the others (ADR-019 §4).
        if (document.fields.politics !== undefined || document.fields.religion !== undefined) {
          expect(specialCategoryConsentedAt, person.label).not.toBeNull();
        }
        if (specialCategoryConsentedAt) {
          expect(specialCategoryConsentedAt.getTime()).toBeGreaterThan(
            person.registeredAt.getTime(),
          );
          expect(specialCategoryConsentedAt.getTime()).toBeLessThanOrEqual(DEMO_EPOCH.getTime());
        }
      }
    }
  });

  it("is of age at the epoch by the product's own rule, and no date lies after the epoch", () => {
    for (const person of people) {
      const age = ageFromYearMonth(person.birthYear, person.birthMonth, DEMO_EPOCH);
      expect(age, person.label).toBeGreaterThanOrEqual(18);
      expect(age, person.label).toBeLessThanOrEqual(80);
      expect(person.registeredAt.getTime()).toBeLessThanOrEqual(DEMO_EPOCH.getTime());
      for (const consent of person.consents) {
        expect(consent.givenAt.getTime()).toBeGreaterThan(person.registeredAt.getTime());
        expect(consent.givenAt.getTime(), person.label).toBeLessThanOrEqual(DEMO_EPOCH.getTime());
      }
      if (person.preferences) {
        expect(person.preferences.ageWindow.min).toBeLessThanOrEqual(age);
        expect(person.preferences.ageWindow.max).toBeGreaterThanOrEqual(age);
      }
    }
    // Whatever the seed: a hundred of them, the one a review found (57) among them.
    for (let seed = 0; seed < 100; seed += 1) {
      for (const person of generatePopulation({ seed, size: 120 })) {
        const latest = Math.max(
          person.registeredAt.getTime(),
          ...person.consents.map((c) => c.givenAt.getTime()),
        );
        expect(latest, `seed ${seed}, ${person.label}`).toBeLessThanOrEqual(DEMO_EPOCH.getTime());
      }
    }
    // The epoch is in the past, so nothing in the database lies in the future.
    expect(DEMO_EPOCH.getTime()).toBeLessThan(Date.UTC(2026, 8, 27));
    const moved = generatePopulation({ epoch: new Date("2031-03-15T09:00:00Z") });
    expect(Math.min(...moved.map((p) => p.birthYear))).toBeGreaterThan(
      Math.min(...people.map((p) => p.birthYear)),
    );
  });

  it("fills every band of the bar, and more than k of each, from 250 people up", () => {
    const k = MATCHING_CONFIG_V1.pond_counter_k;
    for (const band of Object.values(BAR_PEOPLE)) expect(band).toBeGreaterThan(k);
    for (const size of [250, 300, 1234, DEMO_SIZE_MAX]) {
      for (let seed = 0; seed < 10; seed += 1) {
        const made = generatePopulation({ size, seed });
        expect(barOf(made), `size ${size}, seed ${seed}`).toEqual(BAR_PEOPLE);
      }
    }
    // Too small to hold them: it says how many it has, and fills what it can.
    expect(barOf(generatePopulation({ size: 40, homes: HOMES })).seeksEveryone).toBeLessThan(
      BAR_PEOPLE.seeksEveryone,
    );
  });

  it("gives the bar people who could be finished, with the terms of an older wording", () => {
    const filling = people.filter((p) => p.fillsTheBar);
    expect(filling).toHaveLength(50);
    for (const person of filling) {
      expect(person.state, person.label).toBe("active");
      const profile = person.profile;
      expect(profile, person.label).not.toBeNull();
      if (!profile) continue;
      const words = { ...profile, answeredPrompts: profile.prompts.length };
      expect(bioOrPromptsComplete(words), person.label).toBe(true);
      const older = person.consents.filter((c) => c.olderWording).map((c) => c.kind);
      expect(older, person.label).toEqual(["terms"]);
    }
    for (const person of people) {
      if (!person.fillsTheBar) {
        expect(person.consents.some((c) => c.olderWording)).toBe(false);
      }
    }
  });

  it("speaks three languages, and leaves room for what a profile can lack", () => {
    const profiles = people.flatMap((p) => (p.profile ? [p.profile] : []));
    const shown = new Set(people.flatMap((p) => p.consents.map((c) => c.localeShown)));
    expect([...shown].sort()).toEqual(["en", "fi", "sv"]);
    expect(profiles.some((p) => p.bio !== null)).toBe(true);
    expect(profiles.some((p) => p.bioPreset !== null)).toBe(true);
    expect(profiles.some((p) => p.bio === null && p.bioPreset === null)).toBe(true);
    expect(profiles.some((p) => p.prompts.length === 0)).toBe(true);
    expect(profiles.some((p) => p.prompts.length === 3)).toBe(true);
    expect(people.some((p) => p.pond !== null && p.profile === null)).toBe(true);
    expect(profiles.some((p) => /[åäöÅÄÖ]/.test(p.displayName))).toBe(true);
    // The fields of ADR-019, each answered by some and left by others.
    expect(profiles.every((p) => p.fields.intent !== undefined)).toBe(true);
    expect(profiles.some((p) => p.fields.politics !== undefined)).toBe(true);
    expect(profiles.some((p) => p.fields.religion !== undefined)).toBe(true);
    expect(profiles.some((p) => p.specialCategoryConsentedAt === null)).toBe(true);
    expect(profiles.some((p) => p.fields.hideFromField === true)).toBe(true);
    expect(profiles.some((p) => p.fields.height !== undefined)).toBe(true);
    expect(profiles.some((p) => p.fields.occupationTitle !== undefined)).toBe(true);
    expect(profiles.some((p) => p.fields.hobbies === undefined)).toBe(true);
  });
});

describe("the homes of the population", () => {
  const withoutHome = ({ home: _, ...person }: SyntheticPerson) => person;

  it("change nothing else about anybody, on any list", () => {
    for (const [size, seed] of [
      [1, 1],
      [40, 7],
      [300, 73],
      [DEMO_SIZE_MAX, 73],
    ] as const) {
      const plain = JSON.stringify(generatePopulation({ size, seed }).map(withoutHome));
      // An area takes two numbers from the stream and a municipality one, so
      // a draw from the people's own stream would move everybody after it.
      const lists: HomePlaces[] = [{ "00530": 1 }, { "091": 1 }, HOMES];
      for (const homes of lists) {
        const made = generatePopulation({ size, seed, homes });
        expect(JSON.stringify(made.map(withoutHome)), `${size}, seed ${seed}`).toBe(plain);
      }
    }
  });

  it("go to everybody with a pond and nobody else, and to nobody without the places", () => {
    // Whatever the seed, as the dates above.
    for (let seed = 0; seed < 20; seed += 1) {
      for (const person of generatePopulation({ seed, size: 120, homes: HOMES })) {
        const who = `seed ${seed}, ${person.label}`;
        expect(person.home === null, who).toBe(person.pond === null);
        if (person.home) expect(Object.keys(HOMES), who).toContain(person.home.place);
      }
    }
    const people = generatePopulation({ homes: HOMES });
    expect(new Set(people.flatMap((p) => p.home?.place ?? []))).toEqual(
      new Set(Object.keys(HOMES)),
    );
    expect(generatePopulation().every((p) => p.home === null)).toBe(true);
    expect(() => generatePopulation({ homes: {} })).toThrow("weights sum to nothing");
  });

  it("are the same for the same seed, and others for another", () => {
    const homesOf = (seed: number) =>
      generatePopulation({ seed, homes: HOMES }).map((person) => person.home);
    expect(homesOf(73)).toEqual(homesOf(73));
    expect(homesOf(7)).not.toEqual(homesOf(73));
  });

  it("fall by the people behind each place", () => {
    const people = generatePopulation({
      size: DEMO_SIZE_MAX,
      homes: { "00530": 90, "20100": 10 },
    }).flatMap((person) => person.home ?? []);
    const share = people.filter((home) => home.place === "00530").length / people.length;
    expect(share).toBeGreaterThan(0.87);
    expect(share).toBeLessThan(0.93);
  });

  it("show an area for some of those who keep one, and for nobody else", () => {
    const shown = (homes: HomePlaces) => {
      const people = generatePopulation({ size: DEMO_SIZE_MAX, homes });
      const held = people.flatMap((person) => person.home ?? []);
      return held.filter((home) => home.showsArea).length / held.length;
    };
    expect(shown({ "091": 1 })).toBe(0);
    expect(shown({ "00530": 1 })).toBeGreaterThan(0.17);
    expect(shown({ "00530": 1 })).toBeLessThan(0.23);
  });
});

describe("writing the population", () => {
  it("replaces what was there, touches nobody else, and can be taken away", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      const count = async (sql: string, values: unknown[] = []) =>
        Number((await pool.query<{ n: string }>(sql, values)).rows[0]?.n);
      const marked = () =>
        count("SELECT count(*) AS n FROM identity WHERE broker_subject LIKE $1", [
          `${DEMO_SUBJECT_PREFIX}%`,
        ]);
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
        const others = await count("SELECT count(*) AS n FROM identity");
        expect(others).toBe(SEED_IDENTITIES.length);

        const people = generatePopulation({ homes: HOMES });
        expect(await writePopulation(pool, people, VERSIONS)).toEqual({
          removed: 0,
          spared: 0,
          written: 300,
          ponds: { suomi: 276 },
        });
        expect(await marked()).toBe(300);
        // The key as it was drawn, directly: nobody here types a code (ADR-061 §2).
        const { rows: homes } = await pool.query<{
          subject: string;
          place: string | null;
          shows: boolean;
        }>(
          `SELECT i.broker_subject AS subject, a.home_place AS place, a.home_shows_area AS shows
           FROM account a JOIN identity i ON i.id = a.identity_id WHERE i.broker_subject LIKE $1`,
          [`${DEMO_SUBJECT_PREFIX}%`],
        );
        const held = new Map(homes.map((row) => [row.subject, row]));
        for (const person of people) {
          expect(held.get(`${DEMO_SUBJECT_PREFIX}${person.label}`), person.label).toMatchObject({
            place: person.home?.place ?? null,
            shows: person.home?.showsArea ?? false,
          });
        }
        expect(homes.some((row) => row.shows)).toBe(true);
        expect(await count("SELECT count(*) AS n FROM account WHERE state = 'active'")).toBe(
          276 + 1,
        );
        expect(await count("SELECT count(*) AS n FROM profile")).toBe(
          people.filter((p) => p.profile).length + 1,
        );
        expect(
          await count("SELECT count(*) AS n FROM consent WHERE version = 'test-terms-1'"),
        ).toBe(276 - 50);
        // The people of the bar, and nobody else, have a photo: two that have no picture.
        expect(
          await count("SELECT count(*) AS n FROM consent WHERE version = 'demo-older-wording'"),
        ).toBe(50);
        expect(
          await count(
            `SELECT count(*) AS n FROM photo
             WHERE state = 'approved' AND purpose = 'profile' AND key LIKE $1`,
            [`${PLACEHOLDER_PHOTO_PREFIX}%`],
          ),
        ).toBe(100);
        expect(await count("SELECT count(*) AS n FROM photo")).toBe(100);
        expect(await count("SELECT count(*) AS n FROM consent WHERE kind = 'research'")).toBe(0);
        expect(
          await count("SELECT count(*) AS n FROM consent WHERE version = 'test-special-1'"),
        ).toBe(276);
        expect(await count("SELECT count(*) AS n FROM research_subject")).toBe(0);
        // Nothing of a bank login is on a synthetic identity.
        expect(
          await count(
            `SELECT count(*) AS n FROM identity WHERE broker_subject LIKE $1
             AND (authenticated_at IS NOT NULL OR acr IS NOT NULL OR amr IS NOT NULL
                  OR broker_session_index IS NOT NULL OR broker_token_id IS NOT NULL)`,
            [`${DEMO_SUBJECT_PREFIX}%`],
          ),
        ).toBe(0);
        // The population's own people in the pond; the seed's account lives there too (ADR-010 §11) and is nobody else's to count.
        const inThePond = await pool.query<{ gender: string; n: string }>(
          `SELECT a.gender, count(*) AS n FROM account a
           JOIN ponds p ON p.id = a.pond_id JOIN identity i ON i.id = a.identity_id
           WHERE p.slug = 'suomi' AND i.broker_subject LIKE $1
           GROUP BY a.gender ORDER BY a.gender`,
          [`${DEMO_SUBJECT_PREFIX}%`],
        );
        expect(inThePond.rows).toEqual([
          { gender: "woman", n: "88" },
          { gender: "man", n: "171" },
          { gender: "non_binary", n: "17" },
        ]);
        // An article 9 answer only behind the consent row of its account (ADR-019 §4, #204): the row, never a profile column.
        expect(
          await count(
            `SELECT count(*) AS n FROM profile p
             WHERE p.fields ? 'politics'
               AND NOT EXISTS (SELECT 1 FROM consent c WHERE c.account_id = p.account_id
                               AND c.kind = 'special_category' AND c.withdrawn_at IS NULL)`,
          ),
        ).toBe(0);
        expect(
          await count("SELECT count(*) AS n FROM profile WHERE fields ? 'politics'"),
        ).toBeGreaterThan(0);
        // No code was hashed: the hash is of the label.
        const first = await pool.query<{ hetu_hmac: string }>(
          "SELECT hetu_hmac FROM identity WHERE broker_subject = $1",
          [`${DEMO_SUBJECT_PREFIX}demo-0001`],
        );
        expect(first.rows[0]?.hetu_hmac).toBe(demoHetuHmac("demo-0001"));

        // Again, smaller: what is there is what the generator says.
        const again = await writePopulation(
          pool,
          generatePopulation({ size: 100, homes: HOMES }),
          VERSIONS,
        );
        expect(again).toMatchObject({ removed: 300, spared: 0, written: 100 });
        expect(await marked()).toBe(100);
        expect(await count("SELECT count(*) AS n FROM identity")).toBe(others + 100);

        // The photo check may leave a note on a synthetic account (#253); it goes with the rest.
        await pool.query(
          `INSERT INTO photo_check_note (account_id, kind)
           SELECT a.id, 'nudity' FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject = $1`,
          [`${DEMO_SUBJECT_PREFIX}demo-0001`],
        );
        expect(await count("SELECT count(*) AS n FROM photo_check_note")).toBe(1);
        // A star between two of them goes too, or its foreign keys would stop the removal (#575).
        await pool.query(
          `INSERT INTO star (account_id, candidate_id)
           SELECT x.id, y.id FROM account x JOIN identity xi ON xi.id = x.identity_id,
                  account y JOIN identity yi ON yi.id = y.identity_id
            WHERE xi.broker_subject = $1 AND yi.broker_subject = $2`,
          [`${DEMO_SUBJECT_PREFIX}demo-0001`, `${DEMO_SUBJECT_PREFIX}demo-0002`],
        );
        expect(await count("SELECT count(*) AS n FROM star")).toBe(1);
        expect(await removePopulation(pool)).toEqual({ removed: 100, spared: 0 });
        expect(await count("SELECT count(*) AS n FROM star")).toBe(0);
        expect(await count("SELECT count(*) AS n FROM photo_check_note")).toBe(0);
        expect(await marked()).toBe(0);
        expect(await count("SELECT count(*) AS n FROM identity")).toBe(others);
        expect(await count("SELECT count(*) AS n FROM profile")).toBe(1);
        expect(await removePopulation(pool)).toEqual({ removed: 0, spared: 0 });
      } finally {
        await pool.end();
      }
    });
  });

  it("never removes somebody a login made, whatever the broker called them", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
        // As a login makes an identity: a hash of its own, and what the broker said.
        const made = async (subject: string, hash: string, authenticated: Date | null) => {
          const identity = await pool.query<{ id: string }>(
            `INSERT INTO identity (hetu_hmac, broker_subject, acr, amr, authenticated_at)
             VALUES ($1, $2, 'http://ftn.ficora.fi/2017/loatest2', ARRAY['bank'], $3) RETURNING id`,
            [hash, subject, authenticated],
          );
          const account = await pool.query<{ id: string }>(
            `INSERT INTO account (identity_id, state, birth_year, birth_month)
             VALUES ($1, 'active', 1990, 6) RETURNING id`,
            [identity.rows[0]?.id],
          );
          await pool.query(
            "INSERT INTO profile (account_id, display_name) VALUES ($1, 'Somebody')",
            [account.rows[0]?.id],
          );
          return identity.rows[0]?.id;
        };
        const at = new Date("2026-09-20T10:00:00Z");
        // A subject that begins with the mark, and one that is a synthetic label to the letter.
        const first = await made(`${DEMO_SUBJECT_PREFIX}not-synthetic`, "a".repeat(64), at);
        const second = await made(`${DEMO_SUBJECT_PREFIX}demo-0001`, "b".repeat(64), at);
        // Even the right hash is not enough next to the time of an authentication.
        const third = await made(`${DEMO_SUBJECT_PREFIX}demo-0002`, demoHetuHmac("demo-0002"), at);

        const untouched = async () =>
          (
            await pool.query<{ id: string }>(
              `SELECT i.id FROM identity i JOIN account a ON a.identity_id = i.id
               JOIN profile p ON p.account_id = a.id WHERE i.id = ANY($1)`,
              [[first, second, third]],
            )
          ).rows.length;

        expect(await removePopulation(pool)).toEqual({ removed: 0, spared: 3 });
        expect(await untouched()).toBe(3);
        // A row that holds a synthetic hash and is not synthetic stands in the
        // writer's way: it fails whole and writes nobody, rather than decide.
        await expect(
          writePopulation(pool, generatePopulation({ size: 40, homes: HOMES }), VERSIONS),
        ).rejects.toThrow(/identity_hetu_hmac_unique/);
        expect(await untouched()).toBe(3);

        // The other two, which is what a login can make, are passed by.
        await pool.query(
          "DELETE FROM profile WHERE account_id IN (SELECT id FROM account WHERE identity_id = $1)",
          [third],
        );
        await pool.query("DELETE FROM account WHERE identity_id = $1", [third]);
        await pool.query("DELETE FROM identity WHERE id = $1", [third]);
        const written = await writePopulation(
          pool,
          generatePopulation({ size: 40, homes: HOMES }),
          VERSIONS,
        );
        expect(written).toMatchObject({ removed: 0, spared: 2, written: 40 });
        expect(await removePopulation(pool)).toEqual({ removed: 40, spared: 2 });
        expect(await untouched()).toBe(2);
      } finally {
        await pool.end();
      }
    });
  });

  it("takes a person's sanctions with them, an open ban that outlived an erasure too, and nobody else's", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      const at = new Date("2026-10-16T09:00:00Z");
      const count = async (sql: string) =>
        Number((await pool.query<{ n: string }>(sql)).rows[0]?.n);
      const accountOf = async (subject: string) => {
        const { rows } = await pool.query<{ id: string; identity_id: string }>(
          `SELECT a.id, a.identity_id FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject = $1`,
          [subject],
        );
        const row = rows[0];
        if (!row) throw new Error(`no account of ${subject}`);
        return row;
      };
      const sanction = (
        of: { id: string; identity_id: string },
        kind: string,
        extra: { endsAt?: Date; liftedAt?: Date; createdBy?: string } = {},
      ) =>
        pool.query(
          `INSERT INTO sanction (identity_id, account_id, kind, reason, note, ends_at, created_by, created_at, lifted_at)
           VALUES ($1, $2, $3::sanction_kind, 'harassment', 'A test note.', $4, $5, $6, $7)`,
          [
            of.identity_id,
            of.id,
            kind,
            extra.endsAt ?? null,
            extra.createdBy ?? null,
            at,
            extra.liftedAt ?? null,
          ],
        );
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
        await writePopulation(pool, generatePopulation({ size: 40, homes: HOMES }), VERSIONS);

        // Somebody the seed made, a member of staff to the sanctions below, and sanctioned too.
        const { rows: seeded } = await pool.query<{ id: string; identity_id: string }>(
          `SELECT a.id, a.identity_id FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject IS NULL OR i.broker_subject NOT LIKE $1 LIMIT 1`,
          [`${DEMO_SUBJECT_PREFIX}%`],
        );
        const staff = seeded[0];
        if (!staff) throw new Error("the seed made no account");
        await sanction(staff, "warn");

        // A live person with a warning by staff and a shadow ban lifted.
        const live = await accountOf(`${DEMO_SUBJECT_PREFIX}demo-0001`);
        await sanction(live, "warn", { createdBy: staff.identity_id });
        await sanction(live, "shadow_ban", { liftedAt: at, createdBy: staff.identity_id });
        // An erased one, as the erasure leaves it: a tombstone, and the open
        // ban and suspension that carry the identity's standing (ADR-024 §8).
        const erased = await accountOf(`${DEMO_SUBJECT_PREFIX}demo-0002`);
        await sanction(erased, "ban");
        await sanction(erased, "suspend", { endsAt: new Date("2026-11-01T22:00:00Z") });
        await pool.query(
          `UPDATE account SET state = 'deleted', state_changed_at = $2, deleted_at = $2,
             birth_year = NULL, birth_month = NULL, gender = NULL, pond_id = NULL,
             home_place = NULL, home_shows_area = false
           WHERE id = $1`,
          [erased.id, at],
        );
        await pool.query("UPDATE identity SET standing = 'banned' WHERE id = $1", [
          erased.identity_id,
        ]);
        expect(await count("SELECT count(*) AS n FROM sanction")).toBe(5);

        expect(await removePopulation(pool)).toEqual({ removed: 40, spared: 0 });
        // The seed's own row stays, and nothing of the forty.
        const { rows: left } = await pool.query(
          "SELECT account_id, kind, created_by FROM sanction",
        );
        expect(left).toEqual([{ account_id: staff.id, kind: "warn", created_by: null }]);
        expect(
          await count(
            `SELECT count(*) AS n FROM identity WHERE broker_subject LIKE '${DEMO_SUBJECT_PREFIX}%'`,
          ),
        ).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });

  it("takes a person's reports, blocks and conversations with them, on either side of them, and nobody else's (#84, #348)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      const accountOf = async (subject: string) => {
        const { rows } = await pool.query<{ id: string; identity_id: string }>(
          `SELECT a.id, a.identity_id FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject = $1`,
          [subject],
        );
        const row = rows[0];
        if (!row) throw new Error(`no account of ${subject}`);
        return row;
      };
      type Person = { id: string; identity_id: string };
      const reported = (from: Person, about: Person) =>
        pool.query(
          `INSERT INTO report (reporter_account_id, reported_account_id, source, reason)
           VALUES ($1, $2, 'card', 'other')`,
          [from.id, about.id],
        );
      const blocked = (from: Person, whom: Person) =>
        pool.query("INSERT INTO block (blocker_identity_id, blocked_identity_id) VALUES ($1, $2)", [
          from.identity_id,
          whom.identity_id,
        ]);
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
        await writePopulation(pool, generatePopulation({ size: 40, homes: HOMES }), VERSIONS);
        // Somebody the seed made, and somebody who signed up: both stay.
        const { rows: seeded } = await pool.query<Person>(
          `SELECT a.id, a.identity_id FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject IS NULL OR i.broker_subject NOT LIKE $1 LIMIT 1`,
          [`${DEMO_SUBJECT_PREFIX}%`],
        );
        const { rows: signedUp } = await pool.query<Person>(
          `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ('kuutti test: signed up') RETURNING id)
           INSERT INTO account (identity_id, state, birth_year, birth_month)
           SELECT id, 'active', 1990, 6 FROM i RETURNING id, identity_id`,
        );
        const [kept, other] = [seeded[0], signedUp[0]] as [Person, Person];
        const live = await accountOf(`${DEMO_SUBJECT_PREFIX}demo-0001`);
        const gone = await accountOf(`${DEMO_SUBJECT_PREFIX}demo-0002`);
        // Each way between a synthetic person and a kept one, and one between the kept two.
        await reported(live, kept);
        await reported(kept, gone);
        await reported(kept, other);
        await blocked(live, kept);
        await blocked(kept, gone);
        await blocked(other, kept);
        // A conversation with a synthetic person goes whole; one between the kept two stays (#348).
        const conversation = async (a: Person, b: Person) => {
          const { rows } = await pool.query<{ id: string }>(
            "INSERT INTO conversation DEFAULT VALUES RETURNING id",
          );
          const id = rows[0]?.id as string;
          await pool.query(
            `INSERT INTO conversation_participant (conversation_id, account_id, side)
             VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
            [id, a.id, b.id],
          );
          await pool.query(
            `INSERT INTO message (conversation_id, seq, side, client_id, kind, body)
             VALUES ($1, 1, 'a', gen_random_uuid(), 'text', 'Hei')`,
            [id],
          );
          return id;
        };
        await conversation(live, kept);
        const between = await conversation(kept, other);

        expect(await removePopulation(pool)).toEqual({ removed: 40, spared: 0 });
        const { rows: conversations } = await pool.query("SELECT id FROM conversation");
        expect(conversations).toEqual([{ id: between }]);
        const { rows: messages } = await pool.query("SELECT conversation_id FROM message");
        expect(messages).toEqual([{ conversation_id: between }]);
        const { rows: reports } = await pool.query(
          "SELECT reporter_account_id, reported_account_id FROM report",
        );
        expect(reports).toEqual([{ reporter_account_id: kept.id, reported_account_id: other.id }]);
        const { rows: blocks } = await pool.query(
          "SELECT blocker_identity_id, blocked_identity_id FROM block",
        );
        expect(blocks).toEqual([
          { blocker_identity_id: other.identity_id, blocked_identity_id: kept.identity_id },
        ]);
      } finally {
        await pool.end();
      }
    });
  });

  it("takes a person's invitations with what they earned and their notices, on either side of them, and nobody else's (#107)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      const at = new Date("2026-10-22T09:00:00Z");
      type Person = { id: string; identity_id: string };
      const accountOf = async (subject: string) => {
        const { rows } = await pool.query<Person>(
          `SELECT a.id, a.identity_id FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject = $1`,
          [subject],
        );
        const row = rows[0];
        if (!row) throw new Error(`no account of ${subject}`);
        return row;
      };
      // An invitation as the night's count leaves it: counted, one fish to the inviter, and its notice.
      const counted = async (inviter: Person, redeemer: Person, code: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO invitation (inviter_account_id, code_hash, created_at, redeemed_by_account_id, redeemed_at, counted_at)
           VALUES ($1, $2, $4, $3, $4, $4) RETURNING id`,
          [inviter.id, code.repeat(64), redeemer.id, at],
        );
        const id = rows[0]?.id as string;
        await pool.query(
          "INSERT INTO reward (account_id, kind, invitation_id, earned_at) VALUES ($1, 'fish', $2, $3)",
          [inviter.id, id, at],
        );
        await pool.query(
          "INSERT INTO notice (account_id, kind, invitation_id) VALUES ($1, 'invitation_counted', $2)",
          [inviter.id, id],
        );
        return id;
      };
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
        await writePopulation(pool, generatePopulation({ size: 40, homes: HOMES }), VERSIONS);
        // Somebody the seed made, and somebody who signed up: both stay.
        const { rows: seeded } = await pool.query<Person>(
          `SELECT a.id, a.identity_id FROM account a JOIN identity i ON i.id = a.identity_id
           WHERE i.broker_subject IS NULL OR i.broker_subject NOT LIKE $1 LIMIT 1`,
          [`${DEMO_SUBJECT_PREFIX}%`],
        );
        const { rows: signedUp } = await pool.query<Person>(
          `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ('kuutti test: signed up') RETURNING id)
           INSERT INTO account (identity_id, state, birth_year, birth_month)
           SELECT id, 'active', 1990, 6 FROM i RETURNING id, identity_id`,
        );
        const [kept, other] = [seeded[0], signedUp[0]] as [Person, Person];
        const live = await accountOf(`${DEMO_SUBJECT_PREFIX}demo-0001`);
        // Each way between a synthetic person and a kept one, one between the kept two, and one still open.
        await counted(live, kept, "a");
        await counted(kept, live, "b");
        const between = await counted(kept, other, "c");
        await pool.query("INSERT INTO invitation (inviter_account_id, code_hash) VALUES ($1, $2)", [
          live.id,
          "d".repeat(64),
        ]);

        expect(await removePopulation(pool)).toEqual({ removed: 40, spared: 0 });
        const { rows: invitations } = await pool.query("SELECT id FROM invitation");
        expect(invitations).toEqual([{ id: between }]);
        const { rows: rewards } = await pool.query("SELECT account_id, invitation_id FROM reward");
        expect(rewards).toEqual([{ account_id: kept.id, invitation_id: between }]);
        const { rows: notices } = await pool.query(
          "SELECT account_id, invitation_id FROM notice WHERE kind = 'invitation_counted'",
        );
        expect(notices).toEqual([{ account_id: kept.id, invitation_id: between }]);
      } finally {
        await pool.end();
      }
    });
  });

  it("refuses anybody who is not synthetic, anybody with a pond and no home, and a pond the database has not", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const [person] = generatePopulation({ size: 1, homes: HOMES });
        if (!person) throw new Error("nobody generated");
        await expect(
          writePopulation(pool, [{ ...person, label: "seed-active" }], VERSIONS),
        ).rejects.toThrow(/not a synthetic person/);
        // Nobody's pool would hold them, and nothing would say so (ADR-061 §1).
        await expect(writePopulation(pool, [{ ...person, home: null }], VERSIONS)).rejects.toThrow(
          "demo-0001 has no home: generatePopulation needs the places",
        );
        // Migration 0027's pond is there, with or without a seed; another is not: nothing is written, not even the identity.
        await expect(
          writePopulation(pool, [{ ...person, pond: "nowhere" }], VERSIONS),
        ).rejects.toThrow("no pond nowhere in this database");
        const { rows } = await pool.query("SELECT 1 FROM identity");
        expect(rows).toHaveLength(0);
      } finally {
        await pool.end();
      }
    });
  });
});
