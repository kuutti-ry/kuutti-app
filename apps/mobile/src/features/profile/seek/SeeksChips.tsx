import { GENDERS, type Gender } from "@kuutti/schema";
import { View } from "react-native";
import { Choice } from "@/components/Choice";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { seeksKey } from "../keys";

/** Whom one seeks as whole-width rows (#581), with Anyone for all three: the seeks step's and What you seek's (#146, #542). */
export function SeeksChips({
  chosen,
  onChange,
}: {
  chosen: readonly Gender[];
  onChange: (next: Gender[]) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  return (
    <View className="gap-2">
      {GENDERS.map((option) => (
        <Choice
          key={option}
          label={t(seeksKey(option))}
          chosen={chosen.includes(option)}
          several
          onPress={() => {
            tap();
            onChange(
              chosen.includes(option) ? chosen.filter((g) => g !== option) : [...chosen, option],
            );
          }}
        />
      ))}
      <Choice
        label={t("onboarding.seeks.anyone")}
        chosen={chosen.length === GENDERS.length}
        several
        onPress={() => {
          tap();
          onChange([...GENDERS]);
        }}
      />
    </View>
  );
}
