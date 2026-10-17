import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { DECORATIVE } from "@/theme/a11y";

/**
 * The unread mark (#348): a filled pill with the count in words, a shape and
 * a text, never colour alone. Hidden from screen readers: the control it sits
 * in says the count in its own label.
 */
export function UnreadBadge({ unread }: { unread: number }) {
  const { t } = useT();
  return (
    <View className="rounded-full bg-primary px-2 py-0.5" {...DECORATIVE}>
      <Text className="text-sm font-semibold text-primary-foreground">
        {t("chat.unread.badge", { unread })}
      </Text>
    </View>
  );
}
