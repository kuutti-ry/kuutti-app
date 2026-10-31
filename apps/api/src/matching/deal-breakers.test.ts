import { DealBreakersResponse, type ProfileUpdate } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { exportOf } from "../test/export.ts";
import { type TestContext, test } from "../test/harness.ts";

// features/matching/preferences.feature (#149): the deal-breakers under the
// disclose-to-filter rule. Hard rows beside the two of onboarding; #87 applies them.

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
const taller = { field: "height", accept: ["taller"], includeUnknown: true };

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
    [
      "a deal-breaker on height accepting no relation of height",
      [{ ...taller, accept: ["180"] }],
      400,
    ],
    [
      "a deal-breaker on height accepting two relations",
      [{ ...taller, accept: ["taller", "shorter"] }],
      400,
    ],
  ] as const)("%s", async ([, dealBreakers, status], { ctx }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);
    // Wanting kids is left unanswered: leaving a field open is "prefer not to say", and unlocks nothing.
    const own = await answer(ctx.app, a.headers, {
      smoking: "never",
      hasKids: "no",
      monogamy: "monogamous",
      height: 170,
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

    // The set replaced by a smaller one: the other row goes, the two rows of onboarding stand.
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [kids] })).status).toBe(200);
    expect(await storedRows(ctx, a.accountId)).toEqual([
      { field: "age_window", mode: "hard" },
      { field: "hasKids", mode: "hard" },
      { field: "seeks", mode: "hard" },
    ]);
    expect((await exportOf(ctx.app, a.headers)).dealBreakers).toEqual([{ ...kids, paused: false }]);

    // What a person accepts never reaches a log line (rule 5): how many, and nothing else.
    expect(JSON.stringify(ctx.logs())).not.toContain("quitting");
    expect(
      ctx
        .logs()
        .filter((line) => line.msg === "deal-breakers saved")
        .map((line) => line.dealBreakers),
    ).toEqual([2, 1]);
  });

  test("A deal-breaker on height is stored as one relation to the person's own height", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);
    expect((await answer(ctx.app, a.headers, { height: 170 })).status).toBe(200);

    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [taller] })).status).toBe(
      200,
    );
    expect(await readDealBreakers(ctx.app, a.headers)).toEqual({
      dealBreakers: [{ ...taller, paused: false }],
      max: 2,
    });
    expect(await storedRows(ctx, a.accountId)).toEqual([{ field: "height", mode: "hard" }]);

    // Another relation replaces the first, with the switch for those who did not answer.
    const shorter = { field: "height", accept: ["shorter"], includeUnknown: false };
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [shorter] })).status).toBe(
      200,
    );
    expect((await readDealBreakers(ctx.app, a.headers)).dealBreakers).toEqual([
      { ...shorter, paused: false },
    ]);
    expect(await storedRows(ctx, a.accountId)).toEqual([{ field: "height", mode: "hard" }]);
    expect((await exportOf(ctx.app, a.headers)).dealBreakers).toEqual([
      { ...shorter, paused: false },
    ]);

    // Everyone is having none: the set without it.
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [] })).status).toBe(200);
    expect(await storedRows(ctx, a.accountId)).toEqual([]);

    expect(JSON.stringify(ctx.logs())).not.toMatch(/shorter|taller/);
  });

  test("a deal-breaker on height waits for the person's own height, and keeps its relation", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);

    const refused = await putDealBreakers(ctx.app, a.headers, { dealBreakers: [taller] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "filter_unanswered" } });

    expect((await answer(ctx.app, a.headers, { height: 170 })).status).toBe(200);
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [taller] })).status).toBe(
      200,
    );
    // The height taken back: paused, and nothing is deleted.
    expect((await answer(ctx.app, a.headers, {})).status).toBe(200);
    expect((await readDealBreakers(ctx.app, a.headers)).dealBreakers).toEqual([
      { ...taller, paused: true },
    ]);
    // Paused, another relation waits for the answer too.
    const changed = await putDealBreakers(ctx.app, a.headers, {
      dealBreakers: [{ ...taller, accept: ["shorter"] }],
    });
    expect(changed.status).toBe(409);
  });

  test("how many a person may hold is the config's, up to one per field (#508)", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    expect(
      (
        await answer(ctx.app, a.headers, {
          monogamy: "monogamous",
          hasKids: "no",
          wantsKids: "want",
          smoking: "never",
          languages: ["fi"],
          height: 170,
        })
      ).status,
    ).toBe(200);
    const all = [
      smoking,
      kids,
      taller,
      { field: "monogamy", accept: ["monogamous"], includeUnknown: false },
      { field: "wantsKids", accept: ["want"], includeUnknown: false },
      { field: "languages", accept: ["fi"], includeUnknown: false },
    ];

    await withMatchingConfig(ctx.client, { deal_breakers_max: 5 });
    const over = await putDealBreakers(ctx.app, a.headers, { dealBreakers: all });
    expect(over.status).toBe(400);
    expect(await storedRows(ctx, a.accountId)).toEqual([]);

    await withMatchingConfig(ctx.client, { deal_breakers_max: 6 });
    expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: all })).status).toBe(200);
    const read = await readDealBreakers(ctx.app, a.headers);
    expect(read.max).toBe(6);
    expect(read.dealBreakers.map((d) => d.field).sort()).toEqual(all.map((d) => d.field).sort());
  });

  test("a paused deal-breaker sent back as it stands is kept, and the others save around it", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const a = await signedInAccount(ctx.client);
    expect((await answer(ctx.app, a.headers, { smoking: "never", hasKids: "no" })).status).toBe(
      200,
    );
    expect(
      (await putDealBreakers(ctx.app, a.headers, { dealBreakers: [kids, smoking] })).status,
    ).toBe(200);
    // The smoking answer taken back: that filter pauses, and the screen sends it back with every save.
    expect((await answer(ctx.app, a.headers, { hasKids: "no" })).status).toBe(200);

    const changedKids = { ...kids, includeUnknown: false };
    const saved = await putDealBreakers(ctx.app, a.headers, {
      dealBreakers: [changedKids, { ...smoking, accept: [...smoking.accept] }],
    });

    expect(saved.status).toBe(200);
    expect(await readDealBreakers(ctx.app, a.headers)).toEqual({
      dealBreakers: [
        { ...changedKids, paused: false },
        { ...smoking, paused: true },
      ],
      max: 2,
    });
  });

  test.for([
    ["its accepted answers", { ...smoking, accept: ["never", "quitting"] }],
    ["its switch for those who did not answer", { ...smoking, includeUnknown: true }],
  ] as const)(
    "a paused deal-breaker's %s cannot change until its field is answered",
    async ([, changed], { ctx }) => {
      await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
      const a = await signedInAccount(ctx.client);
      expect((await answer(ctx.app, a.headers, { smoking: "never" })).status).toBe(200);
      expect((await putDealBreakers(ctx.app, a.headers, { dealBreakers: [smoking] })).status).toBe(
        200,
      );
      expect((await answer(ctx.app, a.headers, { hasKids: "no" })).status).toBe(200);

      const refused = await putDealBreakers(ctx.app, a.headers, { dealBreakers: [changed] });

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "filter_unanswered" } });
      expect(await readDealBreakers(ctx.app, a.headers)).toEqual({
        dealBreakers: [{ ...smoking, paused: true }],
        max: 2,
      });
    },
  );

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
      max: 6,
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
