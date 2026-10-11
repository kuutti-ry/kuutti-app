import { z } from "zod";
import { DEAL_BREAKER_FIELDS, type ProfileFieldKey } from "./profile-fields.ts";

/**
 * Deal-breakers (#149, TD-16, the field sheet's disclose-to-filter rule):
 * hard rows of `preferences` on a whitelisted field of the registry, at most
 * `matching_config.deal_breakers_max` of them, each only on a field the
 * person has answered themselves. A deal-breaker whose own answer was taken
 * back is paused, which is read, never stored. #87 applies them in the pool,
 * both ways.
 */

/** The contract's ceiling; the rule is the tunable (2 at launch). */
export const DEAL_BREAKERS_CAP = 5;

export const DealBreakerField = z
  .enum(DEAL_BREAKER_FIELDS as unknown as [ProfileFieldKey, ...ProfileFieldKey[]])
  .meta({ id: "DealBreakerField" });
export type DealBreakerField = z.infer<typeof DealBreakerField>;

export const DealBreaker = z
  .object({
    field: DealBreakerField,
    /** The answers of others the person accepts; at least one, each an option of the field (the API holds that). */
    accept: z.array(z.string().min(1).max(40)).min(1).max(60),
    /** Whether a person who left the field unanswered passes. */
    includeUnknown: z.boolean(),
  })
  .strict()
  .meta({ id: "DealBreaker" });
export type DealBreaker = z.infer<typeof DealBreaker>;

export const DealBreakersUpdate = z
  .object({ dealBreakers: z.array(DealBreaker).max(DEAL_BREAKERS_CAP) })
  .strict()
  .meta({ id: "DealBreakersUpdate" });
export type DealBreakersUpdate = z.infer<typeof DealBreakersUpdate>;

export const StoredDealBreaker = DealBreaker.extend({
  /** The person's own answer on the field is missing: the filter waits until they answer again. */
  paused: z.boolean(),
}).meta({ id: "StoredDealBreaker" });
export type StoredDealBreaker = z.infer<typeof StoredDealBreaker>;

export const DealBreakersResponse = z
  .object({
    dealBreakers: z.array(StoredDealBreaker).max(DEAL_BREAKERS_CAP),
    /** How many a person may have: `matching_config.deal_breakers_max`. */
    max: z.int().min(0).max(DEAL_BREAKERS_CAP),
  })
  .meta({ id: "DealBreakersResponse" });
export type DealBreakersResponse = z.infer<typeof DealBreakersResponse>;
