import type { Photo, PhotoCaption, PhotoList } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  appealPhoto,
  deletePhoto,
  listPhotos,
  reorderPhotos,
  setPhotoCaption,
  uploadPhoto,
} from "./client";
import { placed } from "./drag";
import { pickPrepared } from "./pick";

type PhotosBusy =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "preparing" }
  | { kind: "uploading"; percent: number }
  | { kind: "removing"; id: string }
  | { kind: "appealing"; id: string }
  | { kind: "captioning"; id: string }
  | { kind: "reordering" };

/** What the screen tells the person after something did not go as asked; one at a time. */
export type PhotosNotice =
  | { kind: "refused_local" }
  | { kind: "permission" }
  // The caption did not save (#296): its own words, since the generic ones speak of an upload.
  | { kind: "caption_failed" }
  | { kind: "error"; code: string | undefined };

export type PhotosState = {
  status: "loading" | "ready" | "error";
  list: PhotoList | null;
  busy: PhotosBusy;
  notice: PhotosNotice | null;
};

/**
 * The person's photos and everything they can do to them (#48). Adding a photo
 * is a chain on the phone before anything is sent: pick, the on-device check,
 * the pre-resize; a refusal by the check stops it with no request made. Order
 * changes are optimistic and reloaded from the API when refused.
 */
