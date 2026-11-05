import { BIO_MAX, BIO_PRESETS, type ProfileUpdate } from "@kuutti/schema";
import { View } from "react-native";
import { Choice } from "@/components/Choice";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { presetKey } from "./keys";

/**
 * The bio, or a ready line in its place (#47): typing clears the line, a line
 * clears the bio. Either counts for completeness (#239), so the basics
 * section and onboarding's step for words of one's own (#146) share it. A ready
 * line is a sentence, so each is a whole-width row, which wraps (the maintainer,
 * 04/11/2026); as chips they ran off the screen.
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
      <Text variant="small">{t("profile.bio.orPreset")}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("profile.bio.orPreset")}
        className="gap-2"
      >
        {BIO_PRESETS.map((preset) => (
          <Choice
            key={preset}
            label={t(presetKey(preset))}
            chosen={draft.bioPreset === preset}
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
