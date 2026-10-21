import type { PlainMessageKey } from "@kuutti/i18n";
import type { FoundReason } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { Choice } from "./Choice";
import { readFoundThem, tellFoundThem } from "./found-them-client";
import { SettingsPage } from "./SettingsPage";

/** The three reasons in the order the person reads them, the maintainer's of 21/10/2026. */
const REASONS: ReadonlyArray<{ value: FoundReason; label: PlainMessageKey }> = [
  { value: "here", label: "account.foundThem.reason.here" },
  { value: "elsewhere", label: "account.foundThem.reason.elsewhere" },
  { value: "other", label: "account.foundThem.reason.other" },
];

type State = "checking" | "asking" | "sending" | "failed" | "thanked";

/**
 * "Löysin hänet" (#83, ADR-040): the person tells Kuutti they found somebody,
 * and why, from three choices, and Kuutti thanks them. It is an indication
 * and nothing more: the screen says that nothing in the app changes, and
 * where the break and the deletion are for someone who wants to step away.
 * An account that told Kuutti before is thanked again, never asked twice.
 * The choice is said in words (the ticked option, never a colour alone); a
 * failure keeps it.
 */
export function FoundThemScreen() {
  const { t } = useT();
  const tap = useHapticTap();
  const session = useSession();
  const [reason, setReason] = useState<FoundReason | null>(null);
  const [state, setState] = useState<State>("checking");
  const signedIn = session.status === "signed-in";

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    readFoundThem().then(
      (answered) => live && setState(answered ? "thanked" : "asking"),
      // Not known: ask, and let a second answer be told apart by the API.
      () => live && setState("asking"),
    );
    return () => {
      live = false;
    };
  }, [signedIn]);

  const send = async () => {
    if (!reason) return;
    setState("sending");
    try {
      await tellFoundThem(reason);
      setState("thanked");
    } catch (error) {
      const told = error instanceof ApiError && error.code === "found_them_answered";
      setState(told ? "thanked" : "failed");
    }
  };

  return (
    <SettingsPage title={t("account.foundThem.title")}>
      {!signedIn ? (
        <Text variant="muted">{t("settings.session.none")}</Text>
      ) : state === "checking" ? (
        <Text accessibilityLiveRegion="polite">{t("home.loading")}</Text>
      ) : state === "thanked" ? (
        <View className="gap-3" accessibilityLiveRegion="polite">
          <Text variant="h3" accessibilityRole="header">
            {t("account.foundThem.thanks")}
          </Text>
          <Text>{t("account.foundThem.unchanged")}</Text>
        </View>
      ) : (
        <>
          <Text>{t("account.foundThem.intro")}</Text>
          {/* The question in sight above the choices; the group carries it as its name too. */}
          <Text variant="small" role="heading" aria-level="3">
            {t("account.foundThem.question")}
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("account.foundThem.question")}
            className="gap-2"
          >
            {REASONS.map(({ value, label }) => (
              <Choice
                key={value}
                label={t(label)}
                chosen={reason === value}
                // The answer on its way is the one chosen: no other is ticked meanwhile.
                disabled={state === "sending"}
                onPress={() => {
                  tap();
                  setState("asking");
                  setReason(value);
                }}
              />
            ))}
          </View>
          <Text variant="muted">{t("account.foundThem.unchanged")}</Text>
          {state === "failed" && (
            <Text accessibilityLiveRegion="assertive">{t("account.foundThem.failed")}</Text>
          )}
          <Button
            disabled={!reason || state === "sending"}
            onPress={() => {
              tap();
              void send();
            }}
          >
            {state === "sending" ? t("account.foundThem.sending") : t("account.foundThem.send")}
          </Button>
        </>
      )}
    </SettingsPage>
  );
}
