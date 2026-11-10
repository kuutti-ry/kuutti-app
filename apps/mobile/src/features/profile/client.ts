import {
  type ApiComponents,
  CardPreviewResponse,
  type DealBreaker,
  type DealBreakerField,
  DealBreakersResponse,
  type DealBreakersUpdate,
  type Gender,
  HomeSummary,
  type HomeUpdate,
  OnboardingStatus,
  PreferencesResponse,
  type PreferencesUpdate,
  type ProfileDocument,
  ProfileResponse,
  type ProfileUpdate,
  photoWithKnownDescription,
} from "@kuutti/schema";
import { api, failed } from "@/lib/api";

// The profile routes as the app calls them (#47), through the typed client;
// the zod contracts guard the runtime (ADR-003).

// A section saves as the person leaves it (#238), so the next screen can be
// reading while the save is still on its way. A save waits for the one before
// it, and every read of the profile waits for the last save: the list, the
// card and the deal-breakers show what was stored, and two saves never land
// out of order. Settled either way: a failed save is its screen's to report.
let lastSave: Promise<unknown> = Promise.resolve();

/** A save in the line: it goes once the one before has settled, taken or not, and the next one waits for it. */
function inLine<T>(send: () => Promise<T>): Promise<T> {
  const sent = lastSave.then(send);
  lastSave = sent.catch(() => undefined);
  return sent;
}

async function readProfile(): Promise<ProfileResponse> {
  const { data, error, response } = await api.GET("/profile");
  if (!data) throw failed(response, error, "profile");
  return ProfileResponse.parse(data);
}

export async function fetchProfile(): Promise<ProfileResponse> {
  await lastSave;
  return readProfile();
}

/**
 * Saves the document `build` makes of the one stored when this save's turn
 * comes, read just before it goes: a screen puts its own changes on it, so a
 * save from another screen since that screen read the profile is kept, never
 * undone by a whole draft read before it (#238). The API takes the whole
 * document (ADR-003); the read is what keeps it current.
 */
export function saveProfile(
  build: (stored: ProfileDocument | null) => ProfileUpdate,
): Promise<ProfileResponse> {
  return inLine(async () => {
    const { profile } = await readProfile();
    // The generated body type spells the strict objects with an index signature
    // the zod type has no room for; the contract is the zod schema (ADR-003).
    const { data, error, response } = await api.PUT("/profile", {
      body: build(profile) as unknown as ApiComponents["schemas"]["ProfileUpdate"],
    });
    if (!data) throw failed(response, error, "profile save");
    return ProfileResponse.parse(data);
  });
}

export async function fetchCardPreview(): Promise<CardPreviewResponse> {
  await lastSave;
  const { data, error, response } = await api.GET("/profile/card");
  if (!data) throw failed(response, error, "card preview");
  // A description key this build has no words for is left out (#296), as the photo list does.
  const card = data.card
    ? { ...data.card, photos: data.card.photos.map(photoWithKnownDescription) }
    : data.card;
  return CardPreviewResponse.parse({ ...data, card });
}

/**
 * A new home, what the card shows of it, or both (ADR-061 §1, §3), in the line
 * of saves, so that the list and the card read what was stored. The digits go
 * in this body and nowhere else: never a path, a query or a log (§9).
 */
export function saveHome(update: HomeUpdate): Promise<HomeSummary> {
  return inLine(async () => {
    const { data, error, response } = await api.PUT("/account/home", {
      body: update as unknown as ApiComponents["schemas"]["HomeUpdate"],
    });
    if (!data) throw failed(response, error, "home");
    return HomeSummary.parse(data);
  });
}

// The gender is the account's and no part of the document, and GET /onboarding
// is the one read that says it with its limit. It lives with the profile here
// all the same (#552): onboarding asks it once, the profile's row keeps it. In
// the line of saves: the list reads what the screen stored on leaving.
export type OwnGender = { gender: Gender | null; nextChange: string | null };

export async function fetchOwnGender(): Promise<OwnGender> {
  await lastSave;
  const { data, error, response } = await api.GET("/onboarding");
  if (!data) throw failed(response, error, "onboarding");
  const { gender, nextChange } = OnboardingStatus.parse(data);
  return { gender, nextChange: nextChange.gender };
}

export function saveGender(gender: Gender): Promise<void> {
  return inLine(async () => {
    const { error, response } = await api.PUT("/account/gender", { body: { gender } });
    if (!response.ok) throw failed(response, error, "gender");
  });
}

// What one seeks lives with the profile here (#542): onboarding asks it once,
// What you seek keeps it. In the line of saves, as a section is: the list reads
// what a screen stored on leaving.
export async function fetchPreferences(): Promise<PreferencesResponse> {
  await lastSave;
  const { data, error, response } = await api.GET("/preferences");
  if (!data) throw failed(response, error, "preferences");
  return PreferencesResponse.parse(data);
}

export function savePreferences(update: PreferencesUpdate): Promise<PreferencesResponse> {
  return inLine(async () => {
    // The generated body type spells the strict object with an index signature the zod type has no room for (ADR-003).
    const { data, error, response } = await api.PUT("/preferences", {
      body: update as unknown as ApiComponents["schemas"]["PreferencesUpdate"],
    });
    if (!data) throw failed(response, error, "preferences");
    return PreferencesResponse.parse(data);
  });
}

// The deal-breakers (#149) live with the preferences on the API and with the
// profile here: their rows are profile completion as much as a filter.
async function readDealBreakers(): Promise<DealBreakersResponse> {
  const { data, error, response } = await api.GET("/preferences/deal-breakers");
  if (!data) throw failed(response, error, "deal-breakers");
  return DealBreakersResponse.parse(data);
}

export async function fetchDealBreakers(): Promise<DealBreakersResponse> {
  // Which deal-breakers are open depends on the answers a section may still be saving.
  await lastSave;
  return readDealBreakers();
}

/** What a deal-breaker's screen edits: nothing accepted is Everyone, which is having none (#551). */
export type DealBreakerFilter = Omit<DealBreaker, "field">;

/**
 * One deal-breaker changed or taken off, in the line of saves (#551). The API
 * takes the whole set, so this reads the set when its turn comes and swaps the
 * one field, as `saveProfile` does with the document: another screen's save is
 * kept. Its own read, since `fetchDealBreakers` would wait for this very save.
 * A paused filter goes back as it stands, which the API keeps: dropping `paused`
 * drops the key, never the row.
 */
export function saveDealBreaker(
  field: DealBreakerField,
  filter: DealBreakerFilter,
): Promise<DealBreakersResponse> {
  return inLine(async () => {
    const { dealBreakers } = await readDealBreakers();
    const update: DealBreakersUpdate = {
      dealBreakers: [
        ...dealBreakers.flatMap(({ paused: _, ...kept }) => (kept.field === field ? [] : [kept])),
        ...(filter.accept.length > 0 ? [{ field, ...filter }] : []),
      ],
    };
    const { data, error, response } = await api.PUT("/preferences/deal-breakers", {
      body: update as unknown as ApiComponents["schemas"]["DealBreakersUpdate"],
    });
    if (!data) throw failed(response, error, "deal-breakers save");
    return DealBreakersResponse.parse(data);
  });
}
