import type { Queryable } from "@kuutti/db";
import {
  CardPreviewResponse,
  GateResponse,
  GateState,
  OnboardingStatus,
  RoundResponse,
} from "@kuutti/schema";
import { createApp } from "../app.ts";
import { pointOf } from "../pond/index.ts";
import { signInAs, staffSession, withMatchingConfig } from "../test/account.ts";
import { conversationBetween } from "../test/chat.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { openPond, type PeopleOptions, people, pondNamed } from "../test/people.ts";
import {
  isComplete,
  matchingStatusOf,
  openPondIds,
  openPondOf,
  subjectOf,
  subjectsOfPond,
} from "./pool.ts";
import { buildRounds } from "./round-builder.ts";

// features/pond/opening.feature (#500, ADR-060): who is complete, what a
// person is told of their matching, and what an admin's switch does to the
// rounds. The switch's routes are pond/admin-routes.test.ts.

/** 04:00 in Helsinki. */
const NIGHT = new Date("2026-10-20T01:00:00.000Z");
const NEXT_NIGHT = new Date("2026-10-21T01:00:00.000Z");

/** Women who seek women: every two of them are in each other's pool. */
const ALIKE: PeopleOptions = { gender: "woman", seeks: ["woman"], complete: true, consented: true };

async function statusOf(ctx: TestContext, accountId: string | undefined, query = "") {
  if (!accountId) throw new Error("nobody to ask as");
  const who = await signInAs(ctx.client, accountId);
  const response = await ctx.app.request(`/gate${query}`, { headers: who.headers });
  expect(response.status).toBe(200);
  return GateResponse.parse(await response.json()).state;
}

const roundCount = async (db: Queryable, accountId: string) =>
  (
    await db.query<{ n: number }>("SELECT count(*)::int AS n FROM rounds WHERE account_id = $1", [
      accountId,
    ])
  ).rows[0]?.n;

async function night(ctx: TestContext, at = NIGHT) {
  const { logger } = await captureLogger();
  return buildRounds({ db: ctx.client, logger, now: () => at });
}

const turn = async (ctx: TestContext, pondId: string, open: boolean) => {
  const admin = await staffSession(ctx.client, "admin");
  const response = await ctx.app.request(`/admin/ponds/${pondId}/matching`, {
    method: "POST",
    headers: { ...admin.headers, "content-type": "application/json" },
    body: JSON.stringify({ open }),
  });
  expect(response.status).toBe(200);
};

describe("a pond's switch", () => {
  test("Matching opens in a pond when an admin opens it, and not before", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-opening");
    const ids = await people(ctx.client, pond, 31, ALIKE);

    expect(await night(ctx)).toEqual({ ponds: 0, built: 0, cards: 0, failed: 0 });
    for (const id of ids) expect(await roundCount(ctx.client, id)).toBe(0);
    expect(await statusOf(ctx, ids[0])).toBe("closed");
    expect(await statusOf(ctx, ids[30])).toBe("closed");
    const closed = await ctx.client.query("SELECT matching_open FROM ponds WHERE id = $1", [pond]);
    expect(closed.rows).toEqual([{ matching_open: false }]);

    await turn(ctx, pond, true);

    expect(await statusOf(ctx, ids[0])).toBe("open");
    expect(await statusOf(ctx, ids[30])).toBe("open");
    expect(await night(ctx)).toMatchObject({ ponds: 1, built: 31, failed: 0 });
    for (const id of ids) expect(await roundCount(ctx.client, id)).toBe(1);
  });

  test("Closing a pond builds no new round and ends no conversation", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-closing");
    await openPond(ctx.client, pond);
    const [a, b] = await people(ctx.client, pond, 2, ALIKE);
    if (!a || !b) throw new Error("people not written");
    await night(ctx);
    const conversation = await conversationBetween(ctx.client, a, b);
    const who = await signInAs(ctx.client, a);
    const noon = new Date(NIGHT.getTime() + 8 * 3600 * 1000);
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => noon });
    const read = async () => {
      const response = await app.request("/rounds/today", { headers: who.headers });
      expect(response.status).toBe(200);
      return RoundResponse.parse(await response.json());
    };
    const before = await read();
    expect(before.entries).not.toBeNull();

    await turn(ctx, pond, false);

    expect((await read()).entries?.map((entry) => entry.card)).toEqual(
      before.entries?.map((entry) => entry.card),
    );
    const talk = await app.request(`/conversations/${conversation}`, { headers: who.headers });
    expect(talk.status).toBe(200);
    expect(await statusOf(ctx, a)).toBe("closed");
    expect(await night(ctx, NEXT_NIGHT)).toEqual({ ponds: 0, built: 0, cards: 0, failed: 0 });
    expect(await roundCount(ctx.client, a)).toBe(1);
  });

  test("the night reads the switch of every pond, each on its own", async ({ ctx }) => {
    const open = await pondNamed(ctx.client, "test-open-a");
    const shut = await pondNamed(ctx.client, "test-open-b");
    await openPond(ctx.client, open);
    expect(await openPondIds(ctx.client)).toContain(open);
    expect(await openPondIds(ctx.client)).not.toContain(shut);
  });
});

