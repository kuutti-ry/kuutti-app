import { z } from "zod";
import { DISTANCE_FILTER_BANDS } from "./distance.ts";
import { DEAL_BREAKER_FIELDS, PROFILE_FIELDS, type ProfileFieldKey } from "./profile-fields.ts";

/**
 * Deal-breakers (#149, TD-16, the field sheet's disclose-to-filter rule):
 * hard rows of `preferences` on a whitelisted field of the registry, at most
 * `matching_config.deal_breakers_max` of them, each only on a field the
 * person has answered themselves. A deal-breaker whose own answer was taken
 * back is paused, which is read, never stored. #87 applies them in the pool,
 * both ways. `distance` is one with no field of the registry (ADR-061 §7): it
 * reads the home everybody has, so it is never paused, and it stores
 * `includeUnknown` true since nobody can leave it unanswered.
 */

type DealBreakerKey = ProfileFieldKey | "distance";
const DEAL_BREAKER_KEYS: readonly DealBreakerKey[] = [...DEAL_BREAKER_FIELDS, "distance"];

/** One per field and the distance is the contract's ceiling; the number is the tunable's alone (the maintainer, #508). */
export const DEAL_BREAKERS_CAP = DEAL_BREAKER_KEYS.length;

export const DealBreakerField = z
  .enum(DEAL_BREAKER_KEYS as [DealBreakerKey, ...DealBreakerKey[]])
  .meta({ id: "DealBreakerField" });
export type DealBreakerField = z.infer<typeof DealBreakerField>;

/** What a deal-breaker on the field may accept: the options of a list, the relations of a number (#508), the bands of the distance. */
export function dealBreakerOptions(field: DealBreakerField): readonly string[] {
  if (field === "distance") return DISTANCE_FILTER_BANDS;
  const spec = PROFILE_FIELDS[field];
  if (spec.kind === "number") return spec.relations;
  return spec.kind === "single" || spec.kind === "multi" ? spec.options : [];
}

export const DealBreaker = z
  .object({
    field: DealBreakerField,
    /** The answers of others the person accepts; at least one, each an option of the field, and one alone on a number (the API holds that). */
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
