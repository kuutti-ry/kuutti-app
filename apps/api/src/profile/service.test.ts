import type { ProfileUpdate } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test } from "../test/harness.ts";
import { buildCard, type CardDeps, sharedAnswers } from "./card.ts";
import {
  contactDetailsInUpdate,
  exportProfile,
  readProfile,
  saveProfile,
  withdrawSpecialCategoryAnswers,
} from "./service.ts";

// The profile slice below its routes (#47, ADR-009, ADR-019): the card for a
// viewer who is not the owner, the document read back when the registry has
// moved on, the export, and the special-category answers on withdrawal.
// Real Postgres in the test's transaction; the readers the routes wire from
// other slices are handed in, or left out where a branch is about their absence.

const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const LONG_BIO = "A bio that is long enough to count as one, by the rule of the profile.";

async function depsOf(ctx: TestContext, extra: Partial<CardDeps> = {}) {
  const { logger, lines } = await captureLogger();
  const deps: CardDeps = { db: ctx.client, logger, now: () => new Date(), ...extra };
  return { deps, logs: lines };
}

const onboarded: CardDeps["readPreferences"] = async () => ({
  seeks: ["woman"],
  ageWindow: { min: 20, max: 40 },
});

async function profileRow(
  ctx: TestContext,
  accountId: string,
  row: { fields?: unknown; prompts?: unknown; bio?: string | null } = {},
) {
  await ctx.client.query(
    `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
     VALUES ($1, 'Aino', $2, $3::jsonb, $4::jsonb)`,
    [
      accountId,
      row.bio === undefined ? LONG_BIO : row.bio,
      JSON.stringify(row.fields ?? {}),
      JSON.stringify(row.prompts ?? []),
    ],
  );
}

