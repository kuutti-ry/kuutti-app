import {
  AccountExport,
  CARD_FIELD_KEYS,
  CardPreviewResponse,
  HOBBIES,
  Photo,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  ProfileResponse,
  type ProfileUpdate,
} from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixturePng, testMediaDeps } from "../test/media.ts";
import { ageInYears, buildCard } from "./card.ts";
import { consentMissingFor, SPECIAL_CATEGORY_CONSENT_VERSION } from "./service.ts";

// The profile routes end to end (#47, ADR-009): real Postgres in a rolled-back
// transaction, photos through the API with a memory store. Happy path,
// validation failure, unauthenticated, and the card for another viewer.

async function appWith(ctx: TestContext) {
  await withMatchingConfig(ctx.client, { max_photos: 3, exposure_cards_per_day: 1 });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps({ concurrency: 2 });
  const app = createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps });
  return { app, logger, logs: lines };
}
type App = Awaited<ReturnType<typeof appWith>>["app"];

const update: ProfileUpdate = {
  displayName: "Aino",
  bio: null,
  bioPreset: "lazy_nice_fellow",
  fields: {
    languages: ["fi", "en"],
    intent: "long_term",
    smoking: "never",
    occupationTitle: "Architect",
  },
  prompts: [
    { key: "sunday", answer: "A long breakfast and a longer walk." },
    { key: "hidden_talent", answer: "I can whistle with my mouth full." },
  ],
  specialCategoryConsent: null,
};

const put = (app: App, headers: Record<string, string>, body: unknown) =>
  app.request("/profile", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function upload(app: App, headers: Record<string, string>, bytes: Buffer): Promise<Photo> {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "p.png");
  const response = await app.request("/photos", { method: "POST", headers, body: form });
  expect(response.status).toBe(201);
  return Photo.parse(await response.json());
}

