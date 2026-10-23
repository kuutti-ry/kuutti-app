import { checkCharacter, generateHetu, parseHetu } from "@kuutti-ry/tunnistus-oidc/hetu";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type TestContext, test } from "../test/harness.ts";
import {
  ARTIFICIAL_INDIVIDUAL,
  deriveArtificialIdentity,
  NotArtificialError,
  registerArtificial,
} from "./artificial.ts";
import { deriveIdentity, InvalidHetuError } from "./hetu.ts";

// Property tests for the one derivation that leaves the slice (ADR-018 §2,
// CLAUDE.md Testing): a code a person could have is refused before anything
// is hashed, and an artificial one is derived exactly as the callback does.
// Seeded, so a failure names a run that repeats.

const AT = new Date("2026-10-01T12:00:00Z");
const key = Buffer.alloc(32, 0x33);
const SEEDED = { seed: 20261011 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Valid codes of adults and minors, from the seed generator: individual numbers a person can have. */
const personalArb = fc
  .tuple(fc.integer({ min: 1, max: 2 ** 31 - 2 }), fc.integer({ min: 0, max: 80 }))
  .map(([seed, age]) => {
    let x = seed;
    const rng = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    return generateHetu(rng, { at: AT, minAge: age, maxAge: age });
  });

/** The same days of birth, with an individual number the register gives nobody. */
const artificialArb = fc
  .tuple(
    personalArb,
    fc.integer({ min: ARTIFICIAL_INDIVIDUAL.min, max: ARTIFICIAL_INDIVIDUAL.max }),
  )
  .map(([hetu, individual]) => {
    const ddmmyy = hetu.slice(0, 6);
    const sign = hetu.slice(6, 7);
    return `${ddmmyy}${sign}${individual}${checkCharacter(ddmmyy, String(individual))}`;
  });

describe("deriveArtificialIdentity", () => {
  it("refuses every code whose individual number a person could have, before deriving anything", () => {
    fc.assert(
      fc.property(personalArb, (hetu) => {
        const parsed = parseHetu(hetu);
        expect(parsed).not.toBeNull();
        expect(parsed?.individualNumber).toBeLessThan(ARTIFICIAL_INDIVIDUAL.min);
        expect(() => deriveArtificialIdentity(hetu, key, AT)).toThrow(NotArtificialError);
      }),
      SEEDED,
    );
  });

  it("derives an artificial code exactly as the callback derives everybody's", () => {
    fc.assert(
      fc.property(artificialArb, (hetu) => {
        expect(deriveArtificialIdentity(hetu, key, AT)).toEqual(deriveIdentity(hetu, key, AT));
      }),
      SEEDED,
    );
  });

  it("refuses an invalid code by the check it fails, never naming the code", () => {
    fc.assert(
      fc.property(artificialArb, (hetu) => {
        // Every other check character makes the code invalid.
        const wrong = `${hetu.slice(0, 10)}${hetu[10] === "0" ? "1" : "0"}`;
        expect(() => deriveArtificialIdentity(wrong, key, AT)).toThrow(InvalidHetuError);
        expect(() => deriveArtificialIdentity(wrong, key, AT)).toThrow(/\(checksum\)$/);
        expect(() => deriveArtificialIdentity(wrong, key, AT)).not.toThrow(wrong);
      }),
      SEEDED,
    );
    expect(() => deriveArtificialIdentity("not a code", key, AT)).toThrow(/\(format\)$/);
  });
});

describe("registerArtificial", () => {
  const hetu = "170677-924F";

  async function identityOf(ctx: TestContext, hetuHmac: string) {
    const { rows } = await ctx.client.query<{
      id: string;
      subject: string;
      authenticated: Date | null;
    }>(
      "SELECT id, broker_subject AS subject, authenticated_at AS authenticated FROM identity WHERE hetu_hmac = $1",
      [hetuHmac],
    );
    return rows;
  }

  test("creates the identity and the account once, resumes the live account, and refuses as the callback would", async ({
    ctx,
  }) => {
    const first = await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT });
    expect(first.kind).toBe("created");
    const rows = await identityOf(ctx, first.hetuHmac);
    expect(rows.map(({ subject, authenticated }) => ({ subject, authenticated }))).toEqual([
      { subject: "test:one", authenticated: null },
    ]);
    const again = await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT });
    expect(again).toEqual({
      kind: "resumed",
      accountId: (first as { accountId: string }).accountId,
      hetuHmac: first.hetuHmac,
    });
    await ctx.client.query("UPDATE identity SET standing = 'banned' WHERE hetu_hmac = $1", [
      first.hetuHmac,
    ]);
    expect(
      await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT }),
    ).toEqual({
      kind: "refused",
      reason: "banned",
      hetuHmac: first.hetuHmac,
    });
    // A code a person could have: refused before any row is read or written.
    await expect(
      registerArtificial(ctx.client, {
        hetu: `010190-123${checkCharacter("010190", "123")}`,
        key,
        subject: "test:two",
        now: AT,
      }),
    ).rejects.toThrow(NotArtificialError);
  });

  test("after a deletion it waits out the cooldown, then gets a fresh account on the same identity", async ({
    ctx,
  }) => {
    const first = await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT });
    if (first.kind !== "created") throw new Error("not created");
    const until = new Date(AT.getTime() + 30 * DAY_MS);
    // What erasure leaves (TD-7): the tombstone and the identity's cooldown.
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [first.accountId]);
    await ctx.client.query(
      "UPDATE identity SET deletion_count = 1, reregister_after = $2 WHERE hetu_hmac = $1",
      [first.hetuHmac, until],
    );
    expect(
      await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT }),
    ).toEqual({ kind: "refused", reason: "cooldown", hetuHmac: first.hetuHmac });

    const later = new Date(until.getTime() + 1);
    const fresh = await registerArtificial(ctx.client, {
      hetu,
      key,
      subject: "test:one",
      now: later,
    });
    expect(fresh.kind).toBe("created");
    if (fresh.kind !== "created") throw new Error("not created");
    expect(fresh.accountId).not.toBe(first.accountId);
    const [identity] = await identityOf(ctx, first.hetuHmac);
    const accounts = await ctx.client.query<{ id: string; state: string; birth_year: number }>(
      "SELECT id, state, birth_year FROM account WHERE identity_id = $1 ORDER BY registered_at, state",
      [identity?.id],
    );
    // One identity, the tombstone and the new account, which starts over with nothing restored.
    expect(accounts.rows.map((a) => [a.id, a.state])).toEqual(
      expect.arrayContaining([
        [first.accountId, "deleted"],
        [fresh.accountId, "registered"],
      ]),
    );
    expect(accounts.rows).toHaveLength(2);
    expect(accounts.rows.find((a) => a.id === fresh.accountId)?.birth_year).toBe(1977);
  });

  test("a suspended identity is refused and nothing is written", async ({ ctx }) => {
    const first = await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT });
    await ctx.client.query("UPDATE identity SET standing = 'suspended' WHERE hetu_hmac = $1", [
      first.hetuHmac,
    ]);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted' WHERE identity_id = (SELECT id FROM identity WHERE hetu_hmac = $1)",
      [first.hetuHmac],
    );
    expect(
      await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now: AT }),
    ).toEqual({ kind: "refused", reason: "suspended", hetuHmac: first.hetuHmac });
    const live = await ctx.client.query(
      "SELECT count(*) AS n FROM account WHERE identity_id = (SELECT id FROM identity WHERE hetu_hmac = $1) AND state <> 'deleted'",
      [first.hetuHmac],
    );
    expect(Number(live.rows[0]?.n)).toBe(0);
  });
});
