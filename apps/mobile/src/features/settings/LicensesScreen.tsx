import { Text } from "@/components/ui/text";
import LICENSES from "@/generated/licenses.json";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The packages whose code ships in this build, with their licences (scripts/licenses.ts), in every build (#177, #287). */
export function LicensesScreen() {
  const { t } = useT();
  return (
    <SettingsPage title={t("tech.licenses.title")}>
      {LICENSES.map((entry) => (
        <Text key={`${entry.name}@${entry.version}`} variant="muted">
          {`${entry.name} ${entry.version} · ${entry.license}`}
        </Text>
      ))}
    </SettingsPage>
  );
}
