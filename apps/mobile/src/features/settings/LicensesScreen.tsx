import { useRouter } from "expo-router";
import { View } from "react-native";
import { RowGroup } from "@/components/RowGroup";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { LICENCES } from "./licences";
import { licenseGroups } from "./license-families";
import { SettingsPage } from "./SettingsPage";

const GROUPS = licenseGroups(LICENCES.packages);

/**
 * The packages whose code ships in this build, with their licences
 * (scripts/licenses.ts), in every build (#177, #287): in families by name,
 * each under a heading a screen reader can jump between (#376). Each package
 * is a row that opens nothing (#512), its name, then who provides it, its
 * version and its licence, read together as one sentence; a package that
 * names nobody has no provider. The texts the licences ask to go with every
 * copy are behind the last row.
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
            rows={group.entries.map(({ name, provider, version, license }) => ({
              key: `${name}@${version}`,
              title: name,
              summary: provider
                ? t("tech.licenses.provided", { provider, version, license })
                : t("tech.licenses.version", { version, license }),
            }))}
          />
        </View>
      ))}
      <RowGroup
        rows={[
          {
            key: "texts",
            title: t("tech.licenses.texts"),
            onPress: () => {
              tap();
              router.push("/settings/licenses/texts");
            },
          },
        ]}
      />
    </SettingsPage>
  );
}
