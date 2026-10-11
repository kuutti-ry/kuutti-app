import type { ReactNativeOptions } from "@sentry/react-native";
import { type AppEnvironment, appEnvironmentOf } from "./environment";

export type SentryEnvironment = AppEnvironment;

/** The environment an error is filed under: the channel's, as everything else reads it (#143). */
export const sentryEnvironment = (channel: string | null | undefined): SentryEnvironment =>
  appEnvironmentOf(channel);

type Breadcrumb =
  NonNullable<ReactNativeOptions["beforeBreadcrumb"]> extends (b: infer B) => unknown ? B : never;

/**
 * Navigation breadcrumbs carry route params (a profile id, a chat id); http
 * ones carry URLs with query strings. Category and route name are enough to
 * read a crash, the payloads are not ours to ship.
 */
export function stripBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (crumb.category === "navigation" && crumb.data) {
    const { from, to } = crumb.data as { from?: unknown; to?: unknown };
    return { ...crumb, data: { from, to } };
  }
  if (crumb.category === "http" || crumb.category === "xhr" || crumb.category === "fetch") {
    const { method, status_code } = (crumb.data ?? {}) as {
      method?: unknown;
      status_code?: unknown;
    };
    return { ...crumb, data: { method, status_code } };
  }
  return crumb;
}

/**
 * The SDK sets `user.id` to its per-installation id when the app sets no user.
 * A stable device identifier that links every error from one phone is user
 * data (#28, TD-19), and no stack trace needs it: the event goes out without.
 */
export function stripUser<E extends { user?: unknown }>(event: E): E {
  return { ...event, user: undefined };
}

/**
 * Error reporting only (TD-19, #11, rules/mobile.md: no analytics SDK): no
 * PII, no tracing, no session replay, no screenshots, no session tracking.
 * The DSN is public by design (EXPO_PUBLIC_SENTRY_DSN); without one the SDK
 * stays off, which is every local run.
 */
export function sentryOptions(input: {
  dsn: string | undefined;
  channel: string | null | undefined;
}): ReactNativeOptions {
  return {
    dsn: input.dsn,
    enabled: input.dsn !== undefined && input.dsn !== "",
    environment: sentryEnvironment(input.channel),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableAutoSessionTracking: false,
    // Default integrations minus anything that records the screen or asks the user for input.
    integrations: (defaults) => defaults.filter((i) => !/replay|feedback/i.test(i.name)),
    beforeBreadcrumb: stripBreadcrumb,
    beforeSend: (event) => stripUser(event),
  };
}
