import { gender } from "@kuutti/db";
import {
  AccountExport,
  ConsentsResponse,
  GENDERS,
  ONBOARDING_STEPS,
  OnboardingStatus,
  ProfileResponse,
} from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { ageInYears, SPECIAL_CATEGORY_CONSENT_VERSION } from "../profile/index.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixturePng, testMediaDeps } from "../test/media.ts";
import {
  activationWaitsFor,
  CURRENT_CONSENT_VERSIONS,
  missingSteps,
  shownLocale,
} from "./onboarding.ts";
import { CONSENT_CHURN_PER_DAY } from "./repo.ts";

// features/identity/onboarding.feature (#46, #146, ADR-010).

async function appWith(ctx: TestContext) {
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps({ concurrency: 2 });
  return {
    app: createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps }),
    logs: lines,
  };
}
type App = Awaited<ReturnType<typeof appWith>>["app"];
type Headers = Record<string, string>;

const jsonHeaders = (headers: Headers) => ({ ...headers, "content-type": "application/json" });
const consent = (app: App, headers: Headers, kind: string, version: string) =>
  app.request("/consents", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ kind, version, locale: "fi" }),
  });
const status = async (app: App, headers: Headers) =>
  OnboardingStatus.parse(await (await app.request("/onboarding", { headers })).json());
const consentRows = async (ctx: TestContext, accountId: string, kind?: string) => {
  const { rows } = await ctx.client.query<{ n: string }>(
    "SELECT count(*) AS n FROM consent WHERE account_id = $1 AND ($2::consent_kind IS NULL OR kind = $2)",
    [accountId, kind ?? null],
  );
  return Number(rows[0]?.n ?? 0);
};

