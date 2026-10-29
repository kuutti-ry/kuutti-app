import Check from "lucide-react-native/icons/check";
import { useMemo, useState } from "react";
import { Modal, Platform, SectionList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useReducedMotion } from "@/theme/useReducedMotion";
import { type Country, countries, NEAR_REGIONS, type Region, search } from "./phone";

/**
 * The list of countries a number's code is chosen from (#511): Finland and
 * its neighbours first, then every country in the app's language and order,
 * each with its flag (silent), its name and its code, the chosen one ticked
 * and heard as selected. A search finds a country by its name in the app's
 * language or in English, accents and case aside, or by the code's digits.
 * React Native's own Modal, not the app's dialog: it is a window of its own
 * on Android, so TalkBack does not wander into the list behind it, the
 * number's field stays where it was, and two hundred countries and a search
 * have the whole screen above the keyboard. Android's back key closes it;
 * it slides in, or not under reduce motion.
 */
export function CountryPicker({
  open,
  region,
  onChoose,
  onClose,
}: {
  open: boolean;
  region: Region;
  onChoose: (region: Region) => void;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const reduced = useReducedMotion();
  const [query, setQuery] = useState("");
  const all = useMemo(() => countries(locale), [locale]);
  const near = useMemo(
    () => NEAR_REGIONS.flatMap((code) => all.filter((country) => country.region === code)),
    [all],
  );
  const found = search(all, query);
  const sections =
    query.trim() === ""
      ? [
          { key: "near", title: t("settings.country.near"), data: near },
          { key: "all", title: t("settings.country.all"), data: all },
        ]
      : [{ key: "found", title: t("settings.country.all"), data: found }];

  return (
    <Modal
      visible={open}
      animationType={reduced ? "none" : "slide"}
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : undefined}
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-2">
          <Text variant="h4" className="flex-1">
            {t("settings.contacts.country")}
          </Text>
          <Button variant="ghost" onPress={onClose}>
            {t("settings.country.close")}
          </Button>
        </View>
        <View className="gap-1.5 px-4 py-3">
          <Text variant="small">{t("settings.country.search")}</Text>
          <Input
            accessibilityLabel={t("settings.country.searchLabel")}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
        </View>
        {found.length === 0 ? (
          <Text className="px-4" accessibilityLiveRegion="polite">
            {t("settings.country.none")}
          </Text>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(country, index) => `${country.region}-${index}`}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            renderSectionHeader={({ section }) => (
              <Text variant="title" className="bg-background px-4 pb-1 pt-4">
                {section.title}
              </Text>
            )}
            renderItem={({ item }) => (
              <CountryRow
                country={item}
                chosen={item.region === region}
                onPress={() => {
                  setQuery("");
                  onChoose(item.region);
                }}
              />
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

function CountryRow({
  country,
  chosen,
  onPress,
}: {
  country: Country;
  chosen: boolean;
  onPress: () => void;
}) {
  const { t } = useT();
  return (
    <Button
      variant="ghost"
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      // react-native-web reads the ARIA prop, not accessibilityState.
      aria-checked={chosen}
      accessibilityLabel={t("settings.contacts.countryValue", {
        country: country.name,
        code: country.code,
      })}
      className="justify-start gap-3 rounded-none px-4"
      onPress={onPress}
    >
      <Text accessibilityElementsHidden importantForAccessibility="no">
        {country.flag}
      </Text>
      <Text className="flex-1 font-normal">{country.name}</Text>
      <Text className="font-normal text-muted-foreground">{country.code}</Text>
      {chosen && <Icon as={Check} className="text-foreground" />}
    </Button>
  );
}