describe("what a person is told", () => {
  describe("A person is told one of three things", () => {
    test.for([
      ["complete", "open", "open"],
      ["complete", "closed", "closed"],
      ["unfinished", "open", "incomplete"],
      ["unfinished", "closed", "incomplete"],
    ] as const)("%s in a pond that is %s: %s", async ([person, pondState, told], { ctx }) => {
      const pond = await pondNamed(ctx.client, `test-told-${person}-${pondState}`);
      if (pondState === "open") await openPond(ctx.client, pond);
      const [who] = await people(ctx.client, pond, 1, ALIKE);
      if (!who) throw new Error("person not written");
      if (person === "unfinished") {
        await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [who]);
      }
      expect(GateState.parse(await statusOf(ctx, who))).toBe(told);
    });
  });

  test("Another person's state is never served", async ({ ctx }) => {
    const open = await pondNamed(ctx.client, "test-own-open");
    await openPond(ctx.client, open);
    const shut = await pondNamed(ctx.client, "test-own-closed");
    const [mine] = await people(ctx.client, shut, 1, ALIKE);
    const [theirs] = await people(ctx.client, open, 1, ALIKE);
    expect(await statusOf(ctx, theirs)).toBe("open");
    expect(await statusOf(ctx, mine)).toBe("closed");
    // The route takes no id: there is nobody else's to ask for.
    expect(await statusOf(ctx, mine, `?accountId=${theirs}`)).toBe("closed");
  });

  test("the gate is not served without a session", async ({ ctx }) => {
    expect((await ctx.app.request("/gate")).status).toBe(401);
    const forged = await ctx.app.request("/gate", {
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    });
    expect(forged.status).toBe(401);
  });

  test("a person without a pond, or with no profile, is told that something is missing", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-told-missing");
    await openPond(ctx.client, pond);
    const [noPond] = await people(ctx.client, null, 1, ALIKE);
    const [registered] = await people(ctx.client, pond, 1, { gender: "woman" });
    expect(await statusOf(ctx, noPond)).toBe("incomplete");
    expect(await statusOf(ctx, registered)).toBe("incomplete");
  });

  test("somebody paused, suspended or banned is told nothing is open, by the reader as by the route", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-told-hidden");
    await openPond(ctx.client, pond);
    const [paused, suspended] = await people(ctx.client, pond, 2, ALIKE);
    const [banned] = await people(ctx.client, pond, 1, { ...ALIKE, standing: "banned" });
    if (!paused || !suspended || !banned) throw new Error("people not written");
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [paused]);
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [suspended]);
    const deps = { db: ctx.client, now: () => NIGHT };
    for (const id of [paused, suspended, banned]) {
      expect(await matchingStatusOf(deps, id)).toEqual({ state: "incomplete" });
      expect(await isComplete(ctx.client, id, NIGHT)).toBe(false);
    }
    expect(await openPondOf(ctx.client, paused)).toBeNull();
    expect(await openPondOf(ctx.client, suspended)).toBeNull();
    // Banned on the identity: the account is live, its standing is what keeps it out.
    expect(await openPondOf(ctx.client, banned)).toBe(pond);
  });
});

