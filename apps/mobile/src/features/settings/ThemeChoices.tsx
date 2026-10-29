import { View } from "react-native";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/locale";
import { useTheme } from "@/theme/ThemeProvider";
import { Choice, SCHEMES } from "./Choice";

/** The theme, the OS's by default and kept across restarts, and high contrast with it (#143, #287), in its Settings row (#511). */
export function ThemeChoices() {
  const { t } = useT();
  const theme = useTheme();
  return (
    <>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("settings.theme.label")}
        className="flex-row flex-wrap gap-2"
      >
        {SCHEMES.map(({ value, label }) => (
          <Choice
            key={value}
            label={t(label)}
            chosen={theme.preference === value}
            onPress={() => theme.setPreference(value)}
          />
        ))}
      </View>
      <View className="flex-row items-center justify-between gap-4">
        <Label
          nativeID="high-contrast-label"
          onPress={() => theme.setHighContrast(!theme.highContrast)}
        >
          {t("settings.highContrast")}
        </Label>
        <Switch
          accessibilityLabel={t("settings.highContrast")}
          checked={theme.highContrast}
          onCheckedChange={theme.setHighContrast}
        />
      </View>
    </>
  );
}
