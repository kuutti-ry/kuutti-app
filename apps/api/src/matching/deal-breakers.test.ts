import { DealBreakersResponse, type ProfileUpdate } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { type TestContext, test } from "../test/harness.ts";

// features/matching/preferences.feature (#149): the deal-breakers under the
// disclose-to-filter rule. Hard rows beside onboarding's two; #87 applies them.

type App = TestContext["app"];
type Headers = Record<string, string>;
const PATH = "/preferences/deal-breakers";
const jsonHeaders = (headers: Headers) => ({ ...headers, "content-type": "application/json" });

const putDealBreakers = (app: App, headers: Headers, body: unknown) =>
  app.request(PATH, { method: "PUT", headers: jsonHeaders(headers), body: JSON.stringify(body) });

const readDealBreakers = async (app: App, headers: Headers) => {
  const response = await app.request(PATH, { headers });
  expect(response.status).toBe(200);
  return DealBreakersResponse.parse(await response.json());
};

/** The person's own answers, saved as the whole document the profile route takes. */
const answer = (app: App, headers: Headers, fields: ProfileUpdate["fields"]) =>
  app.request("/profile", {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      displayName: "Aino",
      bio: null,
      bioPreset: null,
      fields,
      prompts: [],
      specialCategoryConsent: null,
    } satisfies ProfileUpdate),
  });

const storedRows = async (ctx: TestContext, accountId: string) =>
  (
    await ctx.client.query<{ field: string; mode: string }>(
      "SELECT field, mode FROM preferences WHERE account_id = $1 ORDER BY field",
      [accountId],
    )
  ).rows;

const smoking = { field: "smoking", accept: ["never"], includeUnknown: false };
const kids = { field: "hasKids", accept: ["no"], includeUnknown: true };

describe("A deal-breaker the rule refuses is not stored", () => {
  test.for([
    [
      "a third deal-breaker",
      [smoking, kids, { field: "monogamy", accept: ["monogamous"], includeUnknown: false }],
      400,
    ],
    [
      "a deal-breaker on a field outside the whitelist",
      [{ field: "intent", accept: ["long_term"], includeUnknown: false }],
      400,
    ],
    [
      "a deal-breaker on a field it has not answered",
      [{ field: "wantsKids", accept: ["want"], includeUnknown: false }],
      409,
    ],
    [
      "a deal-breaker accepting an answer the field has not",
      [{ ...smoking, accept: ["cigars"] }],
      400,
    ],
    ["the same field twice", [smoking, { ...smoking, accept: ["quitting"] }], 400],
  ] as const)("%s", async ([, dealBreakers, status], { ctx }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);
    // Wanting kids is left unanswered: leaving a field open is "prefer not to say", and unlocks nothing.
    const own = await answer(ctx.app, a.headers, {
      smoking: "never",
      hasKids: "no",
      monogamy: "monogamous",
    });
    expect(own.status).toBe(200);
    const response = await putDealBreakers(ctx.app, a.headers, { dealBreakers });
    expect(response.status).toBe(status);
    if (status === 409) {
      expect(await response.json()).toMatchObject({ error: { code: "filter_unanswered" } });
      // The field reaches the log, never a value (the envelope carries no detail).
      expect(ctx.logs().some((line) => line.code === "filter_unanswered")).toBe(true);
    }
    expect(await storedRows(ctx, a.accountId)).toEqual([]);
  });
});

