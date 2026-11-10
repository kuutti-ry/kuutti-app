import { CONSENT_VERSIONS, realLocale } from "@kuutti/i18n";
import {
  type ConsentKind,
  ConsentsResponse,
  OnboardingStatus,
  type WithdrawableConsentKind,
} from "@kuutti/schema";
import { api, failed } from "@/lib/api";

// The onboarding routes as the app calls them (#46), through the typed
// client; the zod contracts guard the runtime (ADR-003).

/**
 * The version of a wording as built into this app: what the person actually
 * read, and therefore what a consent names (ADR-010 §4). When the API has a
 * newer wording, the app asks for an update instead of recording a consent
 * for a text it never showed.
 */
export function bundledVersion(kind: ConsentKind): string {
  return CONSENT_VERSIONS[kind] ?? "";
}

export async function fetchOnboarding(): Promise<OnboardingStatus> {
  const { data, error, response } = await api.GET("/onboarding");
  if (!data) throw failed(response, error, "onboarding");
  return OnboardingStatus.parse(data);
}

/** The consent texts exist in fi, sv and en; Stadi reads the Finnish, the pseudo-locale the English. */
export const consentLocale = realLocale;

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
