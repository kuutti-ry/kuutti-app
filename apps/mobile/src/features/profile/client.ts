import {
  type ApiComponents,
  CardPreviewResponse,
  DealBreakersResponse,
  type DealBreakersUpdate,
  ErrorResponse,
  ProfileResponse,
  type ProfileUpdate,
} from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The profile routes as the app calls them (#47), through the typed client;
// the zod contracts guard the runtime (ADR-003).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

// A section saves as the person leaves it (#238), so the next screen can be
// reading while the save is still on its way. A save waits for the one before
// it, and every read of the profile waits for the last save: the list, the
// card and the deal-breakers show what was stored, and two saves never land
// out of order. Settled either way: a failed save is its screen's to report.
let lastSave: Promise<unknown> = Promise.resolve();

export async function fetchProfile(): Promise<ProfileResponse> {
  await lastSave;
  const { data, error, response } = await api.GET("/profile");
  if (!data) throw failed(response, error, "profile");
  return ProfileResponse.parse(data);
}

export function saveProfile(update: ProfileUpdate): Promise<ProfileResponse> {
  const sent = lastSave.then(async () => {
    // The generated body type spells the strict objects with an index signature
    // the zod type has no room for; the contract is the zod schema (ADR-003).
    const { data, error, response } = await api.PUT("/profile", {
      body: update as unknown as ApiComponents["schemas"]["ProfileUpdate"],
    });
    if (!data) throw failed(response, error, "profile save");
    return ProfileResponse.parse(data);
  });
  lastSave = sent.catch(() => undefined);
  return sent;
}

export async function fetchCardPreview(): Promise<CardPreviewResponse> {
  await lastSave;
  const { data, error, response } = await api.GET("/profile/card");
  if (!data) throw failed(response, error, "card preview");
  return CardPreviewResponse.parse(data);
}

// The deal-breakers (#149) live with the preferences on the API and with the
// profile here: the screen is profile completion as much as a filter.
export async function fetchDealBreakers(): Promise<DealBreakersResponse> {
  // Which deal-breakers are open depends on the answers a section may still be saving.
  await lastSave;
  const { data, error, response } = await api.GET("/preferences/deal-breakers");
  if (!data) throw failed(response, error, "deal-breakers");
  return DealBreakersResponse.parse(data);
}

export async function saveDealBreakers(update: DealBreakersUpdate): Promise<DealBreakersResponse> {
  const { data, error, response } = await api.PUT("/preferences/deal-breakers", {
    body: update as unknown as ApiComponents["schemas"]["DealBreakersUpdate"],
  });
  if (!data) throw failed(response, error, "deal-breakers save");
  return DealBreakersResponse.parse(data);
}
