import { View } from "react-native";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import {
  type PhotoDescriptionSettings,
  usePhotoDescriptionSettings,
} from "@/lib/photo-descriptions";

/**
 * The photo descriptions (#296 part 3), in their Settings row (#511): what the automatic
 * descriptions are, one switch that shows them under the photos, and three
 * that choose what they tell: the people and the setting, the face, the
 * activity and objects. Three is the limit before this row is its own
 * accessibility problem. Every choice stays on the device
 * (src/lib/photo-descriptions.tsx); the description is always in the photo's
 * spoken label, whatever the first switch says.
 */
export function PhotoDescriptionChoices() {
  const { t } = useT();
  const { settings, set } = usePhotoDescriptionSettings();
  const row = (key: keyof PhotoDescriptionSettings, label: string, hint?: string) => (
    <View className="gap-1">
      <View className="flex-row items-center justify-between gap-4">
        <Label onPress={() => set({ [key]: !settings[key] })}>{label}</Label>
        <Switch
          accessibilityLabel={label}
          checked={settings[key]}
          onCheckedChange={(on) => set({ [key]: on })}
        />
      </View>
      {hint && <Text variant="muted">{hint}</Text>}
    </View>
  );
  return (
    <>
      <Text>{t("settings.photoDescriptions.explain")}</Text>
      {row("shown", t("settings.photoDescriptions.show"), t("settings.photoDescriptions.showHint"))}
      <View className="gap-3">
        <Text variant="h3" accessibilityRole="header">
          {t("settings.photoDescriptions.tell.title")}
        </Text>
        {row("people", t("settings.photoDescriptions.tell.people"))}
        {row("face", t("settings.photoDescriptions.tell.face"))}
        {row("objects", t("settings.photoDescriptions.tell.objects"))}
      </View>
    </>
  );
}
