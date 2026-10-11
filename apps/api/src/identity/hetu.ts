import { createHmac } from "node:crypto";
import { type HetuProblem, hetuProblem, isAdult, parseHetu } from "@kuutti/tunnistus-oidc/hetu";

/**
 * What the callback keeps of a personal identity code (rules 1–3, TD-1): its
 * HMAC under the key that never leaves SSM, and the year and month of birth.
 * The code itself is an argument here and nowhere else; the result carries
 * nothing the code can be recovered from, and no legal sex (rule 3: the
 * parser never exposes it).
 */
export type DerivedIdentity = {
  hetuHmac: string;
  birthYear: number;
  birthMonth: number;
  adult: boolean;
};

/** Names the check the code failed and nothing of the code: the message is what the callback logs. */
export class InvalidHetuError extends Error {
  constructor(readonly problem: HetuProblem) {
    super(`the identification service returned an invalid personal identity code (${problem})`);
    this.name = "InvalidHetuError";
  }
}

export function deriveIdentity(hetu: string, key: Buffer, at: Date): DerivedIdentity {
  const parsed = parseHetu(hetu);
  if (parsed === null) throw new InvalidHetuError(hetuProblem(hetu) ?? "format");
  return {
    hetuHmac: createHmac("sha256", key).update(hetu.toUpperCase()).digest("hex"),
    birthYear: parsed.birthYear,
    birthMonth: parsed.birthMonth,
    adult: isAdult(parsed, at),
  };
}

/** The HMAC key as SSM holds it: 32 bytes as 64 hex characters (infra/README.md, Secrets). */
export function hmacKeyFromHex(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("HETU_HMAC_KEY must be 32 bytes as hex");
  return Buffer.from(hex, "hex");
}