describe("who is complete", () => {
  test("Only a finished profile and current consents count", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-complete");
    await openPond(ctx.client, pond);
    const [she] = await people(ctx.client, pond, 1, ALIKE);
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
    if (!she || !shadow || !unfinished || !outdated || !paused || !banned) {
      throw new Error("people not written");
    }

    await night(ctx);

    const cards = async (id: string) =>
      (
        await ctx.client.query<{ candidate_id: string }>(
          `SELECT e.candidate_id FROM rounds r JOIN round_entries e ON e.round_id = r.id
            WHERE r.account_id = $1`,
          [id],
        )
      ).rows.map((row) => row.candidate_id);
    // Nobody else of them is a card; the shadow-banned person is in nobody's pool, and has a round.
    expect(await cards(she)).toEqual([]);
    expect(await cards(shadow)).toEqual([she]);
    expect(await statusOf(ctx, shadow)).toBe("open");
    expect(await statusOf(ctx, unfinished)).toBe("incomplete");
    expect(await statusOf(ctx, outdated)).toBe("incomplete");
    for (const id of [unfinished, outdated, paused, banned]) {
      expect(await roundCount(ctx.client, id), id).toBe(0);
    }
  });

  test.for(["terms", "privacy", "special_category"] as const)(
    "the %s consent alone decides: withdrawn, the person is not complete",
    async (kind, { ctx }) => {
      const pond = await pondNamed(ctx.client, `test-complete-consent-${kind}`);
      const [who] = await people(ctx.client, pond, 1, ALIKE);
      if (!who) throw new Error("person not written");
      expect(await isComplete(ctx.client, who, NIGHT)).toBe(true);
      await ctx.client.query(
        "UPDATE consent SET withdrawn_at = now() WHERE account_id = $1 AND kind = $2",
        [who, kind],
      );
      expect(await isComplete(ctx.client, who, NIGHT)).toBe(false);
    },
  );

  test("a person short of one answer (the birth month, the intent, a finished profile) is not complete", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-complete-short");
    const [whole, noBirth, noIntent, noPhotos] = await people(ctx.client, pond, 4, ALIKE);
    await ctx.client.query("UPDATE account SET birth_month = NULL WHERE id = $1", [noBirth]);
    await ctx.client.query("UPDATE profile SET fields = fields - 'intent' WHERE account_id = $1", [
      noIntent,
    ]);
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [noPhotos]);
    expect((await subjectsOfPond(ctx.client, pond, NIGHT)).map((s) => s.id)).toEqual([whole]);
    for (const id of [noBirth, noIntent, noPhotos]) {
      expect(await statusOf(ctx, id), id).toBe("incomplete");
    }
  });

  test("photos sent in conversations finish no profile (#350)", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-complete-message-photos");
    const [whole, messagesOnly] = await people(ctx.client, pond, 2, ALIKE);
    // The same three approved photos, sent in conversations instead.
    await ctx.client.query(
      "UPDATE photo SET purpose = 'message', position = NULL WHERE account_id = $1",
      [messagesOnly],
    );
    expect((await subjectsOfPond(ctx.client, pond, NIGHT)).map((s) => s.id)).toEqual([whole]);
    expect(await statusOf(ctx, messagesOnly)).toBe("incomplete");
  });

  test("a ready line in place of a bio counts as a finished profile, and neither does not (#239)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-complete-ready-line");
    const [line] = await people(ctx.client, pond, 1, { ...ALIKE, bio: "ready_line" });
    const [neither] = await people(ctx.client, pond, 1, { ...ALIKE, bio: "none" });
    expect((await subjectsOfPond(ctx.client, pond, NIGHT)).map((s) => s.id)).toEqual([line]);
    expect(await statusOf(ctx, neither)).toBe("incomplete");
  });

  test("a reader of the person alone says the same", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-complete-one");
    const [whole, short] = await people(ctx.client, pond, 2, ALIKE);
    if (!whole || !short) throw new Error("people not written");
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [short]);
    expect(await isComplete(ctx.client, whole, NIGHT)).toBe(true);
    expect(await isComplete(ctx.client, short, NIGHT)).toBe(false);
    // Closed, or open: completeness does not ask the switch, the invitations' question.
    await openPond(ctx.client, pond);
    expect(await isComplete(ctx.client, whole, NIGHT)).toBe(true);
    expect(await openPondOf(ctx.client, whole)).toBe(pond);
  });
});

