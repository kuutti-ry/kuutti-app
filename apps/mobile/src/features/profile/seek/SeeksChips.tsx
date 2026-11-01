import { GENDERS, type Gender } from "@kuutti/schema";
import { View } from "react-native";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { Chip } from "../FieldEditor";
import { seeksKey } from "../keys";

/** Whom one seeks as chips, with Anyone for all three: the seeks step's and What you seek's (#146, #542). */
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
    <View className="flex-row flex-wrap gap-2">
      {GENDERS.map((option) => (
        <Chip
          key={option}
          label={t(seeksKey(option))}
          selected={chosen.includes(option)}
          onPress={() => {
            tap();
            onChange(
              chosen.includes(option) ? chosen.filter((g) => g !== option) : [...chosen, option],
            );
          }}
        />
      ))}
      <Chip
        label={t("onboarding.seeks.anyone")}
        selected={chosen.length === GENDERS.length}
        onPress={() => {
          tap();
          onChange([...GENDERS]);
        }}
      />
    </View>
  );
}
