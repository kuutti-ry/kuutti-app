import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool, type Queryable } from "../pool.ts";
import { MATCHING_CONFIG_V1 } from "../seed.ts";
import { withTemporaryDatabase } from "../test/temporary-database.ts";
import {
  CAST,
  CAST_CONVERSATIONS,
  CAST_LIKES,
  castAccounts,
  castFaces,
  castLabel,
  castPeople,
} from "./cast.ts";
import { writeConversations } from "./conversations.ts";
import { PERSONA_HISTORIES } from "./histories.ts";
import { DEMO_PERSONAS } from "./personas.ts";
import { assetsFor } from "./photos.ts";
import { PHOTOS_MANIFEST } from "./photos-manifest.ts";
import { removePopulation, writePopulation } from "./write-population.ts";

// The cast (#560) as data, and as people of the population. Whether they pass the
// members' filters is the API's rule, tested beside it
// (apps/api/scripts/demo/demo-cast.test.ts).

const MIGRATIONS = resolve(import.meta.dirname, "../..", "drizzle");
const VERSIONS = { terms: "t", privacy: "p", special_category: "s" };
const keep = (postalCode: string) => postalCode;
const NOW = new Date(Date.UTC(2026, 10, 5, 12));

describe("the cast", () => {
  it("are forty-eight people with keys of their own, none of them a persona's", () => {
    const keys = CAST.map((person) => person.key);
    expect(keys).toHaveLength(48);
    expect(new Set(keys).size).toBe(48);
    const personas = new Set(DEMO_PERSONAS.map((persona) => persona.key));
    for (const key of keys) {
      expect(key).toMatch(/^[a-z]+$/);
      expect(personas.has(key), key).toBe(false);
    }
  });

  it("each have three faces of their own in the release, and nobody's are left over", () => {
    const faces = castFaces(PHOTOS_MANIFEST);
    expect(faces.size).toBe(CAST.length);
    for (const person of CAST) {
      const own = faces.get(castLabel(person.key));
      expect(own?.map((asset) => asset.path)).toEqual(
        [1, 2, 3].map((n) => `faces/cast/${person.key}/${n}.jpg`),
      );
      expect(assetsFor(PHOTOS_MANIFEST, `persona:${person.key}`)).toEqual([]);
    }
    const inTheRelease = PHOTOS_MANIFEST.filter((asset) => asset.purpose.startsWith("cast:"));
    expect(inTheRelease).toHaveLength(CAST.length * 3);
  });

  it("show an area's name only where an area is kept, and refuse somebody of whose home nothing is", () => {
    const jere = (place: string) =>
      castPeople(() => place).find((person) => person.label === castLabel("jere"))?.home;
    expect(jere("02600")).toEqual({ place: "02600", showsArea: true });
    // A municipality is kept: there is no area to show.
    expect(jere("049")).toEqual({ place: "049", showsArea: false });
    const pekka = castPeople(keep).find((person) => person.label === castLabel("pekka"));
    expect(pekka?.home?.showsArea).toBe(false);
    expect(() => castPeople(() => null)).toThrow(/jere: nothing is kept of 02600/);
  });

  it("are born so that their ages hold on the day the pictures were made", () => {
    // The youngest of the sheet is 24 and the oldest 53, in November 2026.
    for (const person of CAST) {
      expect(2026 - person.born.year, person.key).toBeGreaterThanOrEqual(24);
      expect(2026 - person.born.year, person.key).toBeLessThanOrEqual(53);
      expect(person.born.month, person.key).toBeGreaterThanOrEqual(1);
      expect(person.born.month, person.key).toBeLessThanOrEqual(11);
    }
  });

  it("are written as people of the population, consents and all, and removed with it", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        expect((await castAccounts(pool)).size).toBe(0);
        const written = await writePopulation(pool, castPeople(keep), VERSIONS);
        expect(written).toMatchObject({ written: CAST.length, removed: 0, spared: 0 });
        const accounts = await castAccounts(pool);
        expect([...accounts.keys()].sort()).toEqual(CAST.map((person) => person.key).sort());
        const jere = await pool.query(
          `SELECT a.state, a.birth_year, a.gender, a.home_place, p.display_name,
                  (SELECT array_agg(c.version ORDER BY c.version) FROM consent c WHERE c.account_id = a.id) AS versions,
                  (SELECT count(*)::int FROM preferences r WHERE r.account_id = a.id) AS preferences
             FROM account a JOIN profile p ON p.account_id = a.id WHERE a.id = $1`,
          [accounts.get("jere")],
        );
        expect(jere.rows).toEqual([
          {
            state: "active",
            birth_year: 1982,
            gender: "man",
            home_place: "02600",
            display_name: "Jere",
            versions: ["p", "s", "t"],
            preferences: 2,
          },
        ]);
        expect(await removePopulation(pool)).toEqual({ removed: CAST.length, spared: 0 });
        expect((await castAccounts(pool)).size).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });
});

