import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { LICENCES, type LicenceList } from "./licences";
import { SettingsPage } from "./SettingsPage";

/**
 * Paragraphs, one Text each, so a screen reader moves by paragraph; every one
 * can be selected and copied. A text may repeat a paragraph (a "---" between
 * two notices), so each is keyed by its words and how often they came before.
 */
function Paragraphs({ lines }: { lines: readonly string[] }) {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const time = (seen.get(line) ?? 0) + 1;
    seen.set(line, time);
    return (
      <Text key={`${time}:${line}`} selectable>
        {line}
      </Text>
    );
  });
}

/**
 * One package of the licences list (#416): its name the header, its version
 * and licence, then each licence it carries under a heading of its own, its
 * copyright lines over its text, and last its NOTICE, if it has one. The
 * texts are the package's files as written, in English; only the headings
 * are the app's words. A package that ships no licence file says where
 * upstream has the lines and the text. `list` is this build's, but for a
 * test.
 */
export function PackageLicenseScreen({
  index,
  list = LICENCES,
}: {
  index: number;
  list?: LicenceList;
}) {
  const { t } = useT();
  const entry = list.packages[index];
  if (!entry) {
    return (
      <SettingsPage title={t("tech.licenses.title")}>
        <Text>{t("tech.licenses.unknown")}</Text>
      </SettingsPage>
    );
  }
  const text = (key: string) => list.texts[key] ?? [];
  return (
    <SettingsPage title={entry.name}>
      <Text variant="muted" selectable>
        {t("tech.licenses.version", { version: entry.version, license: entry.license })}
      </Text>
      {entry.licences.map((licence, at) => (
        <View key={licence.file ?? licence.from} className="gap-3">
          <Text variant="h3" accessibilityRole="header">
            {entry.licences.length === 1
              ? t("tech.licenses.licence")
              : t("tech.licenses.licenceAt", { place: at + 1 })}
          </Text>
          <Paragraphs lines={licence.copyright} />
          <Paragraphs lines={text(licence.text)} />
          {licence.from && (
            <Text variant="muted" selectable>
              {t("tech.licenses.from", { address: licence.from })}
            </Text>
          )}
        </View>
      ))}
      {entry.notices.length > 0 && (
        <View className="gap-3">
          <Text variant="h3" accessibilityRole="header">
            {t("tech.licenses.notice")}
          </Text>
          <Paragraphs lines={entry.notices.flatMap(text)} />
        </View>
      )}
    </SettingsPage>
  );
}
