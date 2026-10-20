import {
  ErrorResponse,
  FishSpecies,
  Photo,
  type PhotoCaption,
  PhotoList,
  PhotoRejectionReason,
  PhotoUrlResponse,
  type PhotoVariant,
  photoWithKnownDescription,
  TipKind,
} from "@kuutti/schema";
import { Platform } from "react-native";
import { ApiError, api, apiBaseUrl } from "@/lib/api";
import { accessTokenIsStale, currentSession, refreshSession } from "@/lib/session";
import type { PickedPhoto } from "./pick";

// The photo routes as the app calls them (#48). Reads and small writes go
// through the typed client; the upload is an XMLHttpRequest, the one transport
// on React Native that reports upload progress and streams a file from disk
// without loading it into JavaScript; the chat sends its photos through the
// same one (#350).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/**
 * A rejection reason this build has no words for is no reason (#376): the
 * tile says "Not accepted" alone, as it would for a rejection without one.
 */
function withKnownReason(photo: unknown): unknown {
  if (photo === null || typeof photo !== "object" || Array.isArray(photo)) return photo;
  const { rejectionReason } = photo as { rejectionReason?: unknown };
  if (rejectionReason == null || PhotoRejectionReason.safeParse(rejectionReason).success) {
    return photo;
  }
  return { ...photo, rejectionReason: null };
}

/** One of the owner's photos as this build can say it: its description (#296) and its reason. */
const asKnown = (photo: unknown): unknown => withKnownReason(photoWithKnownDescription(photo));

/**
 * The list as the API sent it, less what this build has no words for: a tip
 * kind it does not know is left out, a fish it cannot name is no fish (the
 * plain fish tip), a description's scene or object it cannot say is left out
 * of the description (#296), and a reason it cannot say is none (#376). A
 * newer API's tip, label or reason never locks an older app out of its own
 * photos.
 */
export function readPhotoList(data: unknown): PhotoList {
  const sent = data as { photos?: unknown; tips?: unknown; fishSpecies?: unknown } | null;
  if (!sent || !Array.isArray(sent.tips)) return PhotoList.parse(data);
  return PhotoList.parse({
    ...sent,
    photos: Array.isArray(sent.photos) ? sent.photos.map(asKnown) : sent.photos,
    tips: sent.tips.filter((kind) => TipKind.safeParse(kind).success),
    fishSpecies: FishSpecies.safeParse(sent.fishSpecies).success ? sent.fishSpecies : null,
  });
}

/** One photo as the API sent it, as this build can say it. */
const readPhoto = (data: unknown): Photo => Photo.parse(asKnown(data));

export async function listPhotos(): Promise<PhotoList> {
  const { data, error, response } = await api.GET("/photos");
  if (!data) throw failed(response, error, "photos");
  return readPhotoList(data);
}

export async function deletePhoto(id: string): Promise<void> {
  const { error, response } = await api.DELETE("/photos/{id}", { params: { path: { id } } });
  if (!response.ok) throw failed(response, error, "photo removal");
}

/** Ask a person to look at the check's rejection (#253); the photo comes back queued. */
export async function appealPhoto(id: string): Promise<Photo> {
  const { data, error, response } = await api.POST("/photos/{id}/appeal", {
    params: { path: { id } },
  });
  if (!data) throw failed(response, error, "photo appeal");
  return readPhoto(data);
}

/** The owner's line under a photo (#296): a key from the list, or null to clear it. */
export async function setPhotoCaption(id: string, caption: PhotoCaption | null): Promise<Photo> {
  const { data, error, response } = await api.PUT("/photos/{id}/caption", {
    params: { path: { id } },
    body: { caption },
  });
  if (!data) throw failed(response, error, "photo caption");
  return readPhoto(data);
}

export async function reorderPhotos(order: string[]): Promise<PhotoList> {
  const { data, error, response } = await api.PUT("/photos/order", { body: { order } });
  if (!data) throw failed(response, error, "photo order");
  return readPhotoList(data);
}

/** A URL good for fifteen minutes; the caller caches by photoId/variant, never by the URL. */
export async function fetchPhotoUrl(id: string, variant: PhotoVariant): Promise<PhotoUrlResponse> {
  const { data, error, response } = await api.GET("/photos/{id}/{variant}", {
    params: { path: { id, variant } },
  });
  if (!data) throw failed(response, error, "photo url");
  return PhotoUrlResponse.parse(data);
}

/**
 * The multipart body: the string fields first, then the picture; on the phone
 * the picture is a file reference the runtime streams, on the web preview the
 * blob itself.
 */
async function formFor(
  photo: PickedPhoto,
  fields: Readonly<Record<string, string>>,
): Promise<FormData> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (Platform.OS === "web") {
    const blob = await (await fetch(photo.uri)).blob();
    form.append("photo", blob, "photo.jpg");
  } else {
    // React Native's FormData takes { uri, name, type } for a file; the DOM
    // typing does not know that shape.
    form.append("photo", {
      uri: photo.uri,
      name: "photo.jpg",
      type: photo.mimeType,
    } as unknown as Blob);
  }
  return form;
}

type Sent = { status: number; body: string };

function send(
  path: string,
  token: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBaseUrl()}${path}`);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new ApiError("photo upload failed"));
    xhr.ontimeout = () => reject(new ApiError("photo upload timed out"));
    xhr.send(form);
  });
}

/** What an upload answered: its status, and its body as JSON, or null when it was empty or not JSON. */
export type UploadAnswer = { status: number; body: unknown };

/**
 * Posts a prepared picture to one of the API's upload routes with this
 * device's session (#35): the profile's photos, or a photo sent in a
 * conversation (#350), with the route's string fields beside it. The access
 * token is refreshed ahead of its expiry, and one 401 is answered by one
 * refresh and one retry, as the typed client does for every other request.
 * The caller reads the answer; `uploadRefusal` makes an error of one it does
 * not take.
 */
export async function uploadPicture(
  path: string,
  photo: PickedPhoto,
  fields: Readonly<Record<string, string>> = {},
  onProgress?: (fraction: number) => void,
): Promise<UploadAnswer> {
  let session = currentSession();
  if (session && accessTokenIsStale(session)) session = await refreshSession();
  if (!session) throw new ApiError("no session", 401, "unauthenticated");
  let sent = await send(path, session.accessToken, await formFor(photo, fields), onProgress);
  if (sent.status === 401) {
    const next = await refreshSession();
    if (!next) throw new ApiError("signed out", 401, "session_revoked");
    sent = await send(path, next.accessToken, await formFor(photo, fields), onProgress);
  }
  let body: unknown = null;
  try {
    body = sent.body ? JSON.parse(sent.body) : null;
  } catch {
    body = null;
  }
  return { status: sent.status, body };
}

/** An upload's answer the caller does not take, as an error with the API's code when it sent the envelope. */
export function uploadRefusal(answer: UploadAnswer): ApiError {
  const envelope = ErrorResponse.safeParse(answer.body);
  return new ApiError(
    `photo upload answered ${answer.status}`,
    answer.status,
    envelope.success ? envelope.data.error.code : undefined,
  );
}

/** Uploads a prepared picture as one of the person's photos (#48). */
export async function uploadPhoto(
  photo: PickedPhoto,
  onProgress?: (fraction: number) => void,
): Promise<Photo> {
  const answer = await uploadPicture("/photos", photo, {}, onProgress);
  if (answer.status === 201) return readPhoto(answer.body);
  throw uploadRefusal(answer);
}
