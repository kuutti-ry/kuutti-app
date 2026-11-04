import type { InvitationReward } from "@kuutti/schema";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { RedeemInvitation } from "./RedeemInvitation";
import { rewardParams } from "./words";

/**
 * Onboarding's optional step right after the welcome (#107, ADR-044 Context
 * 5), for somebody the API says may still type a code: what it earns them
 * (#503), the field and Skip; after a code that worked, that it is in, and
 * Continue. Either way the step is done for this walk, and nothing in it ever
 * holds onboarding up.
 */
export function InvitationStep({
  reward,
  onDone,
}: {
  reward: InvitationReward;
  onDone: () => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const [redeemed, setRedeemed] = useState(false);
  const leave = () => {
    tap();
    onDone();
  };
  return (
    <View className="gap-4">
      <Text variant="h2">{t("invite.step.title")}</Text>
      <Text>{t("invite.step.explain")}</Text>
      {reward.friendFish > 0 && <Text>{t("invite.redeem.earns", rewardParams(reward))}</Text>}
      {redeemed ? (
        <>
          <Text accessibilityLiveRegion="polite">{t("invite.redeem.done")}</Text>
          <Button onPress={leave}>{t("onboarding.continue")}</Button>
        </>
      ) : (
        <>
          <RedeemInvitation onRedeemed={() => setRedeemed(true)} />
          <Button variant="outline" onPress={leave}>
            {t("invite.step.skip")}
          </Button>
        </>
      )}
    </View>
  );
}
