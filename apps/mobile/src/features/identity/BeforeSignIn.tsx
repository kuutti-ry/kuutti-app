import { realLocale } from "@kuutti/i18n";
import { useEffect, useRef, useState } from "react";
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
 * The norms and the two consents a person accepts before anything else: the
 * terms and the privacy summary, each as the exact version this app carries
 * with its link to the full text, and outside Finnish the line that the
 * Finnish text is the one that counts (ADR-010 §4, §9). Shown before the bank
 * login (#418) and on onboarding's welcome step after it.
 */
export function NormsAndConsents() {
  const { t, locale } = useT();
  return (
    <>
      <Text variant="h2">{t("onboarding.welcome.title")}</Text>
      <View className="gap-2">
        <Text>{t("onboarding.welcome.norm1")}</Text>
        <Text>{t("onboarding.welcome.norm2")}</Text>
        <Text>{t("onboarding.welcome.norm3")}</Text>
        <Text>{t("onboarding.welcome.norm4")}</Text>
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

/**
 * The screens before the bank login (#418, ADR-010 §15). First the norms with
 * the terms and the privacy summary, which a person must accept to go on: the
 * bank button cannot be reached before. Then the research question, a yes or
 * a no with nothing chosen beforehand and neither drawn stronger, where either
 * answer goes on to the bank and a no costs nothing (GDPR art. 7(4)). The
 * answers are handed back to wait for the exchange; nothing is sent from here,
 * since no account exists yet.
 */
export function BeforeSignIn({ onAgreed }: { onAgreed: (agreements: Agreements) => void }) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const [step, setStep] = useState<"consents" | "research">("consents");
  // The research step starts at its top, not where the long first one was left.
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (step === "research") scroll.current?.scrollTo({ y: 0, animated: false });
  }, [step]);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView ref={scroll} contentContainerClassName="flex-grow gap-6 p-6">
        <Text variant="h1" accessibilityRole="header">
          {t("signIn.agreements.title")}
        </Text>
        {step === "consents" ? (
          <View className="gap-4">
            <NormsAndConsents />
            <Button
              onPress={() => {
                tap();
                setStep("research");
              }}
            >
              {t("onboarding.welcome.accept")}
            </Button>
          </View>
        ) : (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.research.title")}</Text>
            {realLocale(locale) !== "fi" && (
              <Text variant="muted">{t("onboarding.consents.binding")}</Text>
            )}
            <Card>
              <CardHeader>
                <CardTitle>{t("legal.research.title")}</CardTitle>
              </CardHeader>
              <CardContent className="gap-2">
                <Text>{t("legal.research.summary")}</Text>
                <LegalTextLink kind="research" />
              </CardContent>
            </Card>
            <Text variant="muted">{t("onboarding.research.later")}</Text>
            <Text>{t("signIn.agreements.research")}</Text>
            <Button
              variant="outline"
              onPress={() => {
                tap();
                onAgreed(agreementsOf(locale, true));
              }}
            >
              {t("onboarding.research.yes")}
            </Button>
            <Button
              variant="outline"
              onPress={() => {
                tap();
                onAgreed(agreementsOf(locale, false));
              }}
            >
              {t("onboarding.research.no")}
            </Button>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
