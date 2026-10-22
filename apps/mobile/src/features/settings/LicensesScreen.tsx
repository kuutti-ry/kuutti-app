import { useRouter } from "expo-router";
import { View } from "react-native";
import { RowGroup } from "@/components/RowGroup";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { LICENCES } from "./licences";
import { licenseGroups } from "./license-families";
import { SettingsPage } from "./SettingsPage";

// Each package with its place in the list, which its own screen's link names.
const GROUPS = licenseGroups(LICENCES.packages.map((entry, index) => ({ ...entry, index })));

/**
 * The packages whose code ships in this build, with their licences
 * (scripts/licenses.ts), in every build (#177, #287): in families by name,
 * each under a heading a screen reader can jump between (#376). Each package
 * is a row that opens its copyright lines and licence text (#416), its
 * version and licence heard as the row's value.
 */
export function LicensesScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  return (
    <SettingsPage title={t("tech.licenses.title")}>
      {GROUPS.map((group) => (
        <View key={group.family ?? "other"} className="gap-2">
          <Text variant="h3" accessibilityRole="header">
            {group.family ?? t("tech.licenses.other")}
          </Text>
          <RowGroup
            rows={group.entries.map((entry) => {
              const summary = t("tech.licenses.version", {
                version: entry.version,
                license: entry.license,
              });
              return {
                key: `${entry.name}@${entry.version}`,
                title: entry.name,
                summary,
                value: summary,
                onPress: () => {
                  tap();
                  router.push(`/settings/licenses/${entry.index}`);
                },
              };
            })}
          />
        </View>
      ))}
    </SettingsPage>
  );
}
