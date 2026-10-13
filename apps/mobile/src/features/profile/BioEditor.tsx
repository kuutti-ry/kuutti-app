import { BIO_MAX, BIO_MIN_FOR_COMPLETENESS, BIO_PRESETS, type ProfileUpdate } from "@kuutti/schema";
import { View } from "react-native";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { Chip } from "./FieldEditor";
import { presetKey } from "./keys";

/**
 * The bio, or a ready line in its place (#47): typing clears the line, a line
 * clears the bio. Either counts for completeness (#239), so the basics
 * section and onboarding's step for words of one's own (#146) share it.
 */
export function BioEditor({
  draft,
  update,
}: {
  draft: Pick<ProfileUpdate, "bio" | "bioPreset">;
  update: (patch: Partial<Pick<ProfileUpdate, "bio" | "bioPreset">>) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  return (
    <View className="gap-2">
      <Text variant="small">{t("profile.bio.label")}</Text>
      <Input
        accessibilityLabel={t("profile.bio.label")}
        value={draft.bio ?? ""}
        maxLength={BIO_MAX}
        multiline
        // Room for four lines and more as the bio grows: a capped field scrolled
        // its start out of sight at large text sizes (10/10/2026).
        className="min-h-28"
        onChangeText={(text) =>
          update({
            bio: text.length > 0 ? text : null,
            bioPreset: text.length > 0 ? null : draft.bioPreset,
          })
        }
      />
      <Text variant="muted">{t("profile.bio.hint", { min: BIO_MIN_FOR_COMPLETENESS })}</Text>
      <Text variant="small">{t("profile.bio.orPreset")}</Text>
      <View className="flex-row flex-wrap gap-2">
        {BIO_PRESETS.map((preset) => (
          <Chip
            key={preset}
            label={t(presetKey(preset))}
            selected={draft.bioPreset === preset}
            onPress={() => {
              tap();
              update(
                draft.bioPreset === preset ? { bioPreset: null } : { bioPreset: preset, bio: null },
              );
            }}
          />
        ))}
      </View>
    </View>
  );
}
