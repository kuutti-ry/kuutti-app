import type { ChatMessage } from "@kuutti/schema";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { usePhotoDescriptionText } from "@/lib/photo-descriptions";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { useMotionDuration } from "@/theme/useReducedMotion";
import { bubbleColours, MessageFrame } from "./Bubble";
import { timeOf } from "./time";

/** The thumb's edge in points: the API's thumb is a square (rules/api.md Media). */
const THUMB_EDGE = 200;
const SQUARE = { width: THUMB_EDGE, height: THUMB_EDGE };

/**
 * A photo in a conversation (#350): the thumb, square, the blurhash painting
 * first, cached under `photoId/thumb` and never under the signed URL
 * (rules/mobile.md Images), the caption under it. One button for a screen
 * reader, read as who, when and the caption, else "Photo", then what the check
 * saw (#296), as every photo's label says it; a tap opens it full size. A
 * photo the socket brought has no URLs yet: the blurhash shows while the
 * screen reads the message again, as it does for a URL that has expired
 * (`onExpired`). A photo that went with its sender is "Photo removed", with
 * the caption if it had one, and opens nothing.
 */
export function PhotoBubble({
  message,
  conversationId,
  who,
  note,
  onExpired,
}: {
  message: ChatMessage;
  conversationId: string;
  who: string;
  note: string | null;
  onExpired: (message: ChatMessage) => void;
}) {
  const { t, locale } = useT();
  const described = usePhotoDescriptionText();
  const router = useRouter();
  const tap = useHapticTap();
  const transition = useMotionDuration(200);
  const mine = message.side === "mine";
  const colours = bubbleColours(mine);
  const time = timeOf(locale, message.createdAt);
  const caption = message.body;
  const { photo } = message;

  if (!photo) {
    return (
      <MessageFrame mine={mine} at={message.createdAt} note={note}>
        <View
          accessible
          accessibilityLabel={t("chat.message.label", {
            who,
            time,
            text: caption ? t("chat.photo.removedCaption", { caption }) : t("chat.photo.removed"),
          })}
          className={cn("gap-1 rounded-2xl px-3 py-2", colours.box)}
        >
          <Text className={cn("italic", colours.text)}>{t("chat.photo.removed")}</Text>
          {caption ? <Text className={colours.text}>{caption}</Text> : null}
        </View>
      </MessageFrame>
    );
  }

  const label = described.label(
    t("chat.message.label", { who, time, text: caption || t("chat.photo.photo") }),
    photo.description,
  );
  return (
    <MessageFrame mine={mine} at={message.createdAt} note={note}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t("chat.photo.open")}
        className={cn("overflow-hidden rounded-2xl active:opacity-80", colours.box)}
        style={{ width: THUMB_EDGE, minHeight: THUMB_EDGE }}
        onPress={() => {
          tap();
          router.push({
            pathname: "/chats/photo/[messageId]",
            params: {
              messageId: message.id,
              conversation: conversationId,
              seq: String(message.seq),
              blurhash: photo.blurhash,
            },
          });
        }}
      >
        <Image
          testID={`photo-${message.id}`}
          source={photo.urls ? { uri: photo.urls.thumb, cacheKey: `${photo.photoId}/thumb` } : null}
          placeholder={{ blurhash: photo.blurhash }}
          placeholderContentFit="cover"
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={photo.photoId}
          transition={transition}
          onError={() => onExpired(message)}
          style={SQUARE}
          {...DECORATIVE}
        />
        {caption ? <Text className={cn("px-3 py-2", colours.text)}>{caption}</Text> : null}
      </Pressable>
    </MessageFrame>
  );
}

/**
 * A photo on its way (#350): the picture from the phone, the caption under it,
 * and how far the upload is, said politely as it goes; swapped for the
 * message by its client id when the answer or the socket brings it.
 */
export function SendingPhotoBubble({
  who,
  uri,
  caption,
  at,
  percent,
}: {
  who: string;
  uri: string;
  caption: string;
  at: string;
  percent: number;
}) {
  const { t, locale } = useT();
  const colours = bubbleColours(true);
  return (
    <MessageFrame mine at={at} note={t("chat.photo.uploading", { percent })} live>
      <View
        accessible
        accessibilityLabel={t("chat.message.label", {
          who,
          time: timeOf(locale, at),
          text: caption || t("chat.photo.photo"),
        })}
        className={cn("overflow-hidden rounded-2xl", colours.box)}
        style={{ width: THUMB_EDGE }}
      >
        <Image
          testID="photo-sending"
          source={{ uri }}
          contentFit="cover"
          style={SQUARE}
          {...DECORATIVE}
        />
        {caption ? <Text className={cn("px-3 py-2", colours.text)}>{caption}</Text> : null}
      </View>
    </MessageFrame>
  );
}
