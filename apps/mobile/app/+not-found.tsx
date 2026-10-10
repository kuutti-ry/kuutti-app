import { Redirect } from "expo-router";

/**
 * A link the app has no screen for (a mistyped or stale deep link such as
 * `kuutti://auth/return`, an old route) goes to the start, where the session
 * decides between the sign-in and home. Without this, Expo Router shows its
 * own "Unmatched Route" page, unbranded and untranslated (09/10/2026, #36).
 */
export default function NotFoundRoute() {
  return <Redirect href="/" />;
}
