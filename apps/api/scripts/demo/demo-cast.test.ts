import { randomBytes } from "node:crypto";
import { MATCHING_CONFIG_V1 } from "@kuutti/db";
import {
  CAST,
  CAST_CONVERSATIONS,
  CAST_LIKES,
  type CastPerson,
  DEMO_PERSONAS,
  DEMO_SUBJECT_PREFIX,
  openPonds,
  PERSONA_HISTORIES,
  personaBirth,
  writePopulation,
} from "@kuutti/db/demo";
import { BIO_MIN_FOR_COMPLETENESS, PreferencesUpdate, ProfileUpdate } from "@kuutti/schema";
import { it } from "vitest";
import { CURRENT_CONSENT_VERSIONS, hmacKeyFromHex } from "../../src/identity/index.ts";
import { fillQueue } from "../../src/jobs/round-builder.ts";
import { finnishDay } from "../../src/lib/finnish-day.ts";
import { inEachOthersPool, type PoolPerson } from "../../src/matching/index.ts";
import { keptPlace, pointOf } from "../../src/pond/index.ts";
import {
  ageInYears,
  contactDetailsIn,
  SPECIAL_CATEGORY_CONSENT_VERSION,
} from "../../src/profile/index.ts";
import { captureLogger, describe, expect, test } from "../../src/test/harness.ts";
import { giveCastStories } from "./histories.ts";
import { castWithHomes, peopleToWrite } from "./homes.ts";
import { giveStories, viaServices } from "./services.ts";

// The cast (#560) against the product's own rules: everybody a person's answers
// could be, every card one the filters allow both ways (rule 7), on every month
// of the demo, and nobody among the cards of Iida's round, which the round's flow
// reads exactly. Their shape and their writers are tested in packages/db
// (cast.test.ts, rounds.test.ts).

// The first and last day of every month to the end of 2028: an age turns at a month's end (TD-14).
const MONTHS = Array.from({ length: 26 }, (_, i) => [
  new Date(Date.UTC(2026, 10 + i, 1)),
  new Date(Date.UTC(2026, 11 + i, 0)),
]).flat();

const EDGES = {
  nearby: MATCHING_CONFIG_V1.distance_nearby_km,
  close: MATCHING_CONFIG_V1.distance_close_km,
  around: MATCHING_CONFIG_V1.distance_around_km,
};

function homeAt(code: string): PoolPerson["home"] {
  const kept = keptPlace(code, MATCHING_CONFIG_V1.home_min_inhabitants);
  const point = kept === null ? null : pointOf(kept);
  if (!point) throw new Error(`nothing is kept of ${code}`);
  return { ...point, edges: EDGES };
}

function cardOf(person: CastPerson, at: Date): PoolPerson {
  return {
    gender: person.gender,
    seeks: person.answers.seeks,
    ageWindow: person.answers.ageWindow,
    age: ageInYears(person.born.year, person.born.month, at),
    intent: person.answers.intent,
    home: homeAt(person.home),
    identityId: person.key,
    blocks: new Set(),
    fields: { intent: person.answers.intent },
    dealBreakers: [],
  };
}

const historyOf = (key: string) => {
  const history = PERSONA_HISTORIES.find((h) => h.key === key);
  if (!history) throw new Error(`no history ${key}`);
  return history;
};

const ageOfPersona = (key: string, at: Date): number => {
  const persona = DEMO_PERSONAS.find((p) => p.key === key);
  if (!persona) throw new Error(`no persona ${key}`);
  const born = personaBirth(persona, at);
  return ageInYears(born.year, born.month, at);
};

/** A persona with a story, as the pool sees it on the day. */
function memberOf(key: string, at: Date): PoolPerson {
  const { onboarding, profile } = historyOf(key);
  const intent = profile?.fields.intent;
  if (!onboarding || !intent) throw new Error(`${key} is in nobody's pool`);
  return {
    gender: onboarding.gender,
    seeks: onboarding.seeks,
    ageWindow: onboarding.ageWindow,
    age: ageOfPersona(key, at),
    intent,
    home: homeAt(onboarding.home),
    identityId: key,
    blocks: new Set(),
    fields: profile.fields,
    dealBreakers: [],
  };
}

/** A newcomer of the stories, who answers in the app: the age window it offers is the age and five years either way. */
function newcomer(
  key: string,
  answers: {
    gender: PoolPerson["gender"];
    seeks: PoolPerson["seeks"];
    intent: PoolPerson["intent"];
  },
  at: Date,
): PoolPerson {
  const age = ageOfPersona(key, at);
  return {
    ...answers,
    ageWindow: { min: Math.max(18, age - 5), max: Math.min(99, age + 5) },
    age,
    home: homeAt("00100"),
    identityId: key,
    blocks: new Set(),
    fields: { intent: answers.intent },
    dealBreakers: [],
  };
}

const chatPartnersOf = (key: string): string[] =>
  CAST_CONVERSATIONS.filter((told) => told.between[0] === key).map((told) => told.between[1]);

