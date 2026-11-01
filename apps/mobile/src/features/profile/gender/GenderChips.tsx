import { GENDERS, type Gender, PROFILE_FIELDS, type ProfileFields } from "@kuutti/schema";
import { View } from "react-native";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { Chip } from "../FieldEditor";
import { genderKey, optionKey } from "../keys";

/** The three genders as chips: the gender step's and the gender screen's (#146, #552). */
export function GenderChips({
  chosen,
  onChoose,
}: {
  chosen: Gender | null;
  onChoose: (gender: Gender) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  return (
    <View className="flex-row flex-wrap gap-2">
      {GENDERS.map((option) => (
        <Chip
          key={option}
          label={t(genderKey(option))}
          selected={chosen === option}
          onPress={() => {
            tap();
            onChoose(option);
          }}
        />
      ))}
    </View>
  );
}

/** The identity label as chips, where a second press takes it back (#146, #552). */
export function IdentityLabelChips({
  chosen,
  onChange,
}: {
  chosen: ProfileFields["identityLabel"];
  onChange: (label: ProfileFields["identityLabel"]) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  return (
    <View className="flex-row flex-wrap gap-2">
      {PROFILE_FIELDS.identityLabel.options.map((option) => (
        <Chip
          key={option}
          label={t(optionKey("identityLabel", option))}
          selected={chosen === option}
          onPress={() => {
            tap();
            onChange(chosen === option ? undefined : option);
          }}
        />
      ))}
    </View>
  );
}