async function pond(ctx: TestContext) {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('test-otaniemi', 'Otaniemi', 'Otaniemessä') RETURNING id`,
  );
  return rows[0]?.id ?? "";
}

/** Every answer activation needs, in the order the app asks (#146); returns the pond id. */
async function onboard(
  ctx: TestContext,
  app: App,
  headers: Headers,
  options: { research?: boolean } = {},
) {
  const pondId = await pond(ctx);
  await consent(app, headers, "terms", CURRENT_CONSENT_VERSIONS.terms);
  await consent(app, headers, "privacy", CURRENT_CONSENT_VERSIONS.privacy);
  await app.request("/account/gender", {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ gender: "woman" }),
  });
  // The seek answer needs the special-category consent (ADR-019 §4): the app records it on the same screen.
  await consent(app, headers, "special_category", CURRENT_CONSENT_VERSIONS.special_category);
  await app.request("/preferences", {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ seeks: ["man", "non_binary"], ageWindow: { min: 25, max: 35 } }),
  });
  await app.request("/account/pond", {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ pondId }),
  });
  if (options.research) await consent(app, headers, "research", CURRENT_CONSENT_VERSIONS.research);
  return pondId;
}

const PROFILE = {
  displayName: "Aino",
  bio: "A bio long enough to count for completeness, which is fifty characters.",
  bioPreset: null,
  fields: { intent: "casual" },
  prompts: [],
  specialCategoryConsent: null,
};
const putProfile = (app: App, headers: Headers, body: unknown) =>
  app.request("/profile", {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });
async function uploadPhotos(app: App, headers: Headers, n: number) {
  for (let i = 0; i < n; i += 1) {
    const form = new FormData();
    const bytes = await fixturePng(48 + i, 48);
    form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "p.png");
    const response = await app.request("/photos", { method: "POST", headers, body: form });
    expect(response.status).toBe(201);
  }
}

describe("onboarding and consents", () => {
  test("A consent counts only for the current version of its wording", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const refused = await consent(app, a.headers, "terms", "2020-01-old");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "agreement_outdated",
    );
    expect(await consentRows(ctx, a.accountId)).toBe(0);
    const accepted = await consent(app, a.headers, "terms", CURRENT_CONSENT_VERSIONS.terms);
    expect(accepted.status).toBe(200);
    const body = ConsentsResponse.parse(await accepted.json());
    expect(body.consents).toMatchObject([
      { kind: "terms", version: CURRENT_CONSENT_VERSIONS.terms, locale: "fi", withdrawnAt: null },
    ]);
    expect(body.currentVersions).toEqual(CURRENT_CONSENT_VERSIONS);
    expect((await status(app, a.headers)).consents.terms).toBe(CURRENT_CONSENT_VERSIONS.terms);
  });

  test("The same consent is recorded once", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(app, a.headers, "privacy", CURRENT_CONSENT_VERSIONS.privacy);
    await consent(app, a.headers, "privacy", CURRENT_CONSENT_VERSIONS.privacy);
    expect(await consentRows(ctx, a.accountId, "privacy")).toBe(1);
    expect(logs().filter((l) => l.msg === "consent given")).toHaveLength(1);
  });

  test("The research opt-in can be withdrawn and given again", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(app, a.headers, "research", CURRENT_CONSENT_VERSIONS.research);
    const withdrawn = await app.request("/consents/research", {
      method: "DELETE",
      headers: a.headers,
    });
    expect(withdrawn.status).toBe(200);
    expect(ConsentsResponse.parse(await withdrawn.json()).consents[0]?.withdrawnAt).not.toBeNull();
    expect((await status(app, a.headers)).consents.research).toBeNull();
    await consent(app, a.headers, "research", CURRENT_CONSENT_VERSIONS.research);
    const { rows } = await ctx.client.query<{ withdrawn_at: Date | null }>(
      "SELECT withdrawn_at FROM consent WHERE account_id = $1 AND kind = 'research' ORDER BY given_at",
      [a.accountId],
    );
    expect(rows.map((r) => r.withdrawn_at !== null)).toEqual([true, false]);
    expect((await status(app, a.headers)).consents.research?.version).toBe(
      CURRENT_CONSENT_VERSIONS.research,
    );
  });

  test("Terms and privacy have no withdrawal route", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(app, a.headers, "terms", CURRENT_CONSENT_VERSIONS.terms);
    for (const kind of ["terms", "privacy", "anything"]) {
      expect(
        (await app.request(`/consents/${kind}`, { method: "DELETE", headers: a.headers })).status,
      ).toBe(400);
    }
    expect(await consentRows(ctx, a.accountId, "terms")).toBe(1);
  });

  test("The account becomes active when every required answer is there", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const before = await status(app, a.headers);
    expect(before).toMatchObject({
      state: "registered",
      complete: false,
      missing: [...ONBOARDING_STEPS],
      // signedInAccount registers the account as born 1990-06; the default age window is built around this.
      age: ageInYears(1990, 6, new Date()),
    });
    await app.request("/account/gender", {
      method: "PUT",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ gender: "non_binary" }),
    });
    expect((await status(app, a.headers)).missing).toEqual(
      ONBOARDING_STEPS.filter((step) => step !== "gender"),
    );
    const pondId = await onboard(ctx, app, a.headers);
    const after = await status(app, a.headers);
    // Active on the six of ADR-010 §6; the profile steps of the sheet stay open (#146).
    expect(after).toMatchObject({
      state: "active",
      complete: false,
      missing: ["name", "intent", "photos", "prompts_or_bio"],
      gender: "woman",
      pond: { id: pondId, name: "Otaniemi", nameInessive: "Otaniemessä" },
      preferences: { seeks: ["man", "non_binary"], ageWindow: { min: 25, max: 35 } },
      consents: { specialCategory: CURRENT_CONSENT_VERSIONS.special_category },
    });
    const { rows } = await ctx.client.query<{ state: string }>(
      "SELECT state FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(rows[0]?.state).toBe("active");
    expect(logs().filter((l) => l.msg === "account activated")).toHaveLength(1);
    // Read again: still active, activated once.
    expect((await status(app, a.headers)).state).toBe("active");
    expect(logs().filter((l) => l.msg === "account activated")).toHaveLength(1);
    // Nothing in the log says whom the person seeks or which gender they declared.
    expect(JSON.stringify(logs())).not.toContain("non_binary");
  });

  test("Research is never required for activation", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await onboard(ctx, app, a.headers);
    const done = await status(app, a.headers);
    expect(done.state).toBe("active");
    expect(done.consents.research).toBeNull();
  });

  test("Erasure removes the preferences, keeps the consents and blanks gender and pond", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await onboard(ctx, app, a.headers, { research: true });
    expect(await consentRows(ctx, a.accountId)).toBe(4);
    const deleted = await app.request("/account/delete", {
      method: "POST",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ confirm: true }),
    });
    expect(deleted.status).toBe(204);
    const preferences = await ctx.client.query("SELECT 1 FROM preferences WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(preferences.rows).toHaveLength(0);
    expect(await consentRows(ctx, a.accountId)).toBe(4);
    const { rows } = await ctx.client.query<{
      state: string;
      gender: string | null;
      pond_id: string | null;
    }>("SELECT state, gender, pond_id FROM account WHERE id = $1", [a.accountId]);
    expect(rows[0]).toEqual({ state: "deleted", gender: null, pond_id: null });
  });

  test("The export lists gender, pond, preferences and every consent", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const pondId = await onboard(ctx, app, a.headers, { research: true });
    await app.request("/consents/research", { method: "DELETE", headers: a.headers });
    const exported = AccountExport.parse(
      await (await app.request("/account/export", { headers: a.headers })).json(),
    );
    expect(exported.account.gender).toBe("woman");
    expect(exported.account.pond).toMatchObject({
      id: pondId,
      name: "Otaniemi",
      nameInessive: "Otaniemessä",
    });
    expect(exported.preferences).toEqual({
      seeks: ["man", "non_binary"],
      ageWindow: { min: 25, max: 35 },
    });
    expect(exported.consents.map((c) => [c.kind, c.withdrawnAt !== null])).toEqual([
      ["terms", false],
      ["privacy", false],
      ["special_category", false],
      ["research", true],
    ]);
  });

  test("A change of gender is possible once in the cadence", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const declare = (gender: string) =>
      app.request("/account/gender", {
        method: "PUT",
        headers: jsonHeaders(a.headers),
        body: JSON.stringify({ gender }),
      });
    expect((await declare("woman")).status).toBe(204);
    expect((await status(app, a.headers)).nextChange.gender).toBeNull();
    expect((await declare("man")).status).toBe(204);
    const from = (await status(app, a.headers)).nextChange.gender;
    expect(from).not.toBeNull();
    expect(Date.parse(from as string)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const refused = await declare("non_binary");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "change_too_soon",
    );
    expect((await status(app, a.headers)).gender).toBe("man");
    expect((await declare("man")).status).toBe(204);
    expect((await status(app, a.headers)).nextChange.gender).toBe(from);
    // The values stay out of the log, the refusal included.
    expect(JSON.stringify(logs())).not.toContain("non_binary");
  });

  test("unauthenticated: 401 on every onboarding, consent, pond and preference route", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    for (const [method, path] of [
      ["GET", "/onboarding"],
      ["PUT", "/account/gender"],
      ["GET", "/consents"],
      ["POST", "/consents"],
      ["DELETE", "/consents/research"],
      ["DELETE", "/consents/special_category"],
      ["GET", "/ponds"],
      ["PUT", "/account/pond"],
      ["GET", "/preferences"],
      ["PUT", "/preferences"],
    ] as const) {
      expect((await app.request(path, { method })).status, `${method} ${path}`).toBe(401);
    }
  });

  test("validation: a gender or a consent outside the closed lists is refused", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const post = (path: string, method: string, body: unknown) =>
      app.request(path, { method, headers: jsonHeaders(a.headers), body: JSON.stringify(body) });
    for (const [path, method, body] of [
      ["/account/gender", "PUT", { gender: "female" }],
      ["/account/gender", "PUT", { gender: "woman", extra: 1 }],
      ["/consents", "POST", { kind: "cookies", version: "1", locale: "fi" }],
      [
        "/consents",
        "POST",
        { kind: "terms", version: CURRENT_CONSENT_VERSIONS.terms, locale: "de" },
      ],
      ["/account/pond", "PUT", { pondId: "not-a-uuid" }],
    ] as const) {
      const response = await post(path, method, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await consentRows(ctx, a.accountId)).toBe(0);
  });

  test("The language on the row is one the wording exists in", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    // No Swedish legal text has been written: a Swedish phone read the English fallback.
    const response = await app.request("/consents", {
      method: "POST",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({
        kind: "terms",
        version: CURRENT_CONSENT_VERSIONS.terms,
        locale: "sv",
      }),
    });
    expect(response.status).toBe(200);
    expect(ConsentsResponse.parse(await response.json()).consents[0]?.locale).toBe("en");
    expect(shownLocale("terms", "fi")).toBe("fi");
    expect(shownLocale("terms", "sv")).toBe("en");
  });

  test("The research opt-in cannot be toggled without bound", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    for (let i = 0; i < CONSENT_CHURN_PER_DAY; i += 1) {
      expect(
        (await consent(app, a.headers, "research", CURRENT_CONSENT_VERSIONS.research)).status,
      ).toBe(200);
      await app.request("/consents/research", { method: "DELETE", headers: a.headers });
    }
    const refused = await consent(app, a.headers, "research", CURRENT_CONSENT_VERSIONS.research);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "too_many_changes",
    );
    expect(await consentRows(ctx, a.accountId, "research")).toBe(CONSENT_CHURN_PER_DAY);
    // The list stays within the cap of the contract however many rows exist.
    const listed = ConsentsResponse.parse(
      await (await app.request("/consents", { headers: a.headers })).json(),
    );
    expect(listed.consents.length).toBeLessThanOrEqual(100);
  });

  test("A long research history hides neither the required consents nor any proof row", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(app, a.headers, "terms", CURRENT_CONSENT_VERSIONS.terms);
    await consent(app, a.headers, "privacy", CURRENT_CONSENT_VERSIONS.privacy);
    // More rows than GET /consents lists, written straight in: the churn cap keeps a day to ten.
    await ctx.client.query(
      `INSERT INTO consent (account_id, kind, version, locale_shown, given_at, withdrawn_at)
       SELECT $1, 'research', $2, 'fi', now() + (g || ' seconds')::interval, now() + (g || ' seconds')::interval
       FROM generate_series(1, 120) AS g`,
      [a.accountId, CURRENT_CONSENT_VERSIONS.research],
    );
    const shown = await status(app, a.headers);
    expect(shown.consents.terms).toBe(CURRENT_CONSENT_VERSIONS.terms);
    expect(shown.consents.privacy).toBe(CURRENT_CONSENT_VERSIONS.privacy);
    expect(shown.missing).not.toContain("terms");
    const listed = ConsentsResponse.parse(
      await (await app.request("/consents", { headers: a.headers })).json(),
    );
    expect(listed.consents).toHaveLength(100);
    const exported = AccountExport.parse(
      await (await app.request("/account/export", { headers: a.headers })).json(),
    );
    expect(exported.consents).toHaveLength(122);
  });

  test("Withdrawing on an erased account writes nothing", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(app, a.headers, "research", CURRENT_CONSENT_VERSIONS.research);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]);
    const refused = await app.request("/consents/research", {
      method: "DELETE",
      headers: a.headers,
    });
    // The guard may already refuse the token of a deleted account; the writer refuses on its own too.
    expect([401, 404]).toContain(refused.status);
    const { rows } = await ctx.client.query(
      "SELECT 1 FROM consent WHERE account_id = $1 AND withdrawn_at IS NOT NULL",
      [a.accountId],
    );
    expect(rows).toHaveLength(0);
  });

  it("GENDERS mirrors the database enum", () => {
    expect([...GENDERS]).toEqual([...gender.enumValues]);
  });

  it("missingSteps names the open steps in the sheet's order, never research, and activation waits for six of them", () => {
    const none = missingSteps({
      gender: null,
      preferences: { seeks: null, ageWindow: null },
      pond: null,
      terms: null,
      privacy: null,
      specialCategory: null,
      profile: { name: false, intent: false, photos: false, promptsOrBio: false },
    });
    expect(none).toEqual([...ONBOARDING_STEPS]);
    const answered = {
      gender: "man" as const,
      preferences: { seeks: ["woman" as const], ageWindow: { min: 20, max: 30 } },
      pond: { id: "p", slug: "s", name: "n", nameInessive: "i", parentId: null },
      terms: "v",
      privacy: "v",
      specialCategory: "v",
      profile: { name: true, intent: true, photos: true, promptsOrBio: true },
    };
    expect(missingSteps(answered)).toEqual([]);
    // A seek answer without the special-category consent is no answer (ADR-019 §4);
    // the profile steps keep the flow open and never hold the state (ADR-010 §6, §10).
    const open = missingSteps({
      ...answered,
      specialCategory: null,
      profile: { name: false, intent: false, photos: false, promptsOrBio: true },
    });
    expect(open).toEqual(["name", "seeks", "intent", "photos"]);
    expect(activationWaitsFor(open)).toEqual(["seeks"]);
  });

  test("The onboarding lists the profile steps the sheet asks, in its order", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await onboard(ctx, app, a.headers);
    expect((await status(app, a.headers)).missing).toEqual([
      "name",
      "intent",
      "photos",
      "prompts_or_bio",
    ]);
    expect((await putProfile(app, a.headers, PROFILE)).status).toBe(200);
    expect((await status(app, a.headers)).missing).toEqual(["photos"]);
    // Uploaded counts here, with the moderator still to look (ADR-006); the card waits for approval.
    await uploadPhotos(app, a.headers, 3);
    const done = await status(app, a.headers);
    expect(done.missing).toEqual([]);
    expect(done.complete).toBe(true);
    expect(done.state).toBe("active");
  });

  test("An account gets the default pond without a pond step", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    // The seed pond, which matching_config.default_pond names (migration 0020); the test database has no seed.
    const { rows } = await ctx.client.query<{ id: string }>(
      "INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('suomi', 'Suomi', 'Suomessa') RETURNING id",
    );
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const first = await status(app, a.headers);
    expect(first.pond).toMatchObject({ id: rows[0]?.id, slug: "suomi", nameInessive: "Suomessa" });
    expect(first.missing).not.toContain("pond");
    expect(logs().filter((l) => l.msg === "pond assigned")).toHaveLength(1);
    const stored = await ctx.client.query<{ pond_id: string }>(
      "SELECT pond_id FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(stored.rows[0]?.pond_id).toBe(rows[0]?.id);
    // Assigned once: the next read finds it and says nothing.
    await status(app, a.headers);
    expect(logs().filter((l) => l.msg === "pond assigned")).toHaveLength(1);
  });

  test("The seek consent is recorded with the answer and withdrawing it blanks the seek rows", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await onboard(ctx, app, a.headers);
    const saved = await putProfile(app, a.headers, {
      ...PROFILE,
      fields: { ...PROFILE.fields, politics: ["vihr"] },
      specialCategoryConsent: { version: SPECIAL_CATEGORY_CONSENT_VERSION },
    });
    expect(saved.status).toBe(200);
    const withdrawn = await app.request("/consents/special_category", {
      method: "DELETE",
      headers: a.headers,
    });
    expect(withdrawn.status).toBe(200);
    expect(
      ConsentsResponse.parse(await withdrawn.json()).consents.find(
        (c) => c.kind === "special_category",
      )?.withdrawnAt,
    ).not.toBeNull();
    const after = await status(app, a.headers);
    expect(after.preferences).toEqual({ seeks: null, ageWindow: { min: 25, max: 35 } });
    expect(after.consents.specialCategory).toBeNull();
    expect(after.missing).toContain("seeks");
    const profile = ProfileResponse.parse(
      await (await app.request("/profile", { headers: a.headers })).json(),
    );
    expect(profile.profile?.fields).toEqual({ intent: "casual" });
    expect(profile.profile?.specialCategoryConsent).toBeNull();
    expect(logs().filter((l) => l.msg === "special-category answers cleared")).toHaveLength(1);
    // The value never reached a log line (rule 5).
    expect(JSON.stringify(logs())).not.toContain("vihr");
  });
});
