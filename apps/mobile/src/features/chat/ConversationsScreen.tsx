import type { ConversationSummary } from "@kuutti/schema";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { DECORATIVE, TOUCH_TARGET } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { ConnectionLine } from "./ConnectionLine";
import { whenOf } from "./time";
import { UnreadBadge } from "./UnreadBadge";
import { useConversations } from "./useConversations";

type T = ReturnType<typeof useT>["t"];

/** A row is at least the touch target, whatever its text (CLAUDE.md Accessibility). */
const ROW_TARGET = { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET };

/** Who the counterpart is, as a row and the conversation's header say it. */
export function counterpartName(t: T, conversation: ConversationSummary): string {
  const { counterpart } = conversation;
  return counterpart.deleted
    ? t("chat.deletedUser")
    : t("profile.card.nameAge", { name: counterpart.name, years: counterpart.age });
}

/** The line under the name: how a closed one ended, else the last message, else that there is none. */
function lineOf(t: T, conversation: ConversationSummary): string {
  if (conversation.state === "closed") {
    return conversation.closedHow === "erasure" ? t("chat.state.deleted") : t("chat.state.ended");
  }
  const last = conversation.lastMessage;
  if (!last) return t("chat.row.noMessages");
  return last.side === "mine" ? t("chat.row.mine", { preview: last.preview }) : last.preview;
}

function Row({ conversation }: { conversation: ConversationSummary }) {
  const { t, locale } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const name = counterpartName(t, conversation);
  const line = lineOf(t, conversation);
  const when = conversation.lastMessage ? whenOf(locale, conversation.lastMessage.at) : null;
  const thumb = conversation.counterpart.deleted ? null : conversation.counterpart.thumb;
  // One element for a screen reader: who, what is unread, the last line and when.
  const label = [
    name,
    conversation.unread > 0 ? t("chat.row.unread", { unread: conversation.unread }) : null,
    line,
    when,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center gap-3 rounded-lg px-2 py-2 active:bg-accent"
      style={ROW_TARGET}
      onPress={() => {
        tap();
        router.push(`/chats/${conversation.id}`);
      }}
    >
      {thumb ? (
        <Image
          testID={`thumb-${conversation.id}`}
          source={{ uri: thumb.url, cacheKey: `${thumb.photoId}/thumb` }}
          placeholder={{ blurhash: thumb.blurhash }}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={{ width: 48, height: 48, borderRadius: 24 }}
          {...DECORATIVE}
        />
      ) : (
        <View className="h-12 w-12 rounded-full bg-muted" {...DECORATIVE} />
      )}
      <View className="flex-1 gap-0.5">
        <Text className="font-semibold">{name}</Text>
        <Text variant="muted" numberOfLines={2}>
          {line}
        </Text>
      </View>
      <View className="items-end gap-1">
        {when && <Text variant="muted">{when}</Text>}
        {conversation.unread > 0 && <UnreadBadge unread={conversation.unread} />}
      </View>
    </Pressable>
  );
}

/**
 * The list of conversations (#348): the open ones, then the archived and the
 * closed ones under a heading of their own, each newest first, as the API
 * orders them. Read again on focus, by pulling down, and when the socket
 * brings something new (#349), with a line at the top while it is lost. A
 * row opens the conversation.
 */
export function ConversationsScreen() {
  const { t } = useT();
  const router = useRouter();
  const view = useConversations();
  const [refreshing, setRefreshing] = useState(false);

  const pull = async () => {
    setRefreshing(true);
    await view.refresh();
    setRefreshing(false);
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("chat.list.title")}
        backLabel={t("chat.back")}
        onBack={() => router.back()}
      />
      <ConnectionLine />
      <ScrollView
        testID="conversations"
        contentContainerClassName="gap-4 p-6"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void pull()} />}
      >
        {view.status === "loading" && (
          <Text accessibilityLiveRegion="polite">{t("chat.list.loading")}</Text>
        )}
        {view.status === "failed" && (
          <LoadFailed headline={t("chat.list.failed")} error={view.error} onRetry={view.retry} />
        )}
        {view.status === "ready" &&
          view.list.open.length === 0 &&
          view.list.archived.length === 0 && <Text>{t("chat.list.empty")}</Text>}
        {view.status === "ready" && view.list.open.length > 0 && (
          <View className="gap-1">
            <Text variant="h4" accessibilityRole="header">
              {t("chat.list.open")}
            </Text>
            {view.list.open.map((conversation) => (
              <Row key={conversation.id} conversation={conversation} />
            ))}
          </View>
        )}
        {view.status === "ready" && view.list.archived.length > 0 && (
          <View className="gap-1">
            <Text variant="h4" accessibilityRole="header">
              {t("chat.list.archived")}
            </Text>
            <Text variant="muted">{t("chat.list.archivedHint")}</Text>
            {view.list.archived.map((conversation) => (
              <Row key={conversation.id} conversation={conversation} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