describe("the cast", () => {
  it("come with faces or not at all, and move nobody the population has drawn", () => {
    const size = 20;
    const seed = 73;
    const without = peopleToWrite({ size, seed, photos: false });
    const withFaces = peopleToWrite({ size, seed, photos: true });
    expect(without.people).toEqual(without.drawn);
    expect(without.people.some((person) => person.label.startsWith("demo-cast-"))).toBe(false);
    expect(withFaces.drawn).toEqual(without.drawn);
    expect(withFaces.people).toHaveLength(size + CAST.length);
    expect(withFaces.people.slice(0, size)).toEqual(without.drawn);
  });

  it("answer what a person's own answers must, in words the profile takes", () => {
    const people = castWithHomes();
    expect(people).toHaveLength(CAST.length);
    for (const person of people) {
      expect(person.home?.place, person.label).toBeTruthy();
      expect(() => PreferencesUpdate.parse(person.preferences), person.label).not.toThrow();
      const { specialCategoryConsentedAt: _, ...update } = person.profile ?? {};
      expect(() => ProfileUpdate.parse(update), person.label).not.toThrow();
      expect(person.profile?.bio?.length ?? 0, person.label).toBeGreaterThanOrEqual(
        BIO_MIN_FOR_COMPLETENESS,
      );
      expect(contactDetailsIn(person.profile?.bio ?? ""), person.label).toBeNull();
    }
  });

  it.each([
    ["sanna", 20],
    ["kerttu", 24],
    ["noa", 20],
  ] as const)(
    "give %s at least %i people to go through, on every day of the demo",
    (key, least) => {
      const partners = chatPartnersOf(key);
      for (const at of MONTHS) {
        const member = memberOf(key, at);
        const cards = CAST.filter(
          (person) =>
            !partners.includes(person.key) && inEachOthersPool(member, cardOf(person, at)),
        );
        expect(cards.length, `${key} on ${at.toISOString().slice(0, 10)}`).toBeGreaterThanOrEqual(
          least,
        );
      }
    },
  );

  it("give Noa people of every gender and Kerttu women as well as men, not only the men Sanna needs", () => {
    const at = MONTHS[0] as Date;
    const genders = (key: string) =>
      new Set(
        CAST.filter((person) => inEachOthersPool(memberOf(key, at), cardOf(person, at))).map(
          (person) => person.gender,
        ),
      );
    expect(genders("sanna")).toEqual(new Set(["man"]));
    expect(genders("kerttu")).toEqual(new Set(["man", "woman"]));
    expect(genders("noa")).toEqual(new Set(["man", "woman", "non_binary"]));
  });

  it("hold every fish, like and chat to the filters, both ways, on every day of the demo", () => {
    const byKey = new Map(CAST.map((person) => [person.key, person]));
    const pairs = [
      ...CAST_LIKES.flatMap(({ of, fishFrom, likedBy }) =>
        [...fishFrom, ...likedBy].map((key) => [of, key] as const),
      ),
      ...CAST_CONVERSATIONS.map((told) => told.between),
    ];
    expect(pairs.length).toBeGreaterThan(0);
    for (const at of MONTHS) {
      for (const [member, key] of pairs) {
        const card = byKey.get(key);
        if (!card) throw new Error(`nobody of the cast is ${key}`);
        expect(inEachOthersPool(memberOf(member, at), cardOf(card, at)), `${member}, ${key}`).toBe(
          true,
        );
      }
    }
  });

  it.each([
    // Eight for the part of each year in which the two of twenty-eight fall out of her window.
    ["aino", "woman", "man", 8],
    ["aino", "woman", "woman", 4],
    ["onni", "man", "woman", 10],
    ["onni", "man", "man", 10],
  ] as const)(
    "give %s, a %s who seeks %s, at least %i people at the window the app offers",
    (key, gender, seeks, least) => {
      for (const intent of ["long_term", "casual", "open_to_either"] as const) {
        for (const at of MONTHS) {
          const person = newcomer(key, { gender, seeks: [seeks], intent }, at);
          const cards = CAST.filter((card) => inEachOthersPool(person, cardOf(card, at)));
          expect(
            cards.length,
            `${key}, ${intent}, ${at.toISOString().slice(0, 10)}`,
          ).toBeGreaterThanOrEqual(least);
        }
      }
    },
  );

  it.each(["iida", "henna", "katja", "minna", "riikka"])(
    "stay out of %s's pool, which the round's flow reads exactly",
    (key) => {
      for (const at of MONTHS) {
        const person = memberOf(key, at);
        for (const card of CAST) {
          expect(
            inEachOthersPool(person, cardOf(card, at)),
            `${card.key} on ${at.toISOString()}`,
          ).toBe(false);
        }
      }
    },
  );

  it("write nothing in their chats that the send would refuse", () => {
    for (const told of CAST_CONVERSATIONS) {
      for (const message of told.messages) {
        expect(contactDetailsIn(message.body), message.body).toBeNull();
        expect(message.body.length).toBeLessThanOrEqual(MATCHING_CONFIG_V1.message_max_length);
      }
    }
  });
});

