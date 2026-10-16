import { z } from "zod";

// The tunables in the panel (#304, #305): every key of matching_config with
// its versions, and a new version with a reason. The value is JSON as the
// table stores it; the API holds a change to the current value's shape.

/** A key as migrations name it: lower case, digits and underscores. */
export const ConfigKeyName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const ConfigKeyParams = z.object({ key: ConfigKeyName }).meta({ id: "ConfigKeyParams" });

/**
 * What a tunable holds: a number, a string, a boolean, or a flat object of
 * those (the photo fetch budgets). Every key of matching_config is one.
 */
const Scalar = z.union([z.number(), z.string(), z.boolean()]);
export const ConfigValue = z
  .union([Scalar, z.record(z.string(), Scalar)])
  .meta({ id: "ConfigValue" });
export type ConfigValue = z.infer<typeof ConfigValue>;

/** Why a value changed, in the admin's words; required for every change from the panel. */
export const CONFIG_REASON_MAX = 500;

export const ConfigVersion = z
  .object({
    version: z.int().min(1),
    value: ConfigValue,
    validFrom: z.iso.datetime(),
    /** The panel's changes name the admin's identity id; the seed and migrations their own name. */
    createdBy: z.string(),
    /** Null for what the seed and the migrations wrote before reasons were kept. */
    reason: z.string().max(CONFIG_REASON_MAX).nullable(),
  })
  .meta({ id: "ConfigVersion" });
export type ConfigVersion = z.infer<typeof ConfigVersion>;

export const ConfigKey = z
  .object({
    key: ConfigKeyName,
    /** The latest version's value, which every reader uses from the next request on. */
    value: ConfigValue,
    version: z.int().min(1),
    /** Newest first. */
    versions: z.array(ConfigVersion).min(1).max(1000),
  })
  .meta({ id: "ConfigKey" });
export type ConfigKey = z.infer<typeof ConfigKey>;

/** What a change wrote: the key, and the version, value, time, author and reason of the new row. */
export const ConfigChange = ConfigVersion.extend({ key: ConfigKeyName }).meta({
  id: "ConfigChange",
});
export type ConfigChange = z.infer<typeof ConfigChange>;

export const ConfigList = z
  .object({ items: z.array(ConfigKey).max(500) })
  .meta({ id: "ConfigList" });
export type ConfigList = z.infer<typeof ConfigList>;

export const ConfigChangeRequest = z
  .object({
    value: ConfigValue,
    reason: z.string().trim().min(1).max(CONFIG_REASON_MAX),
  })
  .strict()
  .meta({ id: "ConfigChangeRequest" });
export type ConfigChangeRequest = z.infer<typeof ConfigChangeRequest>;
