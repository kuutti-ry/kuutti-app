import { AccountExport } from "@kuutti/schema";
import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { ensureEventPartitions } from "./partitions.ts";
import * as repo from "./repo.ts";
import { track } from "./track.ts";

// The research_id mapping's life (#50, ADR-011): features/identity/onboarding.feature
// and features/identity/erasure.feature carry the scenarios; the row is the
// research slice's, so the tests live here.

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});

async function consent(ctx: TestContext, headers: Record<string, string>) {
  const response = await ctx.app.request("/consents", {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify({
      kind: "research",
      version: CURRENT_CONSENT_VERSIONS.research,
      locale: "fi",
    }),
  });
  expect(response.status).toBe(200);
}

async function withdraw(ctx: TestContext, headers: Record<string, string>) {
  const response = await ctx.app.request("/consents/research", { method: "DELETE", headers });
  expect(response.status).toBe(200);
}

async function eventsKeyedBy(ctx: TestContext, researchId: string): Promise<number> {
  const { rows } = await ctx.client.query<{ n: string }>(
    "SELECT count(*) AS n FROM events WHERE research_id = $1",
    [researchId],
  );
  return Number(rows[0]?.n);
}

/**
 * A fixed instant (the account of the harness is born 1990-06: 36, band 35-39)
 * with its month ensured. Asked for first in a test, before anything writes
 * an event: creating a partition waits for every open transaction that wrote
 * to events, and a test that wrote one and then waited for the partition lock
 * held by another test's creation deadlocked with it.
 */
const FIXED = new Date("2026-09-26T12:00:00Z");
async function deps(ctx: TestContext) {
  const { logger } = await captureLogger();
  await ensureEventPartitions(ctx.client, FIXED);
  return { db: ctx.client, logger, now: () => FIXED };
}

describe("the research_id mapping", () => {
  test("The research opt-in creates the research_id mapping and withdrawal removes it", async ({
    ctx,
  }) => {
    const research = await deps(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(ctx, a.headers);
    const subject = await repo.findSubject(ctx.client, a.accountId);
    expect(subject).not.toBeNull();
    expect(subject?.consentVersion).toBe(CURRENT_CONSENT_VERSIONS.research);
    const researchId = subject?.researchId ?? "";
    expect(
      await track(research, a.accountId, "profile_saved", {
        complete: false,
        approvedPhotos: 0,
      }),
    ).toEqual({ recorded: true });
    expect(await eventsKeyedBy(ctx, researchId)).toBe(2); // the opt-in and the save

    await withdraw(ctx, a.headers);
    expect(await repo.findSubject(ctx.client, a.accountId)).toBeNull();
    expect(await eventsKeyedBy(ctx, researchId)).toBe(2);
    expect(
      await track(research, a.accountId, "profile_saved", {
        complete: false,
        approvedPhotos: 0,
      }),
    ).toEqual({ recorded: false, reason: "no_consent" });
  });

  test("A new research opt-in is a new research_id", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await consent(ctx, a.headers);
    const first = (await repo.findSubject(ctx.client, a.accountId))?.researchId;
    await withdraw(ctx, a.headers);
    await consent(ctx, a.headers);
    const second = (await repo.findSubject(ctx.client, a.accountId))?.researchId;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    // A repeated consent for the same wording keeps the pseudonym.
    await consent(ctx, a.headers);
    expect((await repo.findSubject(ctx.client, a.accountId))?.researchId).toBe(second);
  });

  test("a newer wording accepted while enrolled moves the consent version and keeps the pseudonym", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await consent(ctx, a.headers);
    const before = await repo.findSubject(ctx.client, a.accountId);
    const outcome = await repo.enrolSubject(ctx.client, a.accountId, "2099-01-final-1", new Date());
    expect(outcome).toBe("updated");
    const after = await repo.findSubject(ctx.client, a.accountId);
    expect(after?.researchId).toBe(before?.researchId);
    expect(after?.enrolledAt.getTime()).toBe(before?.enrolledAt.getTime());
    expect(after?.consentVersion).toBe("2099-01-final-1");
    const b = await signedInAccount(ctx.client);
    expect(await repo.enrolSubject(ctx.client, b.accountId, "v", new Date())).toBe("enrolled");
    await ctx.client.query("DELETE FROM research_subject WHERE account_id = $1", [b.accountId]);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [b.accountId]);
    expect(await repo.enrolSubject(ctx.client, b.accountId, "v", new Date())).toBe("no_account");
  });

  test("Erasure removes the research_id mapping and keeps the events", async ({ ctx }) => {
    const research = await deps(ctx);
    const a = await signedInAccount(ctx.client);
    await consent(ctx, a.headers);
    const researchId = (await repo.findSubject(ctx.client, a.accountId))?.researchId ?? "";
    await track(research, a.accountId, "profile_saved", {
      complete: false,
      approvedPhotos: 0,
    });
    const response = await ctx.app.request("/account/delete", {
      method: "POST",
      headers: json(a.headers),
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(204);
    expect(await repo.findSubject(ctx.client, a.accountId)).toBeNull();
    expect(await eventsKeyedBy(ctx, researchId)).toBe(2);
    const { rows } = await ctx.client.query(
      "SELECT 1 FROM research_subject WHERE research_id = $1",
      [researchId],
    );
    expect(rows).toHaveLength(0);
    const erased = ctx.logs().find((l) => l.msg === "account erased");
    expect(erased?.researchSubjects).toBe(1);
  });

  test("The export shows the research enrolment and the events but never the research_id", async ({
    ctx,
  }) => {
    const research = await deps(ctx);
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET gender = 'man' WHERE id = $1", [a.accountId]);
    await consent(ctx, a.headers);
    const researchId = (await repo.findSubject(ctx.client, a.accountId))?.researchId ?? "";
    await track(research, a.accountId, "profile_saved", {
      complete: false,
      approvedPhotos: 1,
    });
    const response = await ctx.app.request("/account/export", { headers: a.headers });
    expect(response.status).toBe(200);
    const body = AccountExport.parse(await response.json());
    expect(body.research.enrolled).toBe(true);
    expect(body.research.consentVersion).toBe(CURRENT_CONSENT_VERSIONS.research);
    expect(body.research.since).toBeTruthy();
    // Both events fall in the same hour, so their order is not fixed.
    expect(body.research.events.map((e) => e.name).sort()).toEqual([
      "profile_saved",
      "research_opt_in",
    ]);
    expect(body.research.events.find((e) => e.name === "profile_saved")).toMatchObject({
      pond: null,
      ageBand: "35-39",
      snapshot: { gender: "man", fields: {} },
      props: { complete: false, approvedPhotos: 1 },
    });
    expect(JSON.stringify(body)).not.toContain(researchId);

    await withdraw(ctx, a.headers);
    const after = AccountExport.parse(
      await (await ctx.app.request("/account/export", { headers: a.headers })).json(),
    );
    expect(after.research).toEqual({
      enrolled: false,
      since: null,
      consentVersion: null,
      events: [],
    });
  });
});
