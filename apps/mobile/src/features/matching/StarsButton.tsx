import { useRouter } from "expo-router";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { useStars } from "./useStars";

/**
 * The way to the Starred list (#575, ADR-064 §6), on the home screen beside the way
 * to the queue, only while the list shows somebody. Its word only: no count.
 */
export function StarsButton() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const { view } = useStars();
  if (view.status !== "ready" || view.items.length === 0) return null;
  return (
    <Button
      variant="outline"
      onPress={() => {
        tap();
        router.push("/stars");
      }}
    >
      {t("stars.home.open")}
    </Button>
  );
}
