import type { PlainMessageKey } from "@kuutti/i18n";
import {
  INVITATION_CODE_INPUT_MAX,
  INVITATION_CODE_PATTERN,
  normaliseInvitationCode,
} from "@kuutti/schema";
import { useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { redeemInvitation } from "./client";

/** The redeem's refusals in the API's own words (ADR-044 §6); any other failure says it could not be checked. */
const REFUSALS = new Map<string | undefined, PlainMessageKey>([
  ["invitation_unknown", "errors.invitation_unknown"],
  ["invitation_not_for_you", "errors.invitation_not_for_you"],
  ["invitation_tries_exceeded", "errors.invitation_tries_exceeded"],
]);

/**
 * A code from a friend (#107, ADR-044 §6): its field, and Use the code, dimmed
 * until what is typed reads as a code the way the API reads it (case, spaces
 * and hyphens away, O as zero, I and L as one), so a slip costs none of the
 * day's tries. A refusal is said in words in a live region and, on iOS,
 * aloud; one code that does not work reads like any other. A code that works
 * is said the same way, and the caller takes the form away.
 */
export function RedeemInvitation({ onRedeemed }: { onRedeemed: () => void }) {
  const { t } = useT();
  const tap = useHapticTap();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<PlainMessageKey | null>(null);
  // Which answer the refusal is: each a fresh live region, so the same words are said again.
  const [answers, setAnswers] = useState(0);
  const readable = INVITATION_CODE_PATTERN.test(normaliseInvitationCode(typed));

  const send = async () => {
    tap();
    setBusy(true);
    setRefusal(null);
    try {
      await redeemInvitation(typed);
    } catch (error) {
      const words =
        REFUSALS.get(error instanceof ApiError ? error.code : undefined) ?? "invite.redeem.failed";
      setRefusal(words);
      setAnswers((n) => n + 1);
      setBusy(false);
      // Android's live region speaks it; iOS has none.
      if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(t(words));
      return;
    }
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(t("invite.redeem.done"));
    onRedeemed();
  };

  return (
    <View className="gap-3">
      <View className="gap-2">
        <Text variant="small">{t("invite.redeem.label")}</Text>
        <Input
          accessibilityLabel={t("invite.redeem.label")}
          value={typed}
          maxLength={INVITATION_CODE_INPUT_MAX}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          onChangeText={(text) => {
            setRefusal(null);
            setTyped(text);
          }}
        />
      </View>
      <Button disabled={busy || !readable} onPress={() => void send()}>
        {t("invite.redeem.button")}
      </Button>
      {refusal !== null && (
        <Text key={answers} accessibilityLiveRegion="assertive">
          {t(refusal)}
        </Text>
      )}
    </View>
  );
}
