import type { ChatPhoto } from "@kuutti/schema";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { PhotoDescriptionText } from "@/features/media";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { usePhotoDescriptionText } from "@/lib/photo-descriptions";
import { DECORATIVE } from "@/theme/a11y";
import { useMotionDuration } from "@/theme/useReducedMotion";
import { fetchMessages } from "./client";

/** What the photo bubble passes in the link: the message, its conversation, its place there, its placeholder. */
export type ChatPhotoParams = {
  messageId: string;
  conversation: string;
  /** The message's sequence; 0 when the link had none. */
  seq: number;
  blurhash: string;
};

type PhotoView =
  | { status: "loading" }
  | {
      status: "ready";
      photo: ChatPhoto & { urls: NonNullable<ChatPhoto["urls"]> };
      caption: string | null;
    }
  | { status: "gone" }
  | { status: "failed"; error: unknown };

/**
 * A photo of a conversation full size (#350), the chat's own screen: the
 * profile's zoom screen is for one's own photos by id. It reads the one
 * message again, a page of one before the next sequence, so the full size is
 * signed for the reader inside that answer and logged as theirs (ADR-008 §1),
 * and shows it whole, the blurhash first. Read as "Photo, full size", the
 * caption and what the check saw; the description under it when the Photo
 * descriptions setting asks (#296). A photo no longer there, or a link
 * without one, says so; a failure offers Try again. The arrow at the top goes
 * back: no pinch is needed to leave.
 */
export function ChatPhotoScreen({ messageId, conversation, seq, blurhash }: ChatPhotoParams) {
  const { t } = useT();
  const router = useRouter();
  const described = usePhotoDescriptionText();
  const transition = useMotionDuration(200);
  const [view, setView] = useState<PhotoView>({ status: "loading" });
  const retried = useRef(false);

  const load = useCallback(async () => {
    if (!messageId || !conversation || !Number.isInteger(seq) || seq < 1) {
      setView({ status: "gone" });
      return;
    }
    try {
      const [message] = await fetchMessages(conversation, { before: seq + 1, limit: 1 });
      const photo = message?.id === messageId ? message.photo : null;
      setView(
        photo?.urls
          ? {
              status: "ready",
              photo: { ...photo, urls: photo.urls },
              caption: message?.body ?? null,
            }
          : { status: "gone" },
      );
    } catch (error) {
      const gone = error instanceof ApiError && (error.status === 404 || error.status === 400);
      setView(gone ? { status: "gone" } : { status: "failed", error });
    }
  }, [messageId, conversation, seq]);

  useEffect(() => {
    void load();
  }, [load]);

  // An expired URL on a cache miss: read again, once.
  const expired = () => {
    if (retried.current) return;
    retried.current = true;
    void load();
  };

  const placeholder = blurhash ? { blurhash } : undefined;
  const ready = view.status === "ready" ? view : null;
  const words = ready && described.shown ? described.describe(ready.photo.description) : null;
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("chat.photo.photo")}
        backLabel={t("chat.photo.back")}
        onBack={() => router.back()}
      />
      {view.status === "loading" && (
        <>
          <Text accessibilityLiveRegion="polite" className="p-6">
            {t("chat.photo.loading")}
          </Text>
          <Image
            placeholder={placeholder}
            placeholderContentFit="contain"
            contentFit="contain"
            style={{ flex: 1 }}
            {...DECORATIVE}
          />
        </>
      )}
      {view.status === "gone" && (
        <Text accessibilityLiveRegion="polite" className="p-6">
          {t("chat.photo.gone")}
        </Text>
      )}
      {view.status === "failed" && (
        <View className="p-6">
          <LoadFailed
            headline={t("chat.photo.failed")}
            error={view.error}
            onRetry={() => {
              setView({ status: "loading" });
              void load();
            }}
          />
        </View>
      )}
      {ready && (
        <View className="flex-1">
          <Image
            testID="photo-full"
            source={{ uri: ready.photo.urls.full, cacheKey: `${ready.photo.photoId}/full` }}
            placeholder={placeholder}
            placeholderContentFit="contain"
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={ready.photo.photoId}
            transition={transition}
            onError={expired}
            style={{ flex: 1 }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={described.label(
              ready.caption
                ? t("chat.photo.fullCaption", { caption: ready.caption })
                : t("chat.photo.full"),
              ready.photo.description,
            )}
          />
          {words && (
            <View className="px-4 py-3">
              <PhotoDescriptionText text={words} />
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}
