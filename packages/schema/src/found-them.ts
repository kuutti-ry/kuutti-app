import { z } from "zod";

/**
 * "Löysin hänet" (#83, ADR-040): why the person found somebody, a closed
 * list, the maintainer's of 21/10/2026: on Kuutti, elsewhere, another reason.
 * Mirrors the database's found_reason.
 */
export const FoundReason = z.enum(["here", "elsewhere", "other"]).meta({ id: "FoundReason" });
export type FoundReason = z.infer<typeof FoundReason>;

/** Telling Kuutti one found somebody: the reason alone. Nothing else in the app changes. */
export const FoundThemRequest = z
  .object({ reason: FoundReason })
  .strict()
  .meta({ id: "FoundThemRequest" });
export type FoundThemRequest = z.infer<typeof FoundThemRequest>;

/** Whether the caller has told Kuutti they found somebody; never which reason, which the account does not keep. */
export const FoundThemStatus = z
  .object({ answered: z.boolean() })
  .strict()
  .meta({ id: "FoundThemStatus" });
export type FoundThemStatus = z.infer<typeof FoundThemStatus>;
