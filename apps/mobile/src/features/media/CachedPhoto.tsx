import type { PhotoVariant } from "@kuutti/schema";
import { Image, type ImageRef, type ImageStyle } from "expo-image";
import { useEffect, useState } from "react";
import type { StyleProp } from "react-native";
import { DECORATIVE } from "@/theme/a11y";

/**
 * A photo the screen has already painted, again, from the phone's image cache
 * alone (#476): read under the key `PhotoImage` cached it by, `photoId/variant`
 * (rules/mobile.md Images), so no URL is signed and nothing counts as exposure
 * (ADR-008). Where the cache has none (a URL the day's budget refused, an
 * entry the phone let go, the web preview, whose module answers none) the
 * blurhash stands in. Decorative: the control it sits in says which photo it is.
 */
export function CachedPhoto({
  id,
  variant,
  blurhash,
  style,
}: {
  id: string;
  /** The variant the screen painted it in, so the cache has it. */
  variant: PhotoVariant;
  blurhash: string;
  style?: StyleProp<ImageStyle>;
}) {
  const cacheKey = `${id}/${variant}`;
  // What the cache answered, for the key it was asked: another key's picture is never shown.
  const [cached, setCached] = useState<{ key: string; ref: ImageRef | null } | null>(null);
  useEffect(() => {
    // A read for a key this photo no longer has lands on nothing.
    let current = true;
    Image.readFromCacheAsync(cacheKey).then(
      (ref) => {
        if (current) setCached({ key: cacheKey, ref });
      },
      // A failed read is a miss, as a photo the cache never had: the blurhash stays.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [cacheKey]);
  return (
    <Image
      testID={`cached-${id}`}
      source={cached?.key === cacheKey ? cached.ref : null}
      placeholder={{ blurhash }}
      placeholderContentFit="cover"
      contentFit="cover"
      style={style}
      {...DECORATIVE}
    />
  );
}
