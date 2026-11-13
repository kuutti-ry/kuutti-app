import type { PhotoVariant } from "@kuutti/schema";
import { Image, type ImageContentFit, type ImageStyle } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StyleProp } from "react-native";
import { ApiError } from "@/lib/api";
import { useMotionDuration } from "@/theme/useReducedMotion";
import { fetchPhotoUrl } from "./client";

/**
 * A signed URL for one variant, fetched when the image mounts and once more if
 * the image fails to load (a URL past its fifteen minutes on a cache miss).
 * The blurhash paints meanwhile.
 */
function useSignedUrl(id: string, variant: PhotoVariant, onRefused?: OnRefused) {
  const key = `${id}/${variant}`;
  const [signed, setSigned] = useState<{ key: string; url: string } | null>(null);
  const attempt = useRef(0);
  const retried = useRef(false);
  // A ref, so a parent's inline handler does not restart the fetch on every render.
  const refused = useRef(onRefused);
  refused.current = onRefused;
  const load = useCallback(async () => {
    const read = ++attempt.current;
    try {
      const { url } = await fetchPhotoUrl(id, variant);
      if (read === attempt.current) setSigned({ key, url });
    } catch (error) {
      if (read !== attempt.current) return;
      setSigned(null); // the placeholder stays; the screen tells the person through onRefused
      if (error instanceof ApiError) refused.current?.(error.code);
    }
  }, [id, variant, key]);
  useEffect(() => {
    retried.current = false;
    void load();
    return () => {
      attempt.current += 1;
    };
  }, [load]);
  const retry = useCallback(() => {
    if (retried.current) return;
    retried.current = true;
    void load();
  }, [load]);
  return { url: signed?.key === key ? signed.url : null, retry };
}

/** The API's code when it refused the URL (#52: photo_budget_exceeded above the day's budget), or undefined for a failure without one. */
export type OnRefused = (code: string | undefined) => void;

/** The words for a photo the API would not sign: the day's photos are used up, or it is not shown. */
export function photoRefusalKey(
  code: string | null | undefined,
): "photos.error.photo_budget_exceeded" | "photos.error.notShown" {
  return code === "photo_budget_exceeded"
    ? "photos.error.photo_budget_exceeded"
    : "photos.error.notShown";
}

type Props = {
  id: string;
  variant: PhotoVariant;
  blurhash: string;
  onRefused?: OnRefused;
  /** What a screen reader says for the picture; from i18n. */
  accessibilityLabel: string;
  contentFit?: ImageContentFit;
  style?: StyleProp<ImageStyle>;
};

/**
 * One photo (rules/mobile.md Images): rendered with expo-image, cached under
 * photoId/variant and never under the signed URL, the blurhash as the
 * placeholder. Which variant is the caller's decision: thumb in the grid, full
 * on the zoom screen only.
 */
export function PhotoImage({
  id,
  variant,
  blurhash,
  accessibilityLabel,
  contentFit = "cover",
  style,
  onRefused,
}: Props) {
  const { url, retry } = useSignedUrl(id, variant, onRefused);
  const transition = useMotionDuration(200);
  return (
    <Image
      source={url ? { uri: url, cacheKey: `${id}/${variant}` } : null}
      placeholder={{ blurhash }}
      placeholderContentFit={contentFit}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      recyclingKey={id}
      transition={transition}
      onError={retry}
      style={style}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    />
  );
}