describe("what the cast gives the members", () => {
  test("nothing, where no cast has been written", async ({ ctx }) => {
    expect(await giveCastStories(ctx.client, [], new Date())).toEqual({ cast: 0 });
  });

  test("a fish first, then the likes, every card one the member seeks and no chat partner among them; told again, it stays", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const now = () => new Date();
    const hmacKey = hmacKeyFromHex(randomBytes(32).toString("hex"));
    const results = await giveStories(viaServices({ db: ctx.client, logger, now, hmacKey }));
    const sanna = results.find((r) => r.key === "sanna")?.accountId;
    if (!sanna) throw new Error("Sanna has no account");
    await writePopulation(ctx.client, castWithHomes(), {
      ...CURRENT_CONSENT_VERSIONS,
      special_category: SPECIAL_CATEGORY_CONSENT_VERSION,
    });
    // The release's faces are no part of a test: two approved photos each, as the loader leaves them.
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       SELECT a.id, md5(a.id::text || n::text), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'approved', n
         FROM account a JOIN identity i ON i.id = a.identity_id, generate_series(0, 1) n
        WHERE a.id = $1 OR i.broker_subject LIKE $2`,
      [sanna, `${DEMO_SUBJECT_PREFIX}demo-cast-%`],
    );
    await openPonds(ctx.client);

    expect(await giveCastStories(ctx.client, results, now())).toEqual({
      cast: CAST.length,
      leftovers: 0,
      likes: { liked: 8, already: 0, missing: 0 },
      conversations: { written: 5, already: 0, missing: 0 },
    });

    // As many reads as it takes to walk the pool, and one more that finds its end.
    const deps = { db: ctx.client, logger, now };
    let reads = 0;
    while (await fillQueue(deps, sanna)) {
      reads += 1;
      expect(reads).toBeLessThan(10);
    }
    const { rows } = await ctx.client.query<{ subject: string; reason: string; gender: string }>(
      `SELECT i.broker_subject AS subject, e.reason, a.gender
         FROM rounds r JOIN round_entries e ON e.round_id = r.id
         JOIN account a ON a.id = e.candidate_id JOIN identity i ON i.id = a.identity_id
        WHERE r.account_id = $1 AND r.day = $2 ORDER BY e.position`,
      [sanna, finnishDay(now())],
    );
    const keys = rows.map((row) => row.subject.replace(`${DEMO_SUBJECT_PREFIX}demo-cast-`, ""));
    expect(keys[0]).toBe("jere");
    expect(rows[0]?.reason).toBe("fish");
    expect(new Set(keys.slice(1, 3))).toEqual(new Set(["risto", "karim"]));
    expect(rows.slice(1, 3).map((row) => row.reason)).toEqual(["liked_you", "liked_you"]);
    expect(rows.slice(3).every((row) => row.reason === "matches_filters")).toBe(true);
    // The twenty-two men, less the two she is talking to.
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.gender))).toEqual(new Set(["man"]));
    expect(keys).not.toContain("juha");
    expect(keys).not.toContain("mika");

    // Staging's job runs again without a reset: nothing new.
    expect(await giveCastStories(ctx.client, results, now())).toEqual({
      cast: CAST.length,
      leftovers: 0,
      likes: { liked: 0, already: 8, missing: 0 },
      conversations: { written: 0, already: 5, missing: 0 },
    });
  });

  test("takes away what an erased member left with them, so that resets do not pile up, and nothing of anybody else's", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const now = () => new Date();
    const hmacKey = hmacKeyFromHex(randomBytes(32).toString("hex"));
    const writer = viaServices({ db: ctx.client, logger, now, hmacKey });
    const results = await giveStories(writer);
    await writePopulation(ctx.client, castWithHomes(), {
      ...CURRENT_CONSENT_VERSIONS,
      special_category: SPECIAL_CATEGORY_CONSENT_VERSION,
    });
    await giveCastStories(ctx.client, results, now());
    const conversations = async () => {
      const { rows } = await ctx.client.query<{ n: number; erased: number; messages: number }>(
        `SELECT (SELECT count(*)::int FROM conversation) AS n,
                (SELECT count(*)::int FROM conversation_participant WHERE account_id IS NULL) AS erased,
                (SELECT count(*)::int FROM message) AS messages`,
      );
      return rows[0];
    };
    expect(await conversations()).toEqual({ n: 5, erased: 0, messages: 15 });

    // Sanna leaves, as a reset forgets her: her two chats stay for the other side.
    const sanna = results.find((r) => r.key === "sanna")?.accountId;
    if (!sanna) throw new Error("Sanna has no account");
    await writer.deleteAccount(sanna);
    expect(await conversations()).toEqual({ n: 5, erased: 2, messages: 15 });

    // Her account is gone, so her likes and chats are missing this time; the others' stand.
    const others = results.filter((r) => r.key !== "sanna");
    expect(await giveCastStories(ctx.client, others, now())).toEqual({
      cast: CAST.length,
      leftovers: 2,
      likes: { liked: 0, already: 5, missing: 3 },
      conversations: { written: 0, already: 3, missing: 2 },
    });
    expect(await conversations()).toEqual({ n: 3, erased: 0, messages: 9 });
  });
});
