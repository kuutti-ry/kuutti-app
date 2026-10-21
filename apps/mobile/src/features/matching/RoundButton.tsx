import { useRouter } from "expo-router";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";

/**
 * The way to today's round (#379), on the home screen's gate card once
 * matching is open for the person (#94). Its word only: no count, no time.
 */
export function RoundButton() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  return (
    <Button
      onPress={() => {
        tap();
        router.push("/round");
      }}
    >
      {t("round.home.open")}
    </Button>
  );
}
