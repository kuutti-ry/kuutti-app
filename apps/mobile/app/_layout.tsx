import "../global.css";
import * as Sentry from "@sentry/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { SessionProvider, SignedOutToStart } from "@/features/identity";
import { LocaleProvider } from "@/lib/locale";
import { sentryOptions } from "@/lib/sentry";
import { ThemeProvider } from "@/theme/ThemeProvider";

// Error reporting (#11): on exactly when EXPO_PUBLIC_SENTRY_DSN is set for the
// build or update; options in src/lib/sentry.ts, asserted by its test.
Sentry.init(sentryOptions({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN, channel: Updates.channel }));

// Routes stay thin and delegate to src/features/<slice>/ (rules/layout.md).
function RootLayout() {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <SessionProvider>
          <Stack
            screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "transparent" } }}
          />
          <StatusBar style="auto" />
          <SignedOutToStart />
        </SessionProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}

export default Sentry.wrap(RootLayout);
