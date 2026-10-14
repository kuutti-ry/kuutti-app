import {
  ErrorResponse,
  Photo,
  PhotoList,
  PhotoUrlResponse,
  type PhotoVariant,
  TipKind,
} from "@kuutti/schema";
import { Platform } from "react-native";
import { ApiError, api, apiBaseUrl } from "@/lib/api";
import { accessTokenIsStale, currentSession, refreshSession } from "@/lib/session";
import type { PickedPhoto } from "./pick";

// The photo routes as the app calls them (#48). Reads and small writes go
// through the typed client; the upload is an XMLHttpRequest, the one transport
// on React Native that reports upload progress and streams a file from disk
// without loading it into JavaScript.

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/**
 * The list as the API sent it, less any tip kind this build has no words
 * for: a newer API's tip never locks an older app out of its own photos.
 */
export function readPhotoList(data: unknown): PhotoList {
  const tips = (data as { tips?: unknown } | null)?.tips;
  if (!Array.isArray(tips)) return PhotoList.parse(data);
  return PhotoList.parse({
    ...(data as object),
    tips: tips.filter((kind) => TipKind.safeParse(kind).success),
  });
}

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
  return Photo.parse(data);
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

/** The multipart body: on the phone a file reference the runtime streams; on the web preview the blob itself. */
async function formFor(photo: PickedPhoto): Promise<FormData> {
  const form = new FormData();
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
  token: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBaseUrl()}/photos`);
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

/**
 * Uploads a prepared picture with this device's session (#35): the access
 * token is refreshed ahead of its expiry, and one 401 is answered by one
 * refresh and one retry, as the typed client does for every other request.
 */
export async function uploadPhoto(
  photo: PickedPhoto,
  onProgress?: (fraction: number) => void,
): Promise<Photo> {
  let session = currentSession();
  if (session && accessTokenIsStale(session)) session = await refreshSession();
  if (!session) throw new ApiError("no session", 401, "unauthenticated");
  const form = await formFor(photo);
  let sent = await send(session.accessToken, form, onProgress);
  if (sent.status === 401) {
    const next = await refreshSession();
    if (!next) throw new ApiError("signed out", 401, "session_revoked");
    sent = await send(next.accessToken, await formFor(photo), onProgress);
  }
  let parsed: unknown = null;
  try {
    parsed = sent.body ? JSON.parse(sent.body) : null;
  } catch {
    parsed = null;
  }
  if (sent.status === 201) return Photo.parse(parsed);
  const envelope = ErrorResponse.safeParse(parsed);
  throw new ApiError(
    `photo upload answered ${sent.status}`,
    sent.status,
    envelope.success ? envelope.data.error.code : undefined,
  );
}
