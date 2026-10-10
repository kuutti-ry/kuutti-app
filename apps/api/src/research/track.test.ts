import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { ensureEventPartitions } from "./partitions.ts";
import * as repo from "./repo.ts";
import { track } from "./track.ts";

// The one door for research events (#50, ADR-011): nothing without the
// consent, a coarse snapshot with it, refusals before any write, and a failure
// that never reaches the caller.

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});

async function researchConsent(ctx: TestContext, headers: Record<string, string>) {
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

/** Gender, a pond and a profile document with a closed-list value, a text value and a retired option. */
async function onboarded(ctx: TestContext, accountId: string) {
  const pond = await ctx.client.query<{ id: string }>(
    `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('test-research-pond', 'Pond', 'Pondissa') RETURNING id`,
  );
  await ctx.client.query("UPDATE account SET gender = 'woman', pond_id = $2 WHERE id = $1", [
    accountId,
    pond.rows[0]?.id,
  ]);
  await ctx.client.query(
    `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
     VALUES ($1, 'Aino', null, $2::jsonb, '[]'::jsonb)`,
    [
      accountId,
      JSON.stringify({
        intent: "long_term",
        languages: ["fi", "en"],
        occupationTitle: "Secret handshake coach",
        smoking: "retired option",
      }),
    ],
  );
}

type EventRow = {
  research_id: string;
  consent_version: string;
  pond: string | null;
  age_band: string;
  snapshot: unknown;
  props: unknown;
};

async function eventsOf(ctx: TestContext, accountId: string, name: string, at?: Date) {
  const { rows } = await ctx.client.query<EventRow>(
    `SELECT e.research_id, e.consent_version, e.pond, e.age_band, e.snapshot, e.props
     FROM events e JOIN research_subject s ON s.research_id = e.research_id
     WHERE s.account_id = $1 AND e.name = $2 AND ($3::timestamptz IS NULL OR e.at = $3)`,
    [accountId, name, at ?? null],
  );
  return rows;
}

/** track()'s dependencies on the test's transaction, with a logger of their own to read back. */
async function trackDeps(ctx: TestContext, at: Date) {
  const { logger, lines } = await captureLogger();
  return { deps: { db: ctx.client, logger, now: () => at }, lines };
}

describe("track", () => {
  test("writes nothing for an account without the research consent", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await onboarded(ctx, a.accountId);
    const at = new Date();
    const { deps, lines } = await trackDeps(ctx, at);
    const result = await track(deps, a.accountId, "profile_saved", {
      complete: false,
      approvedPhotos: 0,
    });
    expect(result).toEqual({ recorded: false, reason: "no_consent" });
    const { rows } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE at = $1",
      [at],
    );
    expect(Number(rows[0]?.n)).toBe(0);
    expect(lines().filter((l) => String(l.msg).includes("research event"))).toEqual([]);
  });

  test("records one row with the consent version, the pond slug, the age band, gender and closed-list fields only", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client); // born 1990-06
    await onboarded(ctx, a.accountId);
    await researchConsent(ctx, a.headers);
    const at = new Date("2026-09-26T12:00:00Z"); // 36 by the Finnish calendar
    await ensureEventPartitions(ctx.client, at); // the fixed instant's month, whatever today is
    const { deps } = await trackDeps(ctx, at);
    const result = await track(deps, a.accountId, "profile_saved", {
      complete: true,
      approvedPhotos: 3,
    });
    expect(result).toEqual({ recorded: true });
    const rows = await eventsOf(ctx, a.accountId, "profile_saved", at);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      consent_version: CURRENT_CONSENT_VERSIONS.research,
      pond: "test-research-pond",
      age_band: "35-39",
      snapshot: { gender: "woman", fields: { intent: "long_term", languages: ["fi", "en"] } },
      props: { complete: true, approvedPhotos: 3 },
    });
    const text = JSON.stringify(row);
    expect(text).not.toContain(a.accountId);
    expect(text).not.toContain("Guild");
    expect(text).not.toContain("retired");
    expect(text).not.toContain("Aino");
  });

  test("the opt-in itself is the first event", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await researchConsent(ctx, a.headers);
    const rows = await eventsOf(ctx, a.accountId, "research_opt_in");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pond).toBeNull(); // consent before the pond: null, not a made-up value
    const props = rows[0]?.props as
      | { accountActive: boolean; sinceRegistrationD: number }
      | undefined;
    expect(props?.accountActive).toBe(true);
    expect(props?.sinceRegistrationD).toBe(0);
  });

  test("an event is timestamped to the hour, never to the instant of a consent row", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await researchConsent(ctx, a.headers);
    const { rows } = await ctx.client.query<{ at: Date; given_at: Date }>(
      `SELECT e.at, c.given_at FROM events e
       JOIN research_subject s ON s.research_id = e.research_id
       JOIN consent c ON c.account_id = s.account_id AND c.kind = 'research'
       WHERE s.account_id = $1 AND e.name = 'research_opt_in'`,
      [a.accountId],
    );
    const first = rows[0];
    if (!first) throw new Error("no opt-in event");
    const at = first.at;
    expect(at.getUTCMinutes() + at.getUTCSeconds() + at.getUTCMilliseconds()).toBe(0);
    expect(at.getTime()).not.toBe(first.given_at.getTime());
  });

  test("refuses props outside the registry before any write and logs the paths, never the values", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await researchConsent(ctx, a.headers);
    const at = new Date();
    const { deps, lines } = await trackDeps(ctx, at);
    const result = await track(deps, a.accountId, "profile_saved", {
      complete: "SECRETVALUE9",
      approvedPhotos: 1,
    } as never);
    expect(result).toEqual({ recorded: false, reason: "invalid_props" });
    expect(await eventsOf(ctx, a.accountId, "profile_saved", at)).toEqual([]);
    const refused = lines().filter((l) => String(l.msg).startsWith("research event refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.paths).toEqual(["complete"]);
    expect(JSON.stringify(lines())).not.toContain("SECRETVALUE9");
  });

  test("a failed insert is a warning and the caller's transaction goes on", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await researchConsent(ctx, a.headers);
    // No partition holds 2001: the insert fails, inside its own savepoint.
    const { deps, lines } = await trackDeps(ctx, new Date("2001-01-01T00:00:00Z"));
    const result = await track(deps, a.accountId, "profile_saved", {
      complete: false,
      approvedPhotos: 0,
    });
    expect(result).toEqual({ recorded: false, reason: "failed" });
    const dropped = lines().filter((l) => l.msg === "research event dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.event).toBe("profile_saved");
    // An aborted transaction would refuse this.
    const { rows } = await ctx.client.query<{ one: number }>("SELECT 1 AS one");
    expect(rows[0]?.one).toBe(1);
    expect(await repo.findSubject(ctx.client, a.accountId)).not.toBeNull();
  });

  test("a profile save tracks profile_saved for an enrolled account and nothing for another", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await researchConsent(ctx, a.headers);
    for (const who of [a, b]) {
      const response = await ctx.app.request("/profile", {
        method: "PUT",
        headers: json(who.headers),
        body: JSON.stringify({
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: { intent: "casual" },
          prompts: [],
        }),
      });
      expect(response.status).toBe(200);
    }
    const rows = await eventsOf(ctx, a.accountId, "profile_saved");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props).toEqual({ complete: false, approvedPhotos: 0 });
    expect(rows[0]?.snapshot).toMatchObject({ fields: { intent: "casual" } });
    const { rows: all } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM events e JOIN research_subject s ON s.research_id = e.research_id WHERE s.account_id = $1",
      [b.accountId],
    );
    expect(Number(all[0]?.n)).toBe(0);
  });
});