export function usePhotos() {
  const [state, setState] = useState<PhotosState>({
    status: "loading",
    list: null,
    busy: { kind: "idle" },
    notice: null,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = useCallback((patch: Partial<PhotosState>) => {
    if (mounted.current) setState((previous) => ({ ...previous, ...patch }));
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await listPhotos();
      update({ status: "ready", list });
    } catch (error) {
      update({ status: "error", notice: { kind: "error", code: codeOf(error) } });
    }
  }, [update]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Changes made to the list so far: an upload, a removal, an appeal or a
   * caption once the API took it, a reorder as it starts (its list changes
   * at once). A read after a change applies its answer only when no later
   * change has been made since, so a slow answer never puts back an order or
   * a photo the person has just moved or removed. A change that ends without
   * touching the list (a cancelled picker, a refused removal) leaves the read
   * in flight to apply, or its tips would outlive their photo (#287).
   */
  const changes = useRef(0);

  /**
   * The list again after a change, for the tips that ride on it (#287): what
   * the check decided, a photo gone or one in review changes them. A read
   * that fails keeps the list as it is; the change itself went through.
   */
  const refresh = useCallback(() => {
    const seen = changes.current;
    return listPhotos().then(
      (list) => {
        if (changes.current === seen) update({ list });
      },
      () => undefined,
    );
  }, [update]);

  const add = useCallback(async () => {
    update({ busy: { kind: "picking" }, notice: null });
    try {
      const picked = await pickPrepared(() => update({ busy: { kind: "preparing" } }));
      if (picked.kind === "cancelled") return update({ busy: { kind: "idle" } });
      if (picked.kind === "denied") {
        return update({ busy: { kind: "idle" }, notice: { kind: "permission" } });
      }
      if (picked.kind === "refused_local") {
        return update({ busy: { kind: "idle" }, notice: { kind: "refused_local" } });
      }
      update({ busy: { kind: "uploading", percent: 0 } });
      const photo = await uploadPhoto(picked.photo, (fraction) =>
        update({ busy: { kind: "uploading", percent: Math.round(fraction * 100) } }),
      );
      changes.current += 1;
      setState((previous) => ({
        ...previous,
        busy: { kind: "idle" },
        list: previous.list
          ? { ...previous.list, photos: [...previous.list.photos, photo] }
          : previous.list,
      }));
    } catch (error) {
      return update({ busy: { kind: "idle" }, notice: { kind: "error", code: codeOf(error) } });
    }
    await refresh();
  }, [update, refresh]);

  const remove = useCallback(
    async (id: string) => {
      update({ busy: { kind: "removing", id }, notice: null });
      try {
        await deletePhoto(id);
        changes.current += 1;
        setState((previous) => ({
          ...previous,
          busy: { kind: "idle" },
          list: previous.list
            ? renumber(
                previous.list,
                previous.list.photos.filter((p) => p.id !== id),
              )
            : null,
        }));
      } catch (error) {
        return update({ busy: { kind: "idle" }, notice: { kind: "error", code: codeOf(error) } });
      }
      await refresh();
    },
    [update, refresh],
  );

  // The check's rejection to a person (#253): the photo comes back queued, in its place.
  const appeal = useCallback(
    async (id: string) => {
      update({ busy: { kind: "appealing", id }, notice: null });
      try {
        const photo = await appealPhoto(id);
        changes.current += 1;
        setState((previous) => ({
          ...previous,
          busy: { kind: "idle" },
          list: withPhoto(previous.list, photo),
        }));
      } catch (error) {
        return update({ busy: { kind: "idle" }, notice: { kind: "error", code: codeOf(error) } });
      }
      await refresh();
    },
    [update, refresh],
  );

  /** The owner's line under a photo (#296), or none: the photo comes back with it, in its place. */
  const caption = useCallback(
    async (id: string, line: PhotoCaption | null) => {
      update({ busy: { kind: "captioning", id }, notice: null });
      try {
        const photo = await setPhotoCaption(id, line);
        changes.current += 1;
        setState((previous) => ({
          ...previous,
          busy: { kind: "idle" },
          list: withPhoto(previous.list, photo),
        }));
      } catch {
        update({ busy: { kind: "idle" }, notice: { kind: "caption_failed" } });
      }
    },
    [update],
  );

  const reorder = useCallback(
    async (photos: Photo[]) => {
      const before = state.list;
      if (!before) return;
      changes.current += 1;
      update({ busy: { kind: "reordering" }, notice: null, list: renumber(before, photos) });
      try {
        const list = await reorderPhotos(photos.map((p) => p.id));
        update({ busy: { kind: "idle" }, list });
      } catch (error) {
        update({ busy: { kind: "idle" }, notice: { kind: "error", code: codeOf(error) } });
        await reload();
      }
    },
    [state.list, update, reload],
  );

  /**
   * The photo at `from` placed at `to` (#179: a drop, or one of the tile's
   * accessibility actions through move and makeMain); nothing for a position
   * past either end, a photo that is not there, or the place it is in.
   */
  const moveTo = useCallback(
    (from: number, to: number) => {
      const photos = state.list?.photos ?? [];
      if (from === to || !photos[from] || to < 0 || to >= photos.length) return Promise.resolve();
      return reorder(placed(photos, from, to));
    },
    [state.list, reorder],
  );

  /** One step towards the front (-1) or the back (+1). */
  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const from = (state.list?.photos ?? []).findIndex((p) => p.id === id);
      return moveTo(from, from + delta);
    },
    [state.list, moveTo],
  );

  const makeMain = useCallback(
    (id: string) => {
      const from = (state.list?.photos ?? []).findIndex((p) => p.id === id);
      return moveTo(from, 0);
    },
    [state.list, moveTo],
  );

  const dismissNotice = useCallback(() => update({ notice: null }), [update]);

  /** A photo URL the API refused (#52): the grid tells the person instead of showing a silent gap. */
  const reportRefusal = useCallback(
    (code: string | undefined) => update({ notice: { kind: "error", code } }),
    [update],
  );

  return {
    ...state,
    reload,
    add,
    remove,
    appeal,
    caption,
    moveTo,
    move,
    makeMain,
    dismissNotice,
    reportRefusal,
  };
}

/** The list with one photo as the API now answers it, in its place. */
function withPhoto(list: PhotoList | null, photo: Photo): PhotoList | null {
  return list ? { ...list, photos: list.photos.map((p) => (p.id === photo.id ? photo : p)) } : null;
}

function renumber(list: PhotoList, photos: Photo[]): PhotoList {
  return { ...list, photos: photos.map((photo, position) => ({ ...photo, position })) };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}
