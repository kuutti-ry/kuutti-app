import { realLocale } from "@kuutti/i18n";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { type Agreements, agreementsOf } from "./agreements";
import { LegalTextLink } from "./LegalTextLink";

/**
 * The norms and the two consents a person accepts before anything else, under
 * the screen's one heading (#581): the terms and the privacy summary, each as
 * the exact version this app carries with its link to the full text, and
 * outside Finnish the line that the Finnish text is the one that counts
 * (ADR-010 §4, §9). Shown before the bank login (#418) and on onboarding's
 * welcome step after it.
 */
export function NormsAndConsents() {
  const { t, locale } = useT();
  return (
    <>
      <Text variant="h1" accessibilityRole="header">
        {t("onboarding.welcome.title")}
      </Text>
      <View className="gap-2">
        <Text>{t("onboarding.welcome.norm1")}</Text>
        <Text>{t("onboarding.welcome.norm2")}</Text>
      </View>
      <Text>{t("onboarding.consents.explain")}</Text>
      {realLocale(locale) !== "fi" && (
        <Text variant="muted">{t("onboarding.consents.binding")}</Text>
      )}
      {(["terms", "privacy"] as const).map((kind) => (
        <Card key={kind}>
          <CardHeader>
            <CardTitle>
              {t(kind === "terms" ? "legal.terms.title" : "legal.privacy.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="gap-2">
            <Text>{t(kind === "terms" ? "legal.terms.summary" : "legal.privacy.summary")}</Text>
            <LegalTextLink kind={kind} />
          </CardContent>
        </Card>
      ))}
    </>
  );
}

// shortcut: nothing is asked about research until there is a researcher (#545, ADR-010 §19).
// R3 Research (#194) brings the question back after the button below, as §15 describes it.
/**
 * The screen before the bank login (#418, ADR-010 §15): the norms with the
 * terms and the privacy summary, which a person must accept to go on, so the
 * bank button cannot be reached before. The answers are handed back to wait for
 * the exchange; nothing is sent from here, since no account exists yet.
 */
export function BeforeSignIn({ onAgreed }: { onAgreed: (agreements: Agreements) => void }) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="flex-grow gap-4 p-6">
        <NormsAndConsents />
        <Button
          onPress={() => {
            tap();
            onAgreed(agreementsOf(locale));
          }}
        >
          {t("onboarding.welcome.accept")}
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}
