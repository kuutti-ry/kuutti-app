import { Image } from "expo-image";
import { useRouter } from "expo-router";
import Settings from "lucide-react-native/icons/settings";
import Wrench from "lucide-react-native/icons/wrench";
import { cssInterop } from "nativewind";
import { Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useOnboardingGate } from "@/features/identity";
import { GateCard, WaitlistCard } from "@/features/pond";
import { FIRST_LATER_FIELD, laterPath } from "@/features/profile";
import { isProduction } from "@/lib/environment";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";

// The mark is black ink on transparency (assets/logo-mark.png, made by
// scripts/logo from docs/design/logo), tinted with the foreground token so it
// follows all four theme sets: the text colour class is handed over as
// tintColor, the way Icon does it for lucide. That hand-over is native only;
// on the web target the ink is inverted under the dark class instead, and both
// dark foregrounds are near white.
const Mark = cssInterop(Image, {
  className: { target: "style", nativeStyleToProp: { color: "tintColor" } },
});
const MARK = require("../../../assets/logo-mark.png");
const MARK_CLASS = cn("h-24 w-24 text-foreground", Platform.select({ web: "dark:invert" }));

/**
 * The home screen of a signed-in person (#143): where their pond and their
 * gate stand, the way to the profile and the photos, and the settings. The
 * technical view (the API, the commits, a test error) is one tap away outside
 * production and absent in the store's build. An account that has not
 * finished onboarding (#46) is sent there first; until the status is known
 * and complete, nothing that needs a finished account shows.
 */
export function HomeScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const gate = useOnboardingGate();
  const technical = !isProduction();

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row justify-between px-2">
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel={t("home.settings.open")}
          onPress={() => {
            tap();
            router.push("/settings");
          }}
        >
          <Icon as={Settings} />
        </Button>
        {technical && (
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel={t("home.tech.open")}
            onPress={() => {
              tap();
              router.push("/tech");
            }}
          >
            <Icon as={Wrench} />
          </Button>
        )}
      </View>
      <ScrollView contentContainerClassName="flex-grow items-center justify-center gap-4 p-6">
        <Mark source={MARK} contentFit="contain" className={MARK_CLASS} {...DECORATIVE} />
        <Text variant="h1" accessibilityRole="header">
          {t("home.title")}
        </Text>

        {gate.status === "checking" && (
          <Text accessibilityLiveRegion="polite">{t("home.gate.checking")}</Text>
        )}
        {gate.status === "unknown" && (
          <View className="w-full max-w-md gap-3">
            <Text accessibilityLiveRegion="assertive">{t("home.gate.failed")}</Text>
            <Button
              variant="outline"
              accessibilityLabel={t("home.gate.retry")}
              onPress={gate.retry}
            >
              <Text>{t("home.gate.retry")}</Text>
            </Button>
          </View>
        )}

        {gate.status === "complete" && (
          <View className="w-full max-w-md gap-4">
            {/* How the person's own pond is filling up (#54), and where they stand themselves (#94). */}
            {gate.pond && <WaitlistCard pond={gate.pond} />}
            {gate.pond && <GateCard />}
            <Button
              variant="outline"
              accessibilityLabel={t("profile.home.open")}
              onPress={() => {
                tap();
                router.push("/profile");
              }}
            >
              <Text>{t("profile.home.open")}</Text>
            </Button>
            <Button
              variant="outline"
              accessibilityLabel={t("home.photos.open")}
              onPress={() => {
                tap();
                router.push("/photos");
              }}
            >
              <Text>{t("home.photos.open")}</Text>
            </Button>
            {/* The optional fields, one at a time, while the person waits at the gate (#148, TD-16). */}
            <Button
              variant="outline"
              accessibilityLabel={t("profile.later.open")}
              onPress={() => {
                tap();
                router.push(laterPath(FIRST_LATER_FIELD));
              }}
            >
              <Text>{t("profile.later.open")}</Text>
            </Button>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
