import { OnboardingStatus, PreferencesResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { SPECIAL_CATEGORY_CONSENT_VERSION } from "../profile/index.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";

// features/matching/preferences.feature (#46): the two hard rows.

async function appWith(ctx: TestContext) {
  const { logger, lines } = await captureLogger();
  return { app: createApp({ config: testConfig(), logger, db: ctx.client }), logs: lines };
}
type App = Awaited<ReturnType<typeof appWith>>["app"];

const put = (app: App, headers: Record<string, string>, body: unknown) =>
  app.request("/preferences", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("The hard rows refuse what matching cannot use", () => {
  test.for([
    ["none", 25, 35],
    ["women", 17, 35],
    ["women", 25, 100],
    ["women", 35, 25],
    ["women,women", 25, 35],
  ] as const)("seeks %s, %i to %i", async ([seeks, min, max], { ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const body = {
      seeks: seeks === "none" ? [] : seeks.split(",").map(() => "woman"),
      ageWindow: { min, max },
    };
    const response = await put(app, a.headers, body);
    expect(response.status).toBe(400);
    const { rows } = await ctx.client.query("SELECT 1 FROM preferences WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("preferences", () => {
  test("Seeks and the age window are stored as hard rows and read back", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const wanted = { seeks: ["woman", "non_binary"], ageWindow: { min: 25, max: 35 } };
    const saved = await put(app, a.headers, wanted);
    expect(saved.status).toBe(200);
    expect(PreferencesResponse.parse(await saved.json())).toEqual(wanted);
    const read = await app.request("/preferences", { headers: a.headers });
    expect(PreferencesResponse.parse(await read.json())).toEqual(wanted);
    const { rows } = await ctx.client.query<{ field: string; mode: string }>(
      "SELECT field, mode FROM preferences WHERE account_id = $1 ORDER BY field",
      [a.accountId],
    );
    expect(rows).toEqual([
      { field: "age_window", mode: "hard" },
      { field: "seeks", mode: "hard" },
    ]);
    // A second save replaces, never duplicates.
    await put(app, a.headers, { ...wanted, ageWindow: { min: 30, max: 40 } });
    const again = await ctx.client.query("SELECT 1 FROM preferences WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(again.rows).toHaveLength(2);
    // Whom a person seeks never reaches a log line (rule 5).
    expect(JSON.stringify(logs())).not.toContain("non_binary");
  });

  test("Whom one seeks and the age window are saved one at a time", async ({ ctx }) => {
    // Onboarding saves each on its own screen (ADR-010 §13): an app closed between them keeps the first.
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const read = async () =>
      PreferencesResponse.parse(
        await (await app.request("/preferences", { headers: a.headers })).json(),
      );
    const seeks = await put(app, a.headers, { seeks: ["non_binary"] });
    expect(seeks.status).toBe(200);
    expect(await read()).toEqual({ seeks: ["non_binary"], ageWindow: null });
    const ages = await put(app, a.headers, { ageWindow: { min: 25, max: 35 } });
    expect(ages.status).toBe(200);
    expect(await read()).toEqual({ seeks: ["non_binary"], ageWindow: { min: 25, max: 35 } });
    expect((await put(app, a.headers, {})).status).toBe(400);
    expect(await read()).toEqual({ seeks: ["non_binary"], ageWindow: { min: 25, max: 35 } });
    expect(JSON.stringify(logs())).not.toContain("non_binary");
  });

  test("PUT /preferences writes the caller's rows and leaves another account's alone", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const window = { min: 20, max: 30 };
    expect((await put(app, a.headers, { seeks: ["man"], ageWindow: window })).status).toBe(200);
    expect((await put(app, b.headers, { seeks: ["woman"], ageWindow: window })).status).toBe(200);
    const read = async (headers: Record<string, string>) =>
      PreferencesResponse.parse(await (await app.request("/preferences", { headers })).json());
    expect((await read(a.headers)).seeks).toEqual(["man"]);
    expect((await read(b.headers)).seeks).toEqual(["woman"]);
  });

  test("The preferences of another account are never served", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await put(app, a.headers, { seeks: ["man"], ageWindow: { min: 20, max: 30 } });
    const theirs = await app.request("/preferences", { headers: b.headers });
    expect(PreferencesResponse.parse(await theirs.json())).toEqual({
      seeks: null,
      ageWindow: null,
    });
    expect((await app.request("/preferences")).status).toBe(401);
  });
});

describe("the cadence of a change (#147, ADR-015 §9)", () => {
  test("A change of whom one seeks is possible once in the cadence", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const window = { min: 25, max: 35 };
    const status = async () =>
      OnboardingStatus.parse(
        await (await app.request("/onboarding", { headers: a.headers })).json(),
      );
    // The first answer is no change, and the first change is free.
    expect((await put(app, a.headers, { seeks: ["woman"], ageWindow: window })).status).toBe(200);
    expect((await status()).nextChange.seeks).toBeNull();
    expect((await put(app, a.headers, { seeks: ["man"], ageWindow: window })).status).toBe(200);
    const from = (await status()).nextChange.seeks;
    expect(from).not.toBeNull();
    expect(Date.parse(from as string)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // The second change within the cadence is refused, said without a reason.
    const refused = await put(app, a.headers, { seeks: ["non_binary"], ageWindow: window });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "change_too_soon",
    );
    expect(
      PreferencesResponse.parse(
        await (await app.request("/preferences", { headers: a.headers })).json(),
      ).seeks,
    ).toEqual(["man"]);
    // The same answer again, and another window of ages, are no change.
    expect(
      (await put(app, a.headers, { seeks: ["man"], ageWindow: { min: 30, max: 40 } })).status,
    ).toBe(200);
    expect((await status()).nextChange.seeks).toBe(from);
    // Withdrawing the special-category consent takes the seek row with it, and the
    // answer after it counts as a change while one is on record: no way round.
    const consent = await app.request("/consents", {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "special_category",
        version: SPECIAL_CATEGORY_CONSENT_VERSION,
        locale: "fi",
      }),
    });
    expect(consent.status).toBe(200);
    expect(
      (await app.request("/consents/special_category", { method: "DELETE", headers: a.headers }))
        .status,
    ).toBe(200);
    expect((await status()).preferences.seeks).toBeNull();
    const again = await put(app, a.headers, { seeks: ["non_binary"], ageWindow: window });
    expect(again.status).toBe(429);
    expect((await status()).preferences.seeks).toBeNull();
    // Nothing of what is sought reaches a log line (rule 5), the refusals included.
    expect(JSON.stringify(logs())).not.toContain("non_binary");
  });
});
