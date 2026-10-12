import * as Sentry from "@sentry/react-native";
import * as Updates from "expo-updates";

/** The parts of expo-updates an update needs; tests hand in their own. */
export type UpdatesApi = Pick<
  typeof Updates,
  "checkForUpdateAsync" | "fetchUpdateAsync" | "reloadAsync"
>;

/**
 * Brings this build the newest JavaScript published for it and restarts into
 * it: what an app older than its API needs. "none" when there is no newer
 * update for this build, or the build cannot update itself (a development
 * client, the web preview); then only installing the app again helps.
 */
export async function updateApp(updates: UpdatesApi = Updates): Promise<"restarting" | "none"> {
  try {
    const check = await updates.checkForUpdateAsync();
    if (!check.isAvailable) return "none";
    await updates.fetchUpdateAsync();
    await updates.reloadAsync();
    return "restarting";
  } catch (error) {
    Sentry.captureException(error);
    return "none";
  }
}
