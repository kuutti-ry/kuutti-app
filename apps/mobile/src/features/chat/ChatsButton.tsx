import { useRouter } from "expo-router";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { UnreadBadge } from "./UnreadBadge";
import { unreadOf, useConversations } from "./useConversations";

/**
 * The home screen's way to the conversations (#348), with the unread count:
 * the mark beside the word, and the count in words for a screen reader. It
 * asks for the list without thumbs, so a look at home signs no photo.
 */
export function ChatsButton() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const view = useConversations(false);
  const unread = view.status === "ready" ? unreadOf(view.list) : 0;
  return (
    <Button
      variant="outline"
      accessibilityLabel={t("home.chats.label", { unread })}
      onPress={() => {
        tap();
        router.push("/chats");
      }}
    >
      <View className="flex-row items-center gap-2">
        <Text>{t("home.chats.open")}</Text>
        {unread > 0 && <UnreadBadge unread={unread} />}
      </View>
    </Button>
  );
}
