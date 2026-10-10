import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * app.json is the configuration. This file only stamps the git commit of the
 * JavaScript being exported or built into `extra.commit`, and the counted
 * version of the root package.json into `extra.version`, so the app can name
 * its own version next to the API's on the tech screen (#10, #172). CI sets
 * GITHUB_SHA, EAS builders EAS_BUILD_GIT_COMMIT_HASH, a checkout answers git.
 * The fingerprint skips `extra` (fingerprint.config.js): a new commit or a
 * new counted version is never a native change and never spends a build;
 * app.json's own `version` is the store's and moves with native batches.
 */
function countedVersion(): string {
  const root = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof root.version === "string" ? root.version : "0.0.0";
}
function commit(): string {
  const fromEnv = process.env.GITHUB_SHA ?? process.env.EAS_BUILD_GIT_COMMIT_HASH;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  extra: { ...config.extra, commit: commit(), version: countedVersion() },
});
