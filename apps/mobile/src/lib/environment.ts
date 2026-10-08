import * as Updates from "expo-updates";

export type AppEnvironment = "development" | "preview" | "staging" | "production";

const ENVIRONMENTS: ReadonlySet<string> = new Set([
  "development",
  "preview",
  "staging",
  "production",
]);

/**
 * Which environment this JavaScript runs in, from the EAS Update channel: no
 * channel is a dev client on Metro, `production` the store's build, `pr-<n>`
 * a pull request's preview, anything else staging. `EXPO_PUBLIC_APP_ENV`,
 * set for a build, overrides everything but the production channel, so a dev
 * client pointed at staging reads as staging and a store build can never be
 * talked into showing what the store must not see; a value that names no
 * environment is ignored. The one reader of the channel (#143): everything
 * that differs by environment asks here.
 */
export function appEnvironmentOf(
  channel: string | null | undefined,
  override?: string | null,
): AppEnvironment {
  if (channel === "production") return "production";
  if (override && ENVIRONMENTS.has(override)) return override as AppEnvironment;
  if (!channel) return "development";
  if (channel.startsWith("pr-")) return "preview";
  return "staging";
}

export function appEnvironment(): AppEnvironment {
  return appEnvironmentOf(Updates.channel, process.env.EXPO_PUBLIC_APP_ENV);
}

/** The store's build: no tech config, no test error, released languages only. */
export const isProduction = (): boolean => appEnvironment() === "production";
