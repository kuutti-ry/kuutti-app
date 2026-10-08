import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";
import { SignInScreen, useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { HomeScreen } from "./HomeScreen";

/**
 * The first screen (#143, #36): the sign-in for a person who is not signed
 * in, one button and the bank; the home screen for one who is. Nothing while
 * the stored session is still being read.
 */
export function HomeRoute() {
  const { t } = useT();
  const session = useSession();
  if (session.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("home.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (session.status === "signed-out") return <SignInScreen />;
  return <HomeScreen />;
}
