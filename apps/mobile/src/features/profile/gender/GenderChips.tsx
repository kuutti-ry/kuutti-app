import { GENDERS, type Gender, PROFILE_FIELDS, type ProfileFields } from "@kuutti/schema";
import { View } from "react-native";
import { Choice } from "@/components/Choice";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { genderKey, optionKey } from "../keys";

/** The three genders as whole-width rows (#581): the gender step's and the gender screen's (#146, #552). */
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
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t("profile.gender.title")}
      className="gap-2"
    >
      {GENDERS.map((option) => (
        <Choice
          key={option}
          label={t(genderKey(option))}
          chosen={chosen === option}
          onPress={() => {
            tap();
            onChoose(option);
          }}
        />
      ))}
    </View>
  );
}

/** The identity label as whole-width rows (#581), where a second press takes it back (#146, #552). */
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
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t("onboarding.identityLabel.title")}
      className="gap-2"
    >
      {PROFILE_FIELDS.identityLabel.options.map((option) => (
        <Choice
          key={option}
          label={t(optionKey("identityLabel", option))}
          chosen={chosen === option}
          onPress={() => {
            tap();
            onChange(chosen === option ? undefined : option);
          }}
        />
      ))}
    </View>
  );
}
