import { randomBytes } from "node:crypto";
import { checkCharacter, generateHetu, parseHetu } from "@kuutti/tunnistus-oidc/hetu";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { test } from "../test/harness.ts";
import {
  ARTIFICIAL_INDIVIDUAL,
  deriveArtificialIdentity,
  NotArtificialError,
  registerArtificial,
} from "./artificial.ts";
import { deriveIdentity } from "./hetu.ts";

// Property tests for the one derivation that leaves the slice (ADR-018 §2,
// CLAUDE.md Testing): a code a person could have is refused before anything
// is hashed, and an artificial one is derived exactly as the callback does.

const AT = new Date("2026-10-01T12:00:00Z");
const key = randomBytes(32);

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
    );
  });

  it("derives an artificial code exactly as the callback derives everybody's", () => {
    fc.assert(
      fc.property(artificialArb, (hetu) => {
        expect(deriveArtificialIdentity(hetu, key, AT)).toEqual(deriveIdentity(hetu, key, AT));
      }),
    );
  });
});

describe("registerArtificial", () => {
  test("creates the identity and the account once, resumes the live account, and refuses as the callback would", async ({
    ctx,
  }) => {
    const hetu = "170677-924F";
    const now = new Date();
    const first = await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now });
    expect(first.kind).toBe("created");
    const { rows } = await ctx.client.query<{ subject: string; authenticated: Date | null }>(
      "SELECT broker_subject AS subject, authenticated_at AS authenticated FROM identity WHERE hetu_hmac = $1",
      [first.hetuHmac],
    );
    expect(rows).toEqual([{ subject: "test:one", authenticated: null }]);
    const again = await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now });
    expect(again).toEqual({
      kind: "resumed",
      accountId: (first as { accountId: string }).accountId,
      hetuHmac: first.hetuHmac,
    });
    await ctx.client.query("UPDATE identity SET standing = 'banned' WHERE hetu_hmac = $1", [
      first.hetuHmac,
    ]);
    expect(await registerArtificial(ctx.client, { hetu, key, subject: "test:one", now })).toEqual({
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
        now,
      }),
    ).rejects.toThrow(NotArtificialError);
  });
});
