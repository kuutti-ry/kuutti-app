import Constants from "expo-constants";

type Config = { version?: string; extra?: Record<string, unknown> } | null | undefined;

/**
 * The counted version (#172) and the git commit that app.config.ts stamped
 * into the config when this JavaScript was built; null when the build carries
 * none. The version rides in extra, which the fingerprint skips; app.json's
 * is the store's and stands in only when extra has none. Settings and the
 * tech screen both name them (#287).
 */
export function buildInfo(config: Config = Constants.expoConfig): {
  version: string | null;
  commit: string | null;
} {
  const version: unknown = config?.extra?.version ?? config?.version;
  const commit: unknown = config?.extra?.commit;
  return {
    version: typeof version === "string" && version.length > 0 ? version : null,
    commit: typeof commit === "string" && commit.length > 0 ? commit : null,
  };
}