async function approvedPhotos(ctx: TestContext, accountId: string, n: number) {
  await ctx.client.query(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
     SELECT $1::uuid, md5($1::text || g::text), $2, 800, 1067, 'approved', g FROM generate_series(0, $3::int - 1) g`,
    [accountId, BLURHASH, n],
  );
}

const shownRows = async (ctx: TestContext, viewer: string) =>
  Number(
    (await ctx.client.query("SELECT count(*) AS n FROM card_shown WHERE account_id = $1", [viewer]))
      .rows[0]?.n,
  );

describe("the card for a viewer who is not the owner", () => {
  test("a subject nobody has is a 404", async ({ ctx }) => {
    const { deps } = await depsOf(ctx, { readPreferences: onboarded });
    const viewer = await signedInAccount(ctx.client);
    await expect(
      buildCard(deps, {
        viewerAccountId: viewer.accountId,
        subjectAccountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  test("a subject with a profile and photos but not complete is a 404 and records nothing", async ({
    ctx,
  }) => {
    // Onboarding is done, the photos are there; the bio is short and no prompt is answered.
    const { deps } = await depsOf(ctx, { readPreferences: onboarded });
    const viewer = await signedInAccount(ctx.client);
    const subject = await signedInAccount(ctx.client);
    await profileRow(ctx, subject.accountId, { bio: "Hi." });
    await approvedPhotos(ctx, subject.accountId, 3);
    await expect(
      buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: subject.accountId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await shownRows(ctx, viewer.accountId)).toBe(0);
  });

  test("a subject without a bank-verified year and month has no card: null for the owner, 404 for anyone else", async ({
    ctx,
  }) => {
    const { deps } = await depsOf(ctx, { readPreferences: onboarded });
    const viewer = await signedInAccount(ctx.client);
    const subject = await signedInAccount(ctx.client);
    await profileRow(ctx, subject.accountId);
    await approvedPhotos(ctx, subject.accountId, 3);
    await ctx.client.query(
      "UPDATE account SET birth_year = NULL, birth_month = NULL WHERE id = $1",
      [subject.accountId],
    );
    const own = await buildCard(deps, {
      viewerAccountId: subject.accountId,
      subjectAccountId: subject.accountId,
    });
    expect(own).toEqual({ card: null, completeness: { complete: true, missing: [] } });
    await expect(
      buildCard(deps, { viewerAccountId: viewer.accountId, subjectAccountId: subject.accountId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await shownRows(ctx, viewer.accountId)).toBe(0);
  });

  test("a viewer with no profile of their own shares nothing with the subject", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { exposure_cards_per_day: 5 });
    const { deps } = await depsOf(ctx, { readPreferences: onboarded });
    const viewer = await signedInAccount(ctx.client);
    const subject = await signedInAccount(ctx.client);
    await profileRow(ctx, subject.accountId, { fields: { hobbies: ["yoga"], languages: ["fi"] } });
    await approvedPhotos(ctx, subject.accountId, 2);
    const served = await buildCard(deps, {
      viewerAccountId: viewer.accountId,
      subjectAccountId: subject.accountId,
    });
    expect(served.card?.shared).toEqual({ hobbies: [], languages: [] });
    expect(served.card?.photos).toHaveLength(2);
    expect(await shownRows(ctx, viewer.accountId)).toBe(2);
  });

  test("without a preference reader nothing is complete: the owner's preview says what onboarding still owes", async ({
    ctx,
  }) => {
    const { deps } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    await profileRow(ctx, me.accountId);
    await approvedPhotos(ctx, me.accountId, 2);
    const preview = await buildCard(deps, {
      viewerAccountId: me.accountId,
      subjectAccountId: me.accountId,
    });
    expect(preview.card?.displayName).toBe("Aino");
    expect(preview.completeness).toEqual({ complete: false, missing: ["seeks", "age_window"] });
  });
});

describe("what both answered", () => {
  it("is nothing for the owner's own preview, and only what both answered otherwise, in the subject's order", () => {
    expect(sharedAnswers(null, { hobbies: ["yoga"], languages: ["fi"] })).toEqual({
      hobbies: [],
      languages: [],
    });
    expect(
      sharedAnswers({ languages: ["en", "fi"] }, { hobbies: ["yoga"], languages: ["fi", "en"] }),
    ).toEqual({
      hobbies: [],
      languages: ["fi", "en"],
    });
    expect(sharedAnswers({ hobbies: ["yoga"] }, {})).toEqual({ hobbies: [], languages: [] });
  });
});

describe("a stored document the registry has moved on from", () => {
  test("a value, a key and a prompt the registry no longer knows are dropped from the document and named in the log, never their values", async ({
    ctx,
  }) => {
    const { deps, logs } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    await profileRow(ctx, me.accountId, {
      fields: { smoking: "pipe-secretvalue", intent: "long_term", retiredField: "x-secretvalue" },
      prompts: [
        { key: "retired_prompt", answer: "an answer-secretvalue" },
        { key: "sunday", answer: "A long breakfast." },
      ],
    });
    const read = await readProfile(deps, me.accountId);
    expect(read.profile?.fields).toEqual({ intent: "long_term" });
    expect(read.profile?.prompts).toEqual([{ key: "sunday", answer: "A long breakfast." }]);
    const line = logs().find((l) => l.msg === "profile values dropped");
    expect(line).toMatchObject({ accountId: me.accountId });
    expect([...((line?.dropped as string[]) ?? [])].sort()).toEqual([
      "fields.retiredField",
      "fields.smoking",
      "prompts.0",
    ]);
    expect(JSON.stringify(logs())).not.toContain("secretvalue");
  });

  test("prompts stored as something other than a list read as none", async ({ ctx }) => {
    const { deps, logs } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    await profileRow(ctx, me.accountId, { prompts: { sunday: "A long breakfast." } });
    const read = await readProfile(deps, me.accountId);
    expect(read.profile?.prompts).toEqual([]);
    expect(logs().some((l) => l.msg === "profile values dropped")).toBe(false);
  });

  test("without a consent reader the document echoes no consent", async ({ ctx }) => {
    const { deps } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    await profileRow(ctx, me.accountId);
    expect((await readProfile(deps, me.accountId)).profile?.specialCategoryConsent).toBeNull();
  });
});

describe("saving without the routes' readers", () => {
  const update: ProfileUpdate = {
    displayName: "Aino",
    bio: LONG_BIO,
    bioPreset: null,
    fields: { intent: "long_term" },
    prompts: [],
  };

  test("an erased account is a 404 and gets no profile row", async ({ ctx }) => {
    const { deps } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [me.accountId],
    );
    await expect(saveProfile(deps, me.accountId, update)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    const { rows } = await ctx.client.query("SELECT 1 FROM profile WHERE account_id = $1", [
      me.accountId,
    ]);
    expect(rows).toEqual([]);
  });

  test("with no consent reader a politics answer is refused, as no consent is on record", async ({
    ctx,
  }) => {
    const { deps } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    await expect(
      saveProfile(deps, me.accountId, { ...update, fields: { politics: ["none_of_them"] } }),
    ).rejects.toMatchObject({ status: 403, code: "consent_required" });
    const saved = await saveProfile(deps, me.accountId, update);
    expect(saved.profile).toMatchObject({ displayName: "Aino", specialCategoryConsent: null });
  });
});

describe("contact details in an update", () => {
  const base: ProfileUpdate = {
    displayName: "Aino",
    bio: null,
    bioPreset: null,
    fields: {},
    prompts: [],
  };

  it("names the first text that carries one: a text field of the registry, then the prompts by place", () => {
    expect(contactDetailsInUpdate(base)).toBeNull();
    expect(
      contactDetailsInUpdate({ ...base, fields: { occupationTitle: "aino@example.fi" } }),
    ).toEqual({ field: "fields.occupationTitle", kind: "email" });
    expect(
      contactDetailsInUpdate({
        ...base,
        prompts: [
          { key: "sunday", answer: "A long breakfast." },
          { key: "hidden_talent", answer: "see www.example.fi" },
        ],
      }),
    ).toEqual({ field: "prompts.1.answer", kind: "url" });
  });
});

describe("the export of the profile", () => {
  test("nothing before the first save; the document with the consent it is handed after", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    expect(await exportProfile(ctx.client, me.accountId)).toBeNull();
    await profileRow(ctx, me.accountId);
    expect((await exportProfile(ctx.client, me.accountId))?.specialCategoryConsent).toBeNull();
    const given = new Date("2026-09-01T08:00:00Z");
    expect(
      (await exportProfile(ctx.client, me.accountId, { version: "v-test", givenAt: given }))
        ?.specialCategoryConsent,
    ).toEqual({ version: "v-test", at: "2026-09-01T08:00:00.000Z" });
  });
});

describe("withdrawing the special-category consent", () => {
  test("takes politics and religion out of the document, keeps the rest, and says so in the log", async ({
    ctx,
  }) => {
    const { deps, logs } = await depsOf(ctx);
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    const fields = { politics: ["none_of_them"], religion: "lutheran", intent: "long_term" };
    await profileRow(ctx, me.accountId, { fields });
    await profileRow(ctx, other.accountId, { fields });
    await withdrawSpecialCategoryAnswers(deps, me.accountId);
    const stored = async (id: string) =>
      (await ctx.client.query("SELECT fields FROM profile WHERE account_id = $1", [id])).rows[0]
        ?.fields;
    expect(await stored(me.accountId)).toEqual({ intent: "long_term" });
    expect(await stored(other.accountId)).toEqual(fields);
    expect(logs().find((l) => l.msg === "special-category answers cleared")).toMatchObject({
      accountId: me.accountId,
    });
  });

  test("with no profile, or for an erased account, nothing changes and nothing is said", async ({
    ctx,
  }) => {
    const { deps, logs } = await depsOf(ctx);
    const none = await signedInAccount(ctx.client);
    await withdrawSpecialCategoryAnswers(deps, none.accountId);
    const erased = await signedInAccount(ctx.client);
    await profileRow(ctx, erased.accountId, { fields: { religion: "lutheran" } });
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [erased.accountId],
    );
    await withdrawSpecialCategoryAnswers(deps, erased.accountId);
    expect(
      (
        await ctx.client.query("SELECT fields FROM profile WHERE account_id = $1", [
          erased.accountId,
        ])
      ).rows[0]?.fields,
    ).toEqual({ religion: "lutheran" });
    expect(logs().some((l) => l.msg === "special-category answers cleared")).toBe(false);
  });
});
