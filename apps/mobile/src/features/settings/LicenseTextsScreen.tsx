import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { LICENCES, type LicenceList, licenceTexts } from "./licences";
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
 * What the licences of the list ask to go with every copy of the app, behind
 * the list's last row (#512): each licence text once under a heading a screen
 * reader can jump between, the packages under it, each with its copyright
 * lines (#416), and last each NOTICE file with the packages that ship it. The
 * texts are the packages' files as written, in English; only the headings are
 * the app's words. A package that ships no licence file says where upstream
 * has the lines and the text. `list` is this build's, but for a test.
 */
export function LicenseTextsScreen({ list = LICENCES }: { list?: LicenceList }) {
  const { t } = useT();
  const { licences, notices } = licenceTexts(list);
  return (
    <SettingsPage title={t("tech.licenses.texts")}>
      {licences.map(({ key, paragraphs, items }, at) => (
        <View key={key} className="gap-3">
          <Text variant="h3" accessibilityRole="header">
            {t("tech.licenses.licenceAt", { place: at + 1 })}
          </Text>
          <Paragraphs lines={paragraphs} />
          <Text variant="title">{t("tech.licenses.packages")}</Text>
          {items.map(({ name, version, licence }) => (
            <View key={`${name}@${version} ${licence.file ?? licence.from}`} className="gap-1">
              <Text className="font-semibold" selectable>
                {`${name} ${version}`}
              </Text>
              <Paragraphs lines={licence.copyright} />
              {licence.from && (
                <Text variant="muted" selectable>
                  {t("tech.licenses.from", { address: licence.from })}
                </Text>
              )}
            </View>
          ))}
        </View>
      ))}
      {notices.map(({ key, paragraphs, items }) => (
        <View key={key} className="gap-3">
          <Text variant="h3" accessibilityRole="header">
            {t("tech.licenses.notice")}
          </Text>
          <Paragraphs lines={paragraphs} />
          <Text variant="title">{t("tech.licenses.packages")}</Text>
          <Paragraphs lines={items} />
        </View>
      ))}
    </SettingsPage>
  );
}