describe("what the cast gives the members", () => {
  const members = new Set(
    PERSONA_HISTORIES.filter(
      (h) => h.profile && h.photos >= 2 && ["nothing", "older_terms"].includes(h.afterwards),
    ).map((h) => h.key),
  );
  const cast = new Set(CAST.map((person) => person.key));

  it("names members who can see people, and people of the cast, each like and chat once", () => {
    for (const { of, fishFrom, likedBy } of CAST_LIKES) {
      expect(members.has(of), of).toBe(true);
      expect(fishFrom.length, of).toBeGreaterThan(0);
      expect(likedBy.length, of).toBeGreaterThan(0);
      const likers = [...fishFrom, ...likedBy];
      expect(new Set(likers).size, of).toBe(likers.length);
      for (const key of likers) expect(cast.has(key), key).toBe(true);
    }
    for (const { between } of CAST_CONVERSATIONS) {
      expect(members.has(between[0]), between[0]).toBe(true);
      expect(cast.has(between[1]), between[1]).toBe(true);
      // A chat partner is no card, so a like of theirs would never be shown.
      const story = CAST_LIKES.find((likes) => likes.of === between[0]);
      expect([...(story?.fishFrom ?? []), ...(story?.likedBy ?? [])]).not.toContain(between[1]);
    }
    const pairs = CAST_CONVERSATIONS.map((told) => told.between.join("+"));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(CAST_LIKES.map((likes) => likes.of).sort()).toEqual(["kerttu", "noa", "sanna"]);
  });

  it("keeps every chat open, oldest message first, and one on each member's turn with something unread", () => {
    const silence = MATCHING_CONFIG_V1.silent_match_archive_days * 24;
    for (const told of CAST_CONVERSATIONS) {
      const where = told.between.join("+");
      expect(told.archivedHoursAgo, where).toBeUndefined();
      const ages = told.messages.map((message) => message.hoursAgo);
      expect(ages, where).toEqual([...ages].sort((a, b) => b - a));
      expect(told.openedHoursAgo, where).toBeGreaterThan(ages[0] as number);
      expect(ages.at(-1) as number, where).toBeLessThan(silence);
      expect(told.readUpTo.a, where).toBeLessThanOrEqual(told.messages.length);
      expect(told.readUpTo.b, where).toBeLessThanOrEqual(told.messages.length);
      // Letters only: nothing the send could take for a phone number or a handle.
      for (const message of told.messages) expect(message.body, where).not.toMatch(/[0-9@]/);
    }
    for (const { of } of CAST_LIKES) {
      const onTheirTurn = CAST_CONVERSATIONS.filter(
        (told) =>
          told.between[0] === of &&
          told.messages.at(-1)?.from === "b" &&
          told.readUpTo.a < told.messages.length,
      );
      expect(onTheirTurn, of).toHaveLength(1);
    }
  });

  it("writes the chats it is handed, says who is missing, and leaves a chat told before as it is", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      const account = async (db: Queryable, hash: string) => {
        const identity = await db.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, $1) RETURNING id",
          [hash],
        );
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO account (identity_id, state, birth_year, birth_month)
           VALUES ($1, 'active', 1977, 6) RETURNING id`,
          [identity.rows[0]?.id],
        );
        return rows[0]?.id as string;
      };
      try {
        await migrate(pool, MIGRATIONS);
        await writePopulation(pool, castPeople(keep), VERSIONS);
        const accounts = new Map([
          ...(await castAccounts(pool)),
          ["sanna", await account(pool, "hash-sanna")],
        ]);
        expect(await writeConversations(pool, accounts, NOW, CAST_CONVERSATIONS)).toEqual({
          written: 2,
          already: 0,
          missing: 3,
        });
        const messages = await pool.query("SELECT count(*)::int AS n FROM message");
        expect(messages.rows).toEqual([{ n: 6 }]);
        expect(await writeConversations(pool, accounts, NOW, CAST_CONVERSATIONS)).toEqual({
          written: 0,
          already: 2,
          missing: 3,
        });
      } finally {
        await pool.end();
      }
    });
  });
});
