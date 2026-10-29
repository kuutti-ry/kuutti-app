import { useRouter } from "expo-router";
import Settings from "lucide-react-native/icons/settings";
import Wrench from "lucide-react-native/icons/wrench";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Ink } from "@/components/ui/ink";
import { Text } from "@/components/ui/text";
import { ChatsButton } from "@/features/chat";
import { useOnboardingGate, useSession } from "@/features/identity";
import { RoundButton } from "@/features/matching";
import { Notices, PushOffer } from "@/features/notifications";
import { GateCard, WaitlistCard } from "@/features/pond";
import { isProduction } from "@/lib/environment";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";

// The mark is black ink on transparency (assets/logo-mark.png, made by
// scripts/logo from docs/design/logo), tinted with the foreground token.
const MARK = require("../../../assets/logo-mark.png");

/**
 * The home screen of a signed-in person (#143): where their pond and their
 * gate stand, the way to the profile (which holds the photos, the
 * deal-breakers and the later questions, #239), and the settings. The
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
  const session = useSession();
  const technical = !isProduction();

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* The wrench left and the gear right (#511), the gear alone on the right in production. */}
      <View className="flex-row justify-between px-2">
        {technical ? (
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
        ) : (
          <View />
        )}
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
      </View>
      <ScrollView contentContainerClassName="flex-grow items-center justify-center gap-4 p-6">
        <Ink source={MARK} className="h-24 w-24 text-foreground" />
        <Text variant="h1" accessibilityRole="header">
          {t("home.title")}
        </Text>
        {/* The login that ended a break (#170): said once, for as long as this sign-in's outcome is in memory. */}
        {session.status === "signed-in" && session.outcome === "unpaused" && (
          <Text accessibilityLiveRegion="polite" className="w-full max-w-md text-center">
            {t("home.welcomeBack")}
          </Text>
        )}

        {gate.status === "checking" && (
          <Text accessibilityLiveRegion="polite">{t("home.gate.checking")}</Text>
        )}
        {gate.status === "unknown" && (
          <View className="w-full max-w-md gap-3">
            <LoadFailed headline={t("home.gate.failed")} error={gate.error} onRetry={gate.retry} />
          </View>
        )}

        {gate.status === "complete" && (
          <View className="w-full max-w-md gap-4">
            {/* What must reach the person even without a push, unread, first (#176). */}
            <Notices />
            {/* How the person's own pond is filling up (#54), and where they stand themselves (#94);
                once matching is open, the way to today's round (#379) and the one offer of
                notifications, since now there is something to tell (#102, ADR-055 §9). */}
            {gate.pond && <WaitlistCard pond={gate.pond} />}
            {gate.pond && (
              <GateCard
                whenOpen={
                  <>
                    <RoundButton />
                    <PushOffer />
                  </>
                }
              />
            )}
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
            {/* The conversations a match opens, with what is unread (#348). */}
            <ChatsButton />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
