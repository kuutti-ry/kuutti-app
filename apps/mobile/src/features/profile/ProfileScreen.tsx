import type { PlainMessageKey } from "@kuutti/i18n";
import {
  BIO_MAX,
  BIO_MIN_FOR_COMPLETENESS,
  BIO_PRESETS,
  DISPLAY_NAME_MAX,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
} from "@kuutti/schema";
import { useNavigation, useRouter } from "expo-router";
// Expo Router 57 vendors React Navigation and exposes the hook that holds a
// native stack's swipe-back only from the vendored core: a plain beforeRemove
// listener cannot stop a native removal (the screen leaves the stack natively
// while JS keeps it; 09/10/2026, the simulator).
import { usePreventRemove } from "expo-router/build/react-navigation/core";
import { Fragment, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { DEAL_BREAKERS_PATH } from "./DealBreakersScreen";
import { FieldEditor, SpecialCategoryNote } from "./FieldEditor";
import { completenessText, presetKey } from "./keys";
import { FIRST_LATER_FIELD, laterPath } from "./later/LaterFieldScreen";
import { PromptsEditor } from "./PromptsEditor";
import { type ProfileNotice, useProfile } from "./useProfile";

type LeaveAction = Parameters<Parameters<typeof usePreventRemove>[1]>[0]["data"]["action"];

/** The API's refusals the screen has its own words for; anything else is the generic line. */
const ERROR_TEXT: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["text_contact_details", "profile.error.text_contact_details"],
  ["consent_required", "errors.special_category_locked"],
]);

function noticeText(notice: NonNullable<ProfileNotice>, t: ReturnType<typeof useT>["t"]): string {
  if (notice.kind === "saved") return t("profile.saved");
  return t(ERROR_TEXT.get(notice.code ?? "") ?? "profile.error.generic");
}

/** One choice: a button that says whether it is chosen, never a colour alone. */
function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={selected ? "default" : "outline"}
      accessibilityState={{ selected }}
      onPress={onPress}
    >
      {label}
    </Button>
  );
}

/**
 * The profile as the person writes it (#47, ADR-009, ADR-019): a name, a bio
 * or a placeholder line, the fields of the registry (choices as chips, a
 * number, a text, a setting as a switch), the article 9 fields behind their
 * consent, up to three prompts with short answers, and the checklist of what
 * the card still needs. Every decision is a button; every control carries its
 * label (CLAUDE.md Accessibility). The screens of #148 take the optional
 * fields one at a time; this is the whole document on one page.
 */
export function ProfileScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const profile = useProfile();
  const { draft, update } = profile;
  const navigation = useNavigation();
  // The document saves whole, on Save, and the screen has no header: the back
  // gesture was the only way out and lost unsaved edits without a word
  // (09/10/2026, Kerttu's smoking answer). Leaving with edits asks first; the
  // action handed back remembers it was held here, so dispatching it leaves.
  const [leaving, setLeaving] = useState<LeaveAction | null>(null);
  usePreventRemove(profile.dirty, ({ data }) => setLeaving(data.action));

  const firstSpecial = PROFILE_FIELD_KEYS.find((key) => PROFILE_FIELDS[key].specialCategory);

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

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="h1" accessibilityRole="header">
          {t("profile.title")}
        </Text>
        <Text>{t("profile.explain")}</Text>

        {profile.completeness && (
          <Card>
            <CardHeader>
              <CardTitle>
                {profile.completeness.complete
                  ? t("profile.completeness.complete")
                  : t("profile.completeness.title")}
              </CardTitle>
            </CardHeader>
            {!profile.completeness.complete && (
              <CardContent className="gap-1">
                {profile.completeness.missing.map((item) => (
                  <Text key={item}>{completenessText(t, item)}</Text>
                ))}
              </CardContent>
            )}
          </Card>
        )}

        <View className="gap-2">
          <Text variant="small">{t("profile.displayName.label")}</Text>
          <Input
            accessibilityLabel={t("profile.displayName.label")}
            value={draft.displayName}
            maxLength={DISPLAY_NAME_MAX}
            autoCapitalize="words"
            onChangeText={(displayName) => update({ displayName })}
          />
          <Text variant="muted">{t("profile.displayName.hint", { max: DISPLAY_NAME_MAX })}</Text>
        </View>

        <View className="gap-2">
          <Text variant="small">{t("profile.bio.label")}</Text>
          <Input
            accessibilityLabel={t("profile.bio.label")}
            value={draft.bio ?? ""}
            maxLength={BIO_MAX}
            multiline
            // Room for four lines and more as the bio grows: a capped field scrolled
            // its start out of sight at large text sizes (10/10/2026).
            className="min-h-28"
            onChangeText={(text) =>
              update({
                bio: text.length > 0 ? text : null,
                bioPreset: text.length > 0 ? null : draft.bioPreset,
              })
            }
          />
          <Text variant="muted">{t("profile.bio.hint", { min: BIO_MIN_FOR_COMPLETENESS })}</Text>
          <Text variant="small">{t("profile.bio.orPreset")}</Text>
          <View className="flex-row flex-wrap gap-2">
            {BIO_PRESETS.map((preset) => (
              <Chip
                key={preset}
                label={t(presetKey(preset))}
                selected={draft.bioPreset === preset}
                onPress={() => {
                  tap();
                  update(
                    draft.bioPreset === preset
                      ? { bioPreset: null }
                      : { bioPreset: preset, bio: null },
                  );
                }}
              />
            ))}
          </View>
        </View>

        {PROFILE_FIELD_KEYS.map((key) => {
          // The identity label is offered after a non-binary gender only, in
          // onboarding (the registry's rule, #146); here it shows when it was
          // given, to change or clear it, and is not offered to everyone.
          if (key === "identityLabel" && draft.fields.identityLabel === undefined) return null;
          // The article 9 fields stand under the note on their consent (ADR-019 §4, #204):
          // anyone active gave it at the seeks step; Settings is where it is withdrawn.
          return (
            <Fragment key={key}>
              {key === firstSpecial && <SpecialCategoryNote />}
              <FieldEditor field={key} draft={draft} update={update} />
            </Fragment>
          );
        })}

        <PromptsEditor draft={draft} update={update} />

        {profile.notice && (
          <Text accessibilityLiveRegion="assertive">{noticeText(profile.notice, t)}</Text>
        )}
        {profile.saving && <Text accessibilityLiveRegion="polite">{t("profile.saving")}</Text>}
        <Button
          disabled={profile.saving}
          onPress={() => {
            tap();
            void profile.save();
          }}
        >
          {t("profile.save")}
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            tap();
            router.push("/profile/card");
          }}
        >
          {t("profile.card.open")}
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            tap();
            router.push(laterPath(FIRST_LATER_FIELD));
          }}
        >
          {t("profile.later.open")}
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            tap();
            router.push(DEAL_BREAKERS_PATH);
          }}
        >
          {t("profile.dealBreakers.open")}
        </Button>
      </ScrollView>

      <Dialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <DialogContent closeLabel={t("profile.discard.close")}>
          <DialogHeader>
            <DialogTitle>{t("profile.discard.title")}</DialogTitle>
            <DialogDescription>{t("profile.discard.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setLeaving(null)}>
              {t("profile.discard.keep")}
            </Button>
            <Button
              variant="destructive"
              onPress={() => {
                const action = leaving;
                setLeaving(null);
                if (action) navigation.dispatch(action);
              }}
            >
              {t("profile.discard.leave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SafeAreaView>
  );
}
