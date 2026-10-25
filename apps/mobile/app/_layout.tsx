import "../global.css";
import * as Sentry from "@sentry/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { ChatLiveProvider } from "@/features/chat";
import { LockProvider, SessionProvider, SignedOutToStart } from "@/features/identity";
import { PushNotifications } from "@/features/notifications";
import { ScreenReaderHint } from "@/features/settings";
import { DecisionButtonsProvider } from "@/lib/decision-buttons";
import { LocaleProvider } from "@/lib/locale";
import { PhotoDescriptionsProvider } from "@/lib/photo-descriptions";
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
        <PhotoDescriptionsProvider>
          <DecisionButtonsProvider>
            <SessionProvider>
              {/* The app's lock over everything while it is on (#418); off by default. */}
              <LockProvider>
                {/* The chat's socket while signed in and in front (#349). */}
                <ChatLiveProvider>
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      contentStyle: { backgroundColor: "transparent" },
                    }}
                  />
                  <StatusBar style="auto" />
                  <SignedOutToStart />
                  {/* The push: the token while signed in, a tap opening what it is about (#102). */}
                  <PushNotifications />
                  {/* The one-time hint for a screen-reader user (#296); stays on the device. */}
                  <ScreenReaderHint />
                </ChatLiveProvider>
              </LockProvider>
            </SessionProvider>
          </DecisionButtonsProvider>
        </PhotoDescriptionsProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}

export default Sentry.wrap(RootLayout);
