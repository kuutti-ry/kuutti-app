import type { PlainMessageKey } from "@kuutti/i18n";
import { View } from "react-native";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { type Hand, useDecisionButtons } from "@/lib/decision-buttons";
import { useT } from "@/lib/locale";
import { Choice } from "./Choice";
import { SettingsPage } from "./SettingsPage";

/** The two hands, in the order they are offered; the right is the default. */
const HANDS: ReadonlyArray<{ value: Hand; label: PlainMessageKey }> = [
  { value: "right", label: "settings.decisionButtons.right" },
  { value: "left", label: "settings.decisionButtons.left" },
];

/**
 * The Decision buttons screen (#82): which hand the round's Like and Pass
 * are placed for, and one-handed mode, which puts Undo, the fish, Pass and
 * Like in one column on that side. Kept on the phone
 * (src/lib/decision-buttons.tsx); the buttons keep their words and shapes
 * wherever they sit.
 */
export function DecisionButtonsScreen() {
  const { t } = useT();
  const { settings, set } = useDecisionButtons();
  return (
    <SettingsPage title={t("settings.decisionButtons.label")}>
      <Text>{t("settings.decisionButtons.explain")}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("settings.decisionButtons.hand")}
        className="flex-row flex-wrap gap-2"
      >
        {HANDS.map(({ value, label }) => (
          <Choice
            key={value}
            label={t(label)}
            chosen={settings.hand === value}
            onPress={() => set({ hand: value })}
          />
        ))}
      </View>
      <View className="gap-1">
        <View className="flex-row items-center justify-between gap-4">
          <Label onPress={() => set({ oneHanded: !settings.oneHanded })}>
            {t("settings.decisionButtons.oneHanded")}
          </Label>
          <Switch
            accessibilityLabel={t("settings.decisionButtons.oneHanded")}
            checked={settings.oneHanded}
            onCheckedChange={(on) => set({ oneHanded: on })}
          />
        </View>
        <Text variant="muted">{t("settings.decisionButtons.oneHandedHint")}</Text>
      </View>
    </SettingsPage>
  );
}
