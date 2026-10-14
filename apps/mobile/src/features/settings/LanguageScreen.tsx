import { LOCALE_NAMES } from "@kuutti/i18n";
import { View } from "react-native";
import {
  LOCALE_FLAGS,
  type LocalePreference,
  OFFERED_LOCALES,
  useLocaleSettings,
  useT,
} from "@/lib/locale";
import { Choice } from "./Choice";
import { SettingsPage } from "./SettingsPage";

/** The language: the phone's by default, or one of the offered ones, stored (#143, #287). */
export function LanguageScreen() {
  const { t } = useT();
  const locale = useLocaleSettings();
  const languages: ReadonlyArray<{ value: LocalePreference; label: string; flag?: string }> = [
    { value: "system", label: t("settings.language.system") },
    // A language is listed under its own name, whatever the app's language is.
    ...OFFERED_LOCALES.map((value) => ({
      value,
      label: LOCALE_NAMES[value],
      flag: LOCALE_FLAGS[value],
    })),
  ];
  return (
    <SettingsPage title={t("settings.language.label")}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("settings.language.label")}
        className="flex-row flex-wrap gap-2"
      >
        {languages.map(({ value, label, flag }) => (
          <Choice
            key={value}
            label={label}
            flag={flag}
            chosen={locale.preference === value}
            onPress={() => locale.setPreference(value)}
          />
        ))}
      </View>
    </SettingsPage>
  );
}
