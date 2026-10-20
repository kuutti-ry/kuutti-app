import { View } from "react-native";
import { Text } from "@/components/ui/text";
import LICENSES from "@/generated/licenses.json";
import { useT } from "@/lib/locale";
import { licenseGroups } from "./license-families";
import { SettingsPage } from "./SettingsPage";

const GROUPS = licenseGroups(LICENSES);

/**
 * The packages whose code ships in this build, with their licences
 * (scripts/licenses.ts), in every build (#177, #287): in families by name,
 * each under a heading a screen reader can jump between (#376).
 */
export function LicensesScreen() {
  const { t } = useT();
  return (
    <SettingsPage title={t("tech.licenses.title")}>
      {GROUPS.map((group) => (
        <View key={group.family ?? "other"} className="gap-1">
          <Text variant="h3" accessibilityRole="header">
            {group.family ?? t("tech.licenses.other")}
          </Text>
          {group.entries.map((entry) => (
            <Text key={`${entry.name}@${entry.version}`} variant="muted">
              {`${entry.name} ${entry.version} · ${entry.license}`}
            </Text>
          ))}
        </View>
      ))}
    </SettingsPage>
  );
}
