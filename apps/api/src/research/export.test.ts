import { signedInAccount } from "../test/account.ts";
import { describe, expect, type TestContext, test } from "../test/harness.ts";
import { exportResearch } from "./export.ts";
import { ensureEventPartitions } from "./partitions.ts";
import { enrolSubject, findSubject, insertEvent, snapshotRows } from "./repo.ts";

// The research half of the export (#51, ADR-007 §4; ADR-011 §7 and §10) and
// the mapping row beneath it (#50, ADR-011): the enrolment and nothing else,
// whatever the events table holds; the research_id stays in this slice;
// nothing is found for an account that is not enrolled, and nothing is
// written for one erased.

const AT = new Date("2026-09-26T12:00:00Z");

async function enrolled(ctx: TestContext) {
  const a = await signedInAccount(ctx.client);
  expect(await enrolSubject(ctx.client, a.accountId, "research-v1", AT)).toBe("enrolled");
  await ensureEventPartitions(ctx.client, AT);
  const subject = await findSubject(ctx.client, a.accountId);
  if (!subject) throw new Error("not enrolled");
  return { accountId: a.accountId, researchId: subject.researchId };
}

async function event(
  ctx: TestContext,
  researchId: string,
  stored: { snapshot: unknown; props: unknown; at?: Date },
) {
  await insertEvent(ctx.client, {
    at: stored.at ?? AT,
    name: "profile_saved",
    researchId,
    consentVersion: "research-v1",
    pond: null,
    ageBand: "35-39",
    snapshot: stored.snapshot,
    props: stored.props,
  });
}

describe("the research export", () => {
  test("an account that is not enrolled exports nothing", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    expect(await exportResearch(ctx.client, a.accountId)).toEqual({
      enrolled: false,
      since: null,
      consentVersion: null,
    });
  });

  test("an enrolled account exports the enrolment and none of its events, whatever they hold", async ({
    ctx,
  }) => {
    const { accountId, researchId } = await enrolled(ctx);
    const hour = (h: number) => new Date(AT.getTime() + h * 3_600_000);
    await event(ctx, researchId, {
      at: hour(0),
      snapshot: { gender: "woman", fields: { intent: "long_term" } },
      props: { complete: true, approvedPhotos: 2 },
    });
    await event(ctx, researchId, { at: hour(1), snapshot: null, props: null });
    await event(ctx, researchId, { at: hour(2), snapshot: "a string", props: "a string" });

    const exported = await exportResearch(ctx.client, accountId);
    expect(exported).toEqual({
      enrolled: true,
      since: AT.toISOString(),
      consentVersion: "research-v1",
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain(researchId);
    expect(text).not.toContain("profile_saved");
    expect(text).not.toContain("long_term");
  });
});

describe("the mapping row", () => {
  test("a second enrolment keeps the pseudonym and the time and moves the version; an erased account is not enrolled", async ({
    ctx,
  }) => {
    const { accountId, researchId } = await enrolled(ctx);
    expect(await enrolSubject(ctx.client, accountId, "research-v2", new Date())).toBe("updated");
    expect(await findSubject(ctx.client, accountId)).toEqual({
      researchId,
      consentVersion: "research-v2",
      enrolledAt: AT,
    });
    const erased = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [erased.accountId],
    );
    expect(await enrolSubject(ctx.client, erased.accountId, "research-v1", AT)).toBe("no_account");
    expect(await findSubject(ctx.client, erased.accountId)).toBeNull();
  });

  test("the snapshot of an enrolled account without a profile has no fields, and an erased one has none at all", async ({
    ctx,
  }) => {
    const { accountId, researchId } = await enrolled(ctx);
    expect(await snapshotRows(ctx.client, accountId)).toEqual({
      researchId,
      consentVersion: "research-v1",
      gender: null,
      birthYear: 1990,
      birthMonth: 6,
      pond: null,
      fields: null,
    });
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [accountId],
    );
    expect(await snapshotRows(ctx.client, accountId)).toBeNull();
  });
});
