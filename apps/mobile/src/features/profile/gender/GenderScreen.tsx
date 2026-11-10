import { formatDateTime } from "@kuutti/i18n";
import type { Gender, ProfileFields } from "@kuutti/schema";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailedScreen, LoadingScreen } from "@/components/LoadFailed";
import { Notice } from "@/components/Notice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { codeOf } from "@/lib/api";
import { useT } from "@/lib/locale";
import { ConfirmLeaveDialog } from "../ConfirmLeave";
import { saveGender } from "../client";
import { saveChanges, useProfile } from "../useProfile";
import { useRefusedDraft, useSaveOnLeave } from "../useSaveOnLeave";
import { GenderChips, IdentityLabelChips } from "./GenderChips";
import { useOwnGender } from "./useOwnGender";

export const GENDER_PATH = "/profile/gender" as const;

type Word = ProfileFields["identityLabel"];

/** A refused change, held to bring its screen back: the gender, the word offered with it, and why. */
type HeldGender = { gender: Gender | null; word: Word; code: string | undefined };

/**
 * The person's own gender after sign-up (#552): the three genders from the
 * stored answer, saved on leaving. It is on the card, and a change starts the
 * limit (ADR-060 §9), which the lead says up front, since one mistaken tap
 * cannot be taken back within it. While the limit runs the
 * date is said on arrival and another gender stays unchosen; the API's refusal
 * remains for a change made elsewhere since this screen read the answer.
 *
 * The identity label is offered while non-binary is chosen and none is stored
 * (ADR-019 §1): a person who skipped it in onboarding has no other way to one,
 * and one who has a label changes it in Basics. A change away from non-binary
 * takes the label with it on the API, which the screen says beforehand.
 */
export function GenderScreen() {
  const { t, locale } = useT();
  const held = useRefusedDraft<HeldGender>(GENDER_PATH);
  const own = useOwnGender();
  const profile = useProfile();
  const [draft, setDraft] = useState<Gender | null>(held?.gender ?? null);
  // Here and not in the profile's draft: a held word must not need a read to come back.
  const [word, setWord] = useState<Word>(held?.word);
  // How many times another gender was pressed while the limit runs: each is said.
  const [refused, setRefused] = useState(0);
  const stored = own.status === "ready" ? own.gender : null;
  const nextChange = own.status === "ready" ? own.nextChange : null;
  const chosen = draft ?? stored;
  const label = profile.saved.fields.identityLabel;
  const labelOffered = chosen === "non_binary" && label === undefined;
  const labelGoes = stored === "non_binary" && chosen !== stored && label !== undefined;
  // With no stored answer to compare with (the read failed too), a held change is tried again.
  const genderChanged = draft !== null && draft !== stored;

  const leaving = useSaveOnLeave<HeldGender>({
    screen: GENDER_PATH,
    path: GENDER_PATH,
    held: held !== undefined,
    save: async () => {
      try {
        // First and on its own: a word goes only with a gender that was accepted,
        // and one left behind for another gender is not sent.
        if (genderChanged) await saveGender(draft);
        if (labelOffered && word) await saveChanges({ fields: { identityLabel: word } });
        return null;
      } catch (error) {
        const code = codeOf(error);
        return { gender: chosen, word, code };
      }
    },
  });

  // A change brought back outlives a read that failed: the network that lost
  // the save usually loses the read too, and it must not vanish behind this.
  if ((own.status === "error" || profile.status === "error") && !draft) {
    return (
      <LoadFailedScreen
        error={own.status === "error" ? own.error : profile.error}
        onRetry={() => {
          void own.reload();
          void profile.reload();
        }}
      />
    );
  }
  if (own.status === "loading" || profile.status === "loading") {
    return <LoadingScreen />;
  }

  const waiting = nextChange
    ? t("profile.gender.waiting", { date: formatDateTime(locale, new Date(nextChange)) })
    : null;
  const choose = (gender: Gender) => {
    // The stored answer can always be chosen: that is how a held change is undone.
    if (nextChange && gender !== stored) {
      setRefused((times) => times + 1);
      return;
    }
    setRefused(0);
    setDraft(gender);
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={t("profile.gender.title")} backLabel={t("profile.section.back")} />
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <Text>{t("profile.gender.explain")}</Text>
        <GenderChips chosen={chosen} onChoose={choose} />
        {waiting && <Notice words={waiting} answer={refused} refused={refused > 0} />}
        {labelGoes && <Notice words={t("profile.gender.labelGoes")} />}
        {labelOffered && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.identityLabel.title")}</Text>
            {/* A hide outlives its answer (#515), so a word given now stays off the card. */}
            <Notice
              words={t(
                profile.saved.hiddenFields?.includes("identityLabel")
                  ? "profile.hide.hidden"
                  : "profile.gender.label.explain",
              )}
            />
            <IdentityLabelChips chosen={word} onChange={setWord} />
          </View>
        )}
      </ScrollView>
      <ConfirmLeaveDialog
        {...leaving}
        reason={
          held?.code === "change_too_soon"
            ? (waiting ?? t("errors.change_too_soon"))
            : t("load.failed.press")
        }
      />
    </SafeAreaView>
  );
}
