import {
  LATER_COMPANIONS,
  LATER_FIELD_ORDER,
  PROFILE_FIELDS,
  type ProfileFieldKey,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { FieldEditor, isConsented, SpecialCategoryConsent } from "../FieldEditor";
import { useProfile } from "../useProfile";

/** The route of a later screen; the first one is where the home screen and the profile send a person. */
export const laterPath = (field: ProfileFieldKey) => `/profile/later/${field}` as const;
export const FIRST_LATER_FIELD = LATER_FIELD_ORDER[0] as ProfileFieldKey;

/** The first later field after the index that the draft does not answer; none when every one is. */
export function nextUnanswered(
  fields: Record<string, unknown>,
  afterIndex: number,
): ProfileFieldKey | undefined {
  return LATER_FIELD_ORDER.find((key, i) => i > afterIndex && fields[key] === undefined);
}

/** How many of the later fields the draft answers, of how many there are. */
export function laterProgress(fields: Record<string, unknown>): {
  answered: number;
  total: number;
} {
  return {
    answered: LATER_FIELD_ORDER.filter((key) => fields[key] !== undefined).length,
    total: LATER_FIELD_ORDER.length,
  };
}

/**
 * The optional fields, one per screen, in the field sheet's order (#148,
 * TD-16): asked while the person waits at the gate, each with "Ask me
 * later", which writes nothing, and "Save and continue", which saves the
 * whole document and moves on. The article 9 fields carry their consent on
 * the screen. The last screen leads to the optional e-mail, which is the
 * account's.
 */
export function LaterFieldScreen({ field }: { field: string }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const profile = useProfile();
  const index = LATER_FIELD_ORDER.indexOf(field as ProfileFieldKey);
  // Anything that is not a later field goes to the first one: a typed address, an old link.
  useEffect(() => {
    if (index < 0) router.replace(laterPath(FIRST_LATER_FIELD));
  }, [index, router]);
  // "The rest" means what is unanswered (#148): a person sent to the first
  // field who answered it already lands on the first unanswered one instead
  // (09/10/2026: Sanna opened on Kids, answered twice over). Once, on entry;
  // answering the first field here must not bounce the screen.
  const entered = useRef(false);
  const loadedFields = profile.status === "ready" ? profile.draft.fields : null;
  const key = index < 0 ? null : (LATER_FIELD_ORDER[index] as ProfileFieldKey);
  useEffect(() => {
    if (index !== 0 || !key || !loadedFields || entered.current) return;
    entered.current = true;
    if (loadedFields[key] === undefined) return;
    const next = nextUnanswered(loadedFields, 0);
    if (next) router.replace(laterPath(next));
  }, [index, key, loadedFields, router]);
  if (index < 0 || !key) return null;
  const companion = LATER_COMPANIONS[key];
  const spec = PROFILE_FIELDS[key];

  if (profile.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("profile.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (profile.status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <Text accessibilityLiveRegion="assertive">{t("profile.failed")}</Text>
          <Button onPress={() => void profile.reload()}>{t("profile.retry")}</Button>
        </View>
      </SafeAreaView>
    );
  }
  const { draft, update } = profile;
  const progress = laterProgress(draft.fields);
  const offered = !spec.specialCategory || isConsented(draft);
  // Onward to the next field without an answer; answered ones are the profile screen's to change.
  const moveOn = () => {
    const next = nextUnanswered(draft.fields, index);
    if (next) router.push(laterPath(next));
    else router.push("/account/email");
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="h1" accessibilityRole="header">
          {t("profile.later.title")}
        </Text>
        <Text variant="muted" accessibilityLiveRegion="polite">
          {t("profile.later.progress", progress)}
        </Text>
        {(index === 0 || key === nextUnanswered(draft.fields, -1)) && (
          <Text>{t("profile.later.explain")}</Text>
        )}

        {spec.specialCategory && <SpecialCategoryConsent draft={draft} update={update} />}
        {offered && <FieldEditor field={key} draft={draft} update={update} />}
        {offered && companion && <FieldEditor field={companion} draft={draft} update={update} />}

        {profile.notice?.kind === "error" && (
          <Text accessibilityLiveRegion="assertive">
            {profile.notice.code === "text_contact_details"
              ? t("profile.error.text_contact_details")
              : t("profile.error.generic")}
          </Text>
        )}
        {profile.saving && <Text accessibilityLiveRegion="polite">{t("profile.saving")}</Text>}
        <Button
          disabled={profile.saving}
          onPress={() => {
            tap();
            void profile.save().then((saved) => {
              if (saved) moveOn();
            });
          }}
        >
          {t("profile.later.next")}
        </Button>
        <Button
          variant="outline"
          disabled={profile.saving}
          onPress={() => {
            tap();
            moveOn();
          }}
        >
          {t("profile.later.skip")}
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}
