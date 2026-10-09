import type { Queryable } from "@kuutti/db";
import { hetuProblem, parseHetu } from "@kuutti/tunnistus-oidc/hetu";
import { type DerivedIdentity, deriveIdentity, InvalidHetuError } from "./hetu.ts";
import { decideRegistration } from "./registration.ts";
import * as repo from "./repo.ts";

/**
 * The one way an identity is made without a bank (ADR-018 §2): for the demo
 * job in the staging container, from a code that cannot be a person's. The
 * population register gives nobody an individual number of 900 to 999
 * (ADR-014 §3); a test person of Telia's bed and a persona of the mock bank
 * have one. Everything else is the callback's own: the derivation, the
 * re-registration rule, the rows a registration writes.
 */
export const ARTIFICIAL_INDIVIDUAL = { min: 900, max: 999 } as const;

/** The code could be a person's: this slice derives nothing from it outside the callback. */
export class NotArtificialError extends Error {
  constructor() {
    super("the personal identity code is not an artificial one");
    this.name = "NotArtificialError";
  }
}

/**
 * The identity of an artificial code, derived as the callback derives
 * everybody's. A code whose individual number a person could have is refused
 * before any derivation, so what this slice hands out can never be a
 * person's hash, whatever calls it.
 */
export function deriveArtificialIdentity(hetu: string, key: Buffer, at: Date): DerivedIdentity {
  const parsed = parseHetu(hetu);
  if (parsed === null) throw new InvalidHetuError(hetuProblem(hetu) ?? "format");
  const n = parsed.individualNumber;
  if (n < ARTIFICIAL_INDIVIDUAL.min || n > ARTIFICIAL_INDIVIDUAL.max)
    throw new NotArtificialError();
  return deriveIdentity(hetu, key, at);
}

export type ArtificialRegistration =
  | { kind: "created" | "resumed"; accountId: string; hetuHmac: string }
  | { kind: "refused"; reason: "banned" | "suspended" | "cooldown"; hetuHmac: string };

/**
 * What a registration does, for an artificial code: derive, decide by the
 * callback's rule (a banned identity or one inside its waiting time is
 * refused as a person would be), and write the rows a login writes. The
 * identity row carries the caller's subject as its mark and no time of
 * authentication, since no bank was involved (ADR-014 §9); its hash is the
 * code's, so a login at a test bank finds it and resumes the account. The
 * code is an argument here and is kept by nothing.
 */
export async function registerArtificial(
  db: Queryable,
  input: { hetu: string; key: Buffer; subject: string; now: Date },
): Promise<ArtificialRegistration> {
  const derived = deriveArtificialIdentity(input.hetu, input.key, input.now);
  const identity = await repo.findIdentityByHmac(db, derived.hetuHmac);
  const liveAccount = identity ? await repo.findLiveAccount(db, identity.id) : null;
  const decision = decideRegistration({ identity, liveAccount, now: input.now });
  const birth = { birthYear: derived.birthYear, birthMonth: derived.birthMonth };
  switch (decision.kind) {
    case "refuse":
      return { kind: "refused", reason: decision.reason, hetuHmac: derived.hetuHmac };
    case "create_identity": {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO identity (hetu_hmac, broker_subject, created_at)
         VALUES ($1, $2, $3) ON CONFLICT (hetu_hmac) DO NOTHING RETURNING id`,
        [derived.hetuHmac, input.subject, input.now],
      );
      const identityId = rows[0]?.id;
      if (!identityId) throw new Error("the identity was written meanwhile");
      const account = await repo.insertAccount(db, { identityId, ...birth });
      return { kind: "created", accountId: account.id, hetuHmac: derived.hetuHmac };
    }
    case "create_account": {
      const account = await repo.insertAccount(db, { identityId: decision.identityId, ...birth });
      return { kind: "created", accountId: account.id, hetuHmac: derived.hetuHmac };
    }
    case "resume":
      return { kind: "resumed", accountId: decision.account.id, hetuHmac: derived.hetuHmac };
  }
}