describe("a home in the pool (#514, ADR-061)", () => {
  const putHome = async (ctx: TestContext, accountId: string | undefined, postalCode: string) => {
    const who = await signInAs(ctx.client, accountId ?? "");
    return ctx.app.request("/account/home", {
      method: "PUT",
      headers: { ...who.headers, "content-type": "application/json" },
      body: JSON.stringify({ postalCode }),
    });
  };
  const statusRead = (ctx: TestContext, accountId: string | undefined) => async () => {
    const who = await signInAs(ctx.client, accountId ?? "");
    return OnboardingStatus.parse(
      await (await ctx.app.request("/onboarding", { headers: who.headers })).json(),
    );
  };

  test("An active account without a home is in nobody's pool, and the step opens", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-pool-no-home");
    await openPond(ctx.client, pond);
    const [she] = await people(ctx.client, pond, 1, { ...ALIKE, home: null });
    await people(ctx.client, pond, 2, ALIKE);
    expect(await statusOf(ctx, she)).toBe("incomplete");
    expect((await subjectsOfPond(ctx.client, pond, NIGHT)).map((s) => s.id)).not.toContain(she);

    const read = statusRead(ctx, she);
    const before = await read();
    expect(before.state).toBe("active");
    expect(before.home).toBeNull();
    expect(before.missing).toEqual(["home"]);
    expect(before.complete).toBe(false);
    const state = await ctx.client.query("SELECT state FROM account WHERE id = $1", [she]);
    expect(state.rows).toEqual([{ state: "active" }]);

    expect((await putHome(ctx, she, "00530")).status).toBe(200);
    expect((await read()).missing).toEqual([]);
    expect(await statusOf(ctx, she)).toBe("open");
    expect((await subjectsOfPond(ctx.client, pond, NIGHT)).map((s) => s.id)).toContain(she);
  });

  test("A place the list no longer knows reads as no home, and the step opens again", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-pool-left-the-list");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    await ctx.client.query("UPDATE account SET home_place = '12345' WHERE id = $1", [she]);

    const status = await statusRead(ctx, she)();
    expect(status.home).toBeNull();
    expect(status.missing).toContain("home");
    expect(status.state).toBe("active");
    const warned = ctx.logs().filter((line) => line.msg === "home reads as none");
    expect(warned.length).toBeGreaterThan(0);
    expect(warned[0]).toMatchObject({ accountId: she });
    expect(JSON.stringify(ctx.logs())).not.toContain("12345");

    expect(await statusOf(ctx, she)).toBe("incomplete");
    expect(await subjectOf(ctx.client, pond, she ?? "", NIGHT)).toBeNull();

    // A new one is taken like a first.
    expect((await putHome(ctx, she, "00530")).status).toBe(200);
    expect((await subjectOf(ctx.client, pond, she ?? "", NIGHT))?.person.home).toMatchObject(
      pointOf("00530") ?? {},
    );
  });

  test("A raised floor coarsens every read at once, and a lowered one gives back only what the row still holds", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-pool-floor");
    const [area] = await people(ctx.client, pond, 1, { ...ALIKE, home: "00530" });
    const [town] = await people(ctx.client, pond, 1, { ...ALIKE, home: "422" });
    await ctx.client.query("UPDATE account SET home_shows_area = true WHERE id = $1", [area]);
    const who = await signInAs(ctx.client, area ?? "");
    const preview = async () =>
      CardPreviewResponse.parse(
        await (await ctx.app.request("/profile/card", { headers: who.headers })).json(),
      ).card?.place;
    const homeOf = async (id: string | undefined) =>
      (await subjectOf(ctx.client, pond, id ?? "", NIGHT))?.person.home;
    expect(await preview()).toEqual({ fi: "Kallio", sv: "Berghäll" });
    expect(await homeOf(area)).toMatchObject(pointOf("00530") ?? {});

    await withMatchingConfig(ctx.client, { home_min_inhabitants: 20000 });

    // From the next read: the card says the town, and the band is measured from its centre.
    expect(await preview()).toEqual({ fi: "Helsinki", sv: "Helsingfors" });
    expect(await homeOf(area)).toMatchObject(pointOf("091") ?? {});
    const stored = await ctx.client.query("SELECT home_place FROM account WHERE id = $1", [area]);
    expect(stored.rows).toEqual([{ home_place: "00530" }]);

    await withMatchingConfig(ctx.client, { home_min_inhabitants: 1 });

    expect(await preview()).toEqual({ fi: "Kallio", sv: "Berghäll" });
    expect(await homeOf(area)).toMatchObject(pointOf("00530") ?? {});
    expect(await homeOf(town)).toMatchObject(pointOf("422") ?? {});
    expect((await statusRead(ctx, town)()).home).toEqual({
      town: { fi: "Joensuu", sv: "Joensuu" },
      area: null,
      showArea: false,
    });
  });

  test("a home is carried to the pool with the edges of the same read", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-pool-edges");
    const [she] = await people(ctx.client, pond, 1, ALIKE);
    await withMatchingConfig(ctx.client, {
      distance_nearby_km: 1,
      distance_close_km: 2,
      distance_around_km: 3,
    });
    expect((await subjectOf(ctx.client, pond, she ?? "", NIGHT))?.person.home).toEqual({
      ...pointOf("00530"),
      edges: { nearby: 1, close: 2, around: 3 },
    });
  });
});