async function approvedPhotos(
  ctx: TestContext,
  app: App,
  headers: Record<string, string>,
  n: number,
) {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const photo = await upload(app, headers, await fixturePng(48 + i, 48));
    await ctx.client.query("UPDATE photo SET state = 'approved' WHERE id = $1", [photo.id]);
    ids.push(photo.id);
  }
  return ids;
}

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("profile routes", () => {
  test("GET /profile before the first save answers null and everything missing", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const response = await app.request("/profile", { headers: a.headers });
    expect(response.status).toBe(200);
    const body = ProfileResponse.parse(await response.json());
    expect(body.profile).toBeNull();
    expect(body.completeness).toEqual({
      complete: false,
      missing: ["display_name", "photos", "bio_or_prompts", "seeks", "age_window"],
    });
  });

  test("PUT /profile saves the whole document and answers it back with its completeness", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const saved = await put(app, a.headers, update);
    expect(saved.status).toBe(200);
    const body = ProfileResponse.parse(await saved.json());
    expect(body.profile).toMatchObject({
      displayName: "Aino",
      bio: null,
      bioPreset: "lazy_nice_fellow",
      fields: update.fields,
      prompts: update.prompts,
      specialCategoryConsent: null,
    });
    // Two prompts stand in for the bio; photos and onboarding are still missing.
    expect(body.completeness.missing).toEqual(["photos", "seeks", "age_window"]);
    const again = await put(app, a.headers, { ...update, displayName: "Aino V.", prompts: [] });
    expect(ProfileResponse.parse(await again.json()).profile?.displayName).toBe("Aino V.");
    const { rows } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM profile WHERE account_id = $1",
      [a.accountId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(logs().find((l) => l.msg === "profile saved")).toMatchObject({ accountId: a.accountId });
  });

  test("PUT /profile refuses what the registry does not know", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const refused = [
      { ...update, fields: { ...update.fields, smoking: "cigars" } },
      { ...update, fields: { ...update.fields, religion: "x" } },
      { ...update, fields: { ...update.fields, languages: ["fi", "sv", "en", "ru", "et", "uk"] } },
      { ...update, fields: { ...update.fields, height: 139 } },
      { ...update, fields: { ...update.fields, hobbies: HOBBIES.slice(0, 6) } },
      { ...update, fields: { ...update.fields, campus: "Otaniemi" } },
      { ...update, prompts: [update.prompts[0], update.prompts[0]] },
      { ...update, bio: "Hello there", bioPreset: "photos_speak" },
      { ...update, displayName: "" },
      { ...update, extra: true },
    ];
    for (const body of refused) {
      const response = await put(app, a.headers, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
  });

  test("PUT /profile refuses text that carries contact details", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    for (const body of [
      { ...update, displayName: "@aino" },
      { ...update, bio: "Write to aino@example.com please", bioPreset: null },
      { ...update, fields: { ...update.fields, occupationTitle: "Nokia, 040 1234567" } },
      { ...update, prompts: [{ key: "ask_me", answer: "Ask me on instagram" }] },
    ]) {
      const response = await put(app, a.headers, body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("text_contact_details");
    }
    const { rows } = await ctx.client.query("SELECT 1 FROM profile WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(rows).toHaveLength(0);
    // The refusal names the field and the kind; the text itself reaches no log line.
    expect(JSON.stringify(logs())).not.toContain("aino@example.com");
    expect(JSON.stringify(logs())).not.toContain("040 1234567");
  });

  test("PUT /profile refuses a politics or religion answer without the consent of the current wording, and stores both with it", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const answered = { ...update, fields: { ...update.fields, politics: ["vihr", "vas"] } };
    for (const consent of [null, { version: "2026-01-older" }]) {
      const response = await put(app, a.headers, { ...answered, specialCategoryConsent: consent });
      expect(response.status).toBe(403);
      // The detail (the fields, the current version) goes to the log, never the body (lib/errors.ts).
      expect(await errorCode(response)).toBe("consent_required");
    }
    const { rows: none } = await ctx.client.query("SELECT 1 FROM profile WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(none).toHaveLength(0);
    const saved = await put(app, a.headers, {
      ...answered,
      fields: { ...answered.fields, religion: "agnostic" },
      specialCategoryConsent: { version: SPECIAL_CATEGORY_CONSENT_VERSION },
    });
    expect(saved.status).toBe(200);
    const stored = ProfileResponse.parse(await saved.json());
    expect(stored.profile?.fields).toMatchObject({
      politics: ["vihr", "vas"],
      religion: "agnostic",
    });
    expect(stored.profile?.specialCategoryConsent?.version).toBe(SPECIAL_CATEGORY_CONSENT_VERSION);
    // Shown on the card, as an answered info field is (ADR-019 §2).
    const preview = await app.request("/profile/card", { headers: a.headers });
    expect(CardPreviewResponse.parse(await preview.json()).card?.fields).toMatchObject({
      politics: ["vihr", "vas"],
      religion: "agnostic",
    });
  });

  test("PUT /profile refuses a consent version that is not the current wording's", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const response = await put(app, a.headers, {
      ...update,
      specialCategoryConsent: { version: "2026-01-older" },
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("agreement_outdated");
    const { rows } = await ctx.client.query("SELECT 1 FROM profile WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(rows).toHaveLength(0);
  });

  test("the card leaves a soft value and a setting on the profile, and the field of study the person hides", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const saved = await put(app, a.headers, {
      ...update,
      fields: {
        ...update.fields,
        education: "amk",
        drinking: "rarely",
        field: "tech",
        hideFromField: true,
      },
    });
    expect(saved.status).toBe(200);
    expect(ProfileResponse.parse(await saved.json()).profile?.fields).toMatchObject({
      education: "amk",
      drinking: "rarely",
      field: "tech",
      hideFromField: true,
    });
    const preview = await app.request("/profile/card", { headers: a.headers });
    const card = CardPreviewResponse.parse(await preview.json()).card;
    expect(card?.fields).toEqual(update.fields);
    // The owner previews without what both answered: there is nobody on the other side.
    expect(card?.shared).toEqual({ hobbies: [], languages: [] });
  });

  test("the card carries every answered info and hard field, nothing soft or hidden, and no key beyond the contract", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    // One answer on every field of the registry, whatever its kind.
    const everything: Record<string, unknown> = {};
    for (const key of PROFILE_FIELD_KEYS) {
      const spec = PROFILE_FIELDS[key];
      everything[key] =
        spec.kind === "single"
          ? spec.options[0]
          : spec.kind === "multi"
            ? [spec.options[0]]
            : spec.kind === "number"
              ? spec.min
              : spec.kind === "text"
                ? "Architect"
                : true;
    }
    const saved = await put(app, a.headers, {
      ...update,
      fields: everything,
      specialCategoryConsent: { version: SPECIAL_CATEGORY_CONSENT_VERSION },
    });
    expect(saved.status).toBe(200);
    const preview = await app.request("/profile/card", { headers: a.headers });
    const card = CardPreviewResponse.parse(await preview.json()).card;
    const onCard = Object.keys(card?.fields ?? {}).sort();
    // The info and hard fields (ADR-019 §2), less the field of study behind the hide-from-field setting.
    expect(onCard).toEqual(CARD_FIELD_KEYS.filter((key) => key !== "field").sort());
    for (const key of onCard) {
      const role = PROFILE_FIELDS[key as (typeof PROFILE_FIELD_KEYS)[number]].role;
      expect(["info", "hard"]).toContain(role);
    }
    // Nothing about anyone else and no count of anything (rules/schema.md).
    expect(Object.keys(card ?? {}).sort()).toEqual([
      "accountId",
      "age",
      "bio",
      "bioPreset",
      "displayName",
      "fields",
      "gender",
      "photos",
      "pond",
      "prompts",
      "shared",
    ]);
  });

  it("the consent gate refuses a special-category value without the version of the current wording", () => {
    const fields = { ...update.fields, religion: "agnostic" } as ProfileUpdate["fields"];
    expect(consentMissingFor({ fields, specialCategoryConsent: null }, ["religion"], "v2")).toEqual(
      ["religion"],
    );
    expect(
      consentMissingFor({ fields, specialCategoryConsent: { version: "v1" } }, ["religion"], "v2"),
    ).toEqual(["religion"]);
    expect(
      consentMissingFor({ fields, specialCategoryConsent: { version: "v2" } }, ["religion"], "v2"),
    ).toEqual([]);
    expect(
      consentMissingFor(
        { fields: update.fields, specialCategoryConsent: null },
        ["religion"],
        "v2",
      ),
    ).toEqual([]);
    // The real registry flags politics and religion (ADR-019 §4).
    expect(
      consentMissingFor({
        fields: { ...fields, politics: ["none_of_them"] },
        specialCategoryConsent: null,
      }),
    ).toEqual(["politics", "religion"]);
    expect(consentMissingFor({ fields: update.fields, specialCategoryConsent: null })).toEqual([]);
  });

  test("unauthenticated: 401 on every profile route", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    expect((await app.request("/profile")).status).toBe(401);
    expect((await app.request("/profile", { method: "PUT" })).status).toBe(401);
    expect((await app.request("/profile/card")).status).toBe(401);
  });

  test("GET /profile/card previews the owner's card with the verified age and approved photos only", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const before = await app.request("/profile/card", { headers: a.headers });
    expect(CardPreviewResponse.parse(await before.json()).card).toBeNull();
    const [approved] = await approvedPhotos(ctx, app, a.headers, 1);
    await upload(app, a.headers, await fixturePng(90, 90)); // stays pending
    await put(app, a.headers, update);
    const response = await app.request("/profile/card", { headers: a.headers });
    expect(response.status).toBe(200);
    const body = CardPreviewResponse.parse(await response.json());
    // signedInAccount registers the account as born 1990-06; the arithmetic is tested against
    // fixed instants in completeness.test.ts, this checks the wiring by the same rule.
    const years = ageInYears(1990, 6, new Date());
    expect(body.card).toMatchObject({
      accountId: a.accountId,
      displayName: "Aino",
      age: { years, verifiedByBank: true },
      bioPreset: "lazy_nice_fellow",
      fields: update.fields,
    });
    expect(body.card?.photos.map((p) => p.id)).toEqual([approved]);
    expect(body.card?.pond).toBeNull();
    expect(body.completeness.missing).toEqual(["photos", "seeks", "age_window"]);
    // A preview records nothing.
    const { rows } = await ctx.client.query("SELECT 1 FROM card_shown WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(rows).toHaveLength(0);
  });

  test("the card for another viewer: a complete subject is served and recorded, an incomplete or deleted one is not, and the day has a budget", async ({
    ctx,
  }) => {
    const { app, logger } = await appWith(ctx);
    const viewer = await signedInAccount(ctx.client);
    // The viewer's own answers: what both answered is marked on the card (#150).
    await put(app, viewer.headers, {
      ...update,
      fields: { ...update.fields, hobbies: ["yoga", "hiking"] },
    });
    const complete = async (fields: ProfileUpdate["fields"] = {}) => {
      const who = await signedInAccount(ctx.client);
      await approvedPhotos(ctx, app, who.headers, 3);
      await put(app, who.headers, {
        ...update,
        fields: { ...update.fields, ...fields },
        bio: "x".repeat(60),
        bioPreset: null,
      });
      return who;
    };
    const b = await complete({ hobbies: ["yoga", "gym"] });
    await ctx.client.query("UPDATE account SET gender = 'woman' WHERE id = $1", [b.accountId]);
    const c = await complete();
    const d = await signedInAccount(ctx.client); // no profile
    // Onboarding (#46) is not here; a reader that says it is done stands in.
    const deps = {
      db: ctx.client,
      logger,
      now: () => new Date(),
      readPreferences: async () => ({ seeks: "everyone", ageWindow: [20, 40] }),
    };
    const first = await buildCard(deps, {
      viewerAccountId: viewer.accountId,
      subjectAccountId: b.accountId,
    });
    expect(first.card?.photos).toHaveLength(3);
    expect(first.card?.bio).toBe("x".repeat(60));
    expect(first.card?.gender).toBe("woman");
    // In the order the subject gave them; never a count.
    expect(first.card?.shared).toEqual({ hobbies: ["yoga"], languages: ["fi", "en"] });
    const shown = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM card_shown WHERE account_id = $1",
      [viewer.accountId],
    );
    expect(Number(shown.rows[0]?.n)).toBe(3);
    // The same card again costs nothing more; a second subject is over the budget of one.
    expect(
      (await buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: b.accountId }))
        .card,
    ).toBeTruthy();
    await expect(
      buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: c.accountId }),
    ).rejects.toMatchObject({ status: 429, code: "card_budget_exceeded" });
    const after = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM card_shown WHERE account_id = $1",
      [viewer.accountId],
    );
    expect(Number(after.rows[0]?.n)).toBe(3);
    await expect(
      buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: d.accountId }),
    ).rejects.toMatchObject({ status: 404 });
    // A sanction holds at this gate too, and writes nothing.
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      c.accountId,
    ]);
    await withMatchingConfig(ctx.client, { exposure_cards_per_day: 10 });
    await expect(
      buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: c.accountId }),
    ).rejects.toMatchObject({ status: 404 });
    const sanctioned = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM card_shown WHERE account_id = $1",
      [viewer.accountId],
    );
    expect(Number(sanctioned.rows[0]?.n)).toBe(3);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [b.accountId]);
    await expect(
      buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: b.accountId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("erasing the account deletes the profile, and the export carries it until then", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await put(app, a.headers, update);
    const exported = AccountExport.parse(
      await (await app.request("/account/export", { headers: a.headers })).json(),
    );
    expect(exported.profile?.displayName).toBe("Aino");
    const deleted = await app.request("/account/delete", {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(deleted.status).toBe(204);
    const { rows } = await ctx.client.query("SELECT 1 FROM profile WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
