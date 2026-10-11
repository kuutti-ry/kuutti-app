import { resolve } from "node:path";
import { Gender, PreferencesUpdate, ProfileUpdate } from "@kuutti/schema";
import { ageFromYearMonth } from "@kuutti/tunnistus-oidc/hetu";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool } from "../pool.ts";
import { MATCHING_CONFIG_V1, SEED_IDENTITIES, seed } from "../seed.ts";
import { withTemporaryDatabase } from "../test/temporary-database.ts";
import {
  apportion,
  DEMO_EPOCH,
  DEMO_SIZE_MAX,
  generatePopulation,
  plannedPonds,
  planSizes,
  summarise,
  uncrossed,
} from "./population.ts";
import { createRandom } from "./rng.ts";
import {
  DEMO_SUBJECT_PREFIX,
  demoHetuHmac,
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
const THRESHOLDS = {
  gateK: MATCHING_CONFIG_V1.gate_k,
  majorityShareMax: MATCHING_CONFIG_V1.majority_share_max,
  counterK: MATCHING_CONFIG_V1.waitlist_k,
};
/** From this many people up, the population shows everything it is there for. */
const SHOWS_EVERYTHING_FROM = 174;

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

  it("crosses the thresholds it is there to cross", () => {
    const ponds = summarise(people);
    const { gate_k: gate, majority_share_max: majority, waitlist_k: counterK } = MATCHING_CONFIG_V1;
    // The one pond (#146): over the gate, men over the majority share, every cell at ten or more.
    expect(ponds.paakaupunkiseutu).toMatchObject({
      people: 276,
      woman: 88,
      man: 171,
      non_binary: 17,
    });
    expect(ponds.paakaupunkiseutu?.people).toBeGreaterThanOrEqual(gate);
    expect(ponds.paakaupunkiseutu?.largestShare).toBeGreaterThan(majority);
    for (const gender of Gender.options) {
      expect(ponds.paakaupunkiseutu?.[gender]).toBeGreaterThanOrEqual(counterK);
    }
    expect(Object.keys(ponds)).toEqual(["paakaupunkiseutu"]);
    expect(people.filter((p) => p.pond === null)).toHaveLength(24);
    expect(uncrossed(ponds, THRESHOLDS)).toEqual([]);
  });

  it("shows everything from 174 people up, and says what a smaller one does not", () => {
    for (const size of [1, 26, 100, 300, 1234]) {
      expect(summarise(generatePopulation({ size })), String(size)).toEqual(plannedPonds(size));
    }
    // Every size there is: the plan is arithmetic, nobody is drawn.
    const tooSmall: number[] = [];
    for (let size = 1; size <= DEMO_SIZE_MAX; size += 1) {
      if (uncrossed(plannedPonds(size), THRESHOLDS).length > 0) tooSmall.push(size);
    }
    expect(Math.max(...tooSmall)).toBe(SHOWS_EVERYTHING_FROM - 1);
    // Every size from there up shows everything; below it one size happens to round the smallest cell up to k.
    expect(tooSmall.every((size) => size < SHOWS_EVERYTHING_FROM)).toBe(true);
    expect(tooSmall.length).toBeGreaterThanOrEqual(SHOWS_EVERYTHING_FROM - 2);
    expect(uncrossed(plannedPonds(100), THRESHOLDS)).toEqual([
      "the pond has a cell under the counter's k, so it shows no split",
    ]);
    expect(uncrossed(plannedPonds(20), THRESHOLDS)).toContain("the pond is under the gate");
  });

  it("passes the contracts a person's own answers pass", () => {
    for (const person of people) {
      if (person.pond === null) {
        expect(person).toMatchObject({
          state: "registered",
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

        const people = generatePopulation();
        expect(await writePopulation(pool, people, VERSIONS)).toEqual({
          removed: 0,
          spared: 0,
          written: 300,
          ponds: { paakaupunkiseutu: 276 },
        });
        expect(await marked()).toBe(300);
        expect(await count("SELECT count(*) AS n FROM account WHERE state = 'active'")).toBe(
          276 + 1,
        );
        expect(await count("SELECT count(*) AS n FROM profile")).toBe(
          people.filter((p) => p.profile).length + 1,
        );
        expect(
          await count("SELECT count(*) AS n FROM consent WHERE version = 'test-terms-1'"),
        ).toBe(276);
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
        const capital = await pool.query<{ gender: string; n: string }>(
          `SELECT a.gender, count(*) AS n FROM account a
           JOIN ponds p ON p.id = a.pond_id JOIN identity i ON i.id = a.identity_id
           WHERE p.slug = 'paakaupunkiseutu' AND i.broker_subject LIKE $1
           GROUP BY a.gender ORDER BY a.gender`,
          [`${DEMO_SUBJECT_PREFIX}%`],
        );
        expect(capital.rows).toEqual([
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
        const again = await writePopulation(pool, generatePopulation({ size: 100 }), VERSIONS);
        expect(again).toMatchObject({ removed: 300, spared: 0, written: 100 });
        expect(await marked()).toBe(100);
        expect(await count("SELECT count(*) AS n FROM identity")).toBe(others + 100);

        expect(await removePopulation(pool)).toEqual({ removed: 100, spared: 0 });
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
          writePopulation(pool, generatePopulation({ size: 40 }), VERSIONS),
        ).rejects.toThrow(/identity_hetu_hmac_unique/);
        expect(await untouched()).toBe(3);

        // The other two, which is what a login can make, are passed by.
        await pool.query(
          "DELETE FROM profile WHERE account_id IN (SELECT id FROM account WHERE identity_id = $1)",
          [third],
        );
        await pool.query("DELETE FROM account WHERE identity_id = $1", [third]);
        await pool.query("DELETE FROM identity WHERE id = $1", [third]);
        const written = await writePopulation(pool, generatePopulation({ size: 40 }), VERSIONS);
        expect(written).toMatchObject({ removed: 0, spared: 2, written: 40 });
        expect(await removePopulation(pool)).toEqual({ removed: 40, spared: 2 });
        expect(await untouched()).toBe(2);
      } finally {
        await pool.end();
      }
    });
  });

  it("refuses anybody who is not synthetic, and a pond the seed has not made", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const [person] = generatePopulation({ size: 1 });
        if (!person) throw new Error("nobody generated");
        await expect(
          writePopulation(pool, [{ ...person, label: "seed-active" }], VERSIONS),
        ).rejects.toThrow(/not a synthetic person/);
        // No seed, no ponds: nothing is written, not even the identity.
        await expect(writePopulation(pool, [person], VERSIONS)).rejects.toThrow(/run the seed/);
        const { rows } = await pool.query("SELECT 1 FROM identity");
        expect(rows).toHaveLength(0);
      } finally {
        await pool.end();
      }
    });
  });
});