describe("deal-breakers", () => {
  test("Deal-breakers are stored as hard rows beside onboarding's and paused while the own answer is missing", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);
    const onboarding = await ctx.app.request("/preferences", {
      method: "PUT",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ seeks: ["woman"], ageWindow: { min: 25, max: 35 } }),
    });
    expect(onboarding.status).toBe(200);
    expect((await answer(ctx.app, a.headers, { smoking: "never", hasKids: "no" })).status).toBe(
      200,
    );

    const wanted = [kids, { ...smoking, accept: ["never", "quitting"] }];
    const saved = await putDealBreakers(ctx.app, a.headers, {
      dealBreakers: [wanted[1], wanted[0]],
    });
    expect(saved.status).toBe(200);
    const asStored = { dealBreakers: wanted.map((d) => ({ ...d, paused: false })), max: 2 };
    expect(DealBreakersResponse.parse(await saved.json())).toEqual(asStored);
    expect(await readDealBreakers(ctx.app, a.headers)).toEqual(asStored);
    expect(await storedRows(ctx, a.accountId)).toEqual([
      { field: "age_window", mode: "hard" },
      { field: "hasKids", mode: "hard" },
      { field: "seeks", mode: "hard" },
      { field: "smoking", mode: "hard" },
    ]);

    // The smoking answer taken back: that filter pauses, nothing is deleted.
    expect((await answer(ctx.app, a.headers, { hasKids: "no" })).status).toBe(200);
    const paused = await readDealBreakers(ctx.app, a.headers);
    expect(paused.dealBreakers.map((d) => [d.field, d.paused])).toEqual([
      ["hasKids", false],
      ["smoking", true],
    ]);
    expect(await storedRows(ctx, a.accountId)).toHaveLength(4);

    // Answered again, differently: the filter stands as it was set.
    expect((await answer(ctx.app, a.headers, { hasKids: "no", smoking: "sometimes" })).status).toBe(
      200,
    );
    expect(await readDealBreakers(ctx.app, a.headers)).toEqual(asStored);

    // The set replaced by a smaller one: the other row goes, onboarding's two stand.
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [kids] })).status).toBe(200);
    expect(await storedRows(ctx, a.accountId)).toEqual([
      { field: "age_window", mode: "hard" },
      { field: "hasKids", mode: "hard" },
      { field: "seeks", mode: "hard" },
    ]);
    const exported = await ctx.app.request("/account/export", { headers: a.headers });
    expect(exported.status).toBe(200);
    expect(((await exported.json()) as { dealBreakers: unknown }).dealBreakers).toEqual([
      { ...kids, paused: false },
    ]);

    // What a person accepts never reaches a log line (rule 5): how many, and nothing else.
    expect(JSON.stringify(ctx.logs())).not.toContain("quitting");
    expect(
      ctx
        .logs()
        .filter((line) => line.msg === "deal-breakers saved")
        .map((line) => line.dealBreakers),
    ).toEqual([2, 1]);
  });

  test("The deal-breakers of another account are never served", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    expect((await answer(ctx.app, a.headers, { smoking: "never" })).status).toBe(200);
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [smoking] })).status).toBe(
      200,
    );
    expect(await readDealBreakers(ctx.app, b.headers)).toEqual({ dealBreakers: [], max: 2 });
  });

  test("a max above the ceiling and an option that left the registry are read within the contract", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 9 });
    const a = await signedInAccount(ctx.client);
    expect((await answer(ctx.app, a.headers, { smoking: "never", hasKids: "no" })).status).toBe(
      200,
    );
    // Rows as a retired option would leave them: one still has an option, the other none.
    for (const [field, value] of [
      ["smoking", ["never", "cigars"]],
      ["hasKids", ["adopted"]],
    ] as const) {
      await ctx.client.query(
        `INSERT INTO preferences (account_id, field, value, mode, include_unknown, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'hard', false, now(), now())`,
        [a.accountId, field, JSON.stringify(value)],
      );
    }
    expect(await readDealBreakers(ctx.app, a.headers)).toEqual({
      dealBreakers: [{ ...smoking, paused: false }],
      max: 5,
    });
    // The next save sends the set as read: the row with nothing left goes with it.
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [smoking] })).status).toBe(
      200,
    );
    expect((await storedRows(ctx, a.accountId)).map((r) => r.field)).toEqual(["smoking"]);
  });

  test("the deal-breaker routes need a session", async ({ ctx }) => {
    expect((await ctx.app.request(PATH)).status).toBe(401);
    expect((await ctx.app.request(PATH, { method: "PUT" })).status).toBe(401);
  });
});
