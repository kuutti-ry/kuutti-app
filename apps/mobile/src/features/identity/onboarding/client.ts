import {
  type ApiComponents,
  type ConsentKind,
  ConsentsResponse,
  ErrorResponse,
  type Gender,
  OnboardingStatus,
  type PreferencesUpdate,
  type WithdrawableConsentKind,
} from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The onboarding routes as the app calls them (#46), through the typed
// client; the zod contracts guard the runtime (ADR-003).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

export async function fetchOnboarding(): Promise<OnboardingStatus> {
  const { data, error, response } = await api.GET("/onboarding");
  if (!data) throw failed(response, error, "onboarding");
  return OnboardingStatus.parse(data);
}

export async function declareGender(gender: Gender): Promise<void> {
  const { error, response } = await api.PUT("/account/gender", { body: { gender } });
  if (!response.ok) throw failed(response, error, "gender");
}

export async function savePreferences(update: PreferencesUpdate): Promise<void> {
  // The generated body type spells the strict object with an index signature the zod type has no room for (ADR-003).
  const { error, response } = await api.PUT("/preferences", {
    body: update as unknown as ApiComponents["schemas"]["PreferencesUpdate"],
  });
  if (!response.ok) throw failed(response, error, "preferences");
}

/** The consent texts exist in fi, sv and en; the pseudo-locale reads the English. */
export const consentLocale = (locale: string): "fi" | "sv" | "en" =>
  locale === "fi" || locale === "sv" ? locale : "en";

export async function fetchConsents(): Promise<ConsentsResponse> {
  const { data, error, response } = await api.GET("/consents");
  if (!data) throw failed(response, error, "consents");
  return ConsentsResponse.parse(data);
}

/** Research, or the special-category consent, which takes the seek answer with it (ADR-019 §4). */
export async function withdrawConsent(kind: WithdrawableConsentKind): Promise<ConsentsResponse> {
  const { data, error, response } = await api.DELETE("/consents/{kind}", {
    params: { path: { kind } },
  });
  if (!data) throw failed(response, error, "consent withdrawal");
  return ConsentsResponse.parse(data);
}

export async function giveConsent(
  kind: ConsentKind,
  version: string,
  locale: "fi" | "sv" | "en",
): Promise<ConsentsResponse> {
  const { data, error, response } = await api.POST("/consents", {
    body: { kind, version, locale },
  });
  if (!data) throw failed(response, error, "consent");
  return ConsentsResponse.parse(data);
}
