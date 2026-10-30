import { useRouter } from "expo-router";
import HeartHandshake from "lucide-react-native/icons/heart-handshake";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";

/**
 * The way to the support page (#510) where somebody may be left low: after a
 * report or a block, and in an ended conversation. An offer in the page's own
 * words, saying nothing about the person or what happened. It stands here
 * because the slices that show it lie either side of Settings, which already
 * imports from them. `onLeave` runs first, for a dialog to close.
 */
export function SupportLink({ onLeave }: { onLeave?: () => void }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const label = t("settings.support.label");
  return (
    <Button
      variant="ghost"
      accessibilityRole="link"
      accessibilityLabel={label}
      className="self-start px-0"
      onPress={() => {
        tap();
        onLeave?.();
        router.push("/settings/support");
      }}
    >
      <Icon as={HeartHandshake} className="text-primary" size={16} />
      <Text className="shrink text-primary underline">{label}</Text>
    </Button>
  );
}
