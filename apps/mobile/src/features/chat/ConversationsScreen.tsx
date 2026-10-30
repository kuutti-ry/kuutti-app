import type { ConversationSummary } from "@kuutti/schema";
import { Image } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SupportLink } from "@/components/SupportLink";
import { Text } from "@/components/ui/text";
import type { SafetyOutcome } from "@/features/safety";
import { useT } from "@/lib/locale";
import { DECORATIVE, TOUCH_TARGET } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { ConnectionLine } from "./ConnectionLine";
import { NOTICES, takeNotice } from "./notice";
import { whenOf } from "./time";
import { UnreadBadge } from "./UnreadBadge";
import { useConversations } from "./useConversations";

type T = ReturnType<typeof useT>["t"];

/** A row is at least the touch target, whatever its text (CLAUDE.md Accessibility). */
const ROW_TARGET = { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET };

/**
 * Who the counterpart is, as a row and the conversation's header say it; an
 * ended conversation names nobody (#351, ADR-031 Open 10) and says that it ended.
 */
export function counterpartName(t: T, conversation: ConversationSummary): string {
  const { counterpart } = conversation;
  if (!counterpart) return t("chat.closed.title");
  return counterpart.deleted
    ? t("chat.deletedUser")
    : t("profile.card.nameAge", { name: counterpart.name, years: counterpart.age });
}

/**
 * The line under the name: that the other deleted their account, else the
 * last message (a photo's caption, or "Photo" without one, #350), else that
 * there is none. An ended conversation's name says it ended, so its line is
 * its last message, which tells it from another.
 */
function lineOf(t: T, conversation: ConversationSummary): string {
  if (conversation.state === "closed" && conversation.closedHow === "erasure") {
    return t("chat.state.deleted");
  }
  const last = conversation.lastMessage;
  if (!last) return t("chat.row.noMessages");
  const preview = last.kind === "photo" && last.preview === "" ? t("chat.row.photo") : last.preview;
  return last.side === "mine" ? t("chat.row.mine", { preview }) : preview;
}

function Row({ conversation }: { conversation: ConversationSummary }) {
  const { t, locale } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const name = counterpartName(t, conversation);
  const line = lineOf(t, conversation);
  const when = conversation.lastMessage ? whenOf(locale, conversation.lastMessage.at) : null;
  const { counterpart } = conversation;
  const thumb = counterpart && !counterpart.deleted ? counterpart.thumb : null;
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
        // The edge keeps the circle in the high-contrast sets, whose --muted is
        // the background itself (#467).
        <View
          testID={`thumb-${conversation.id}`}
          className="h-12 w-12 rounded-full border border-border bg-muted"
          {...DECORATIVE}
        />
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
 * row opens the conversation. Back from a report, a block or an end in a
 * conversation (#351), the top says what happened, once, to a screen reader
 * too, with the way to the support page (#510).
 */
export function ConversationsScreen() {
  const { t } = useT();
  const router = useRouter();
  const view = useConversations();
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<SafetyOutcome | null>(null);

  useFocusEffect(
    useCallback(() => {
      const left = takeNotice();
      setNotice(left);
      // Android's live region speaks it; iOS has none.
      if (left && Platform.OS === "ios")
        AccessibilityInfo.announceForAccessibility(t(NOTICES[left]));
    }, [t]),
  );

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
        {notice && (
          <View className="gap-1">
            <Text testID="notice" accessibilityLiveRegion="polite">
              {t(NOTICES[notice])}
            </Text>
            {/* Not for a conversation that was gone already: nothing went through. */}
            {notice !== "gone" && <SupportLink />}
          </View>
        )}
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
