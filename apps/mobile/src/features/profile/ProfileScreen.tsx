import { CONSENT_VERSIONS, type PlainMessageKey } from "@kuutti/i18n";
import {
  BIO_MAX,
  BIO_MIN_FOR_COMPLETENESS,
  BIO_PRESETS,
  DISPLAY_NAME_MAX,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  PROMPT_ANSWER_MAX,
  PROMPT_KEYS,
  PROMPTS_MAX,
  type ProfileFieldKey,
  type ProfileFields,
  SPECIAL_CATEGORY_FIELDS,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { Fragment } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { completenessText, fieldLabelKey, optionKey, presetKey, promptKey } from "./keys";
import { type ProfileNotice, useProfile } from "./useProfile";

/** The API's refusals the screen has its own words for; anything else is the generic line. */
const ERROR_TEXT: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["text_contact_details", "profile.error.text_contact_details"],
  ["consent_required", "errors.special_category_locked"],
]);

/** The wording of the special-category consent this build rendered (ADR-010 §4, ADR-019 §4). */
const SPECIAL_CATEGORY_VERSION = CONSENT_VERSIONS.special_category;

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

  const setField = (key: ProfileFieldKey, value: unknown) => {
    const fields: Record<string, unknown> = { ...draft.fields };
    if (value === undefined) delete fields[key];
    else fields[key] = value;
    update({ fields: fields as ProfileFields });
  };
  const chosenPrompts = new Set(draft.prompts.map((p) => p.key));

  const consented = draft.specialCategoryConsent?.version === SPECIAL_CATEGORY_VERSION;
  const setConsent = (on: boolean) => {
    if (on && SPECIAL_CATEGORY_VERSION) {
      update({ specialCategoryConsent: { version: SPECIAL_CATEGORY_VERSION } });
      return;
    }
    // Withdrawing the consent takes the answers it covered with it: the API would refuse them anyway.
    const fields: Record<string, unknown> = { ...draft.fields };
    for (const key of SPECIAL_CATEGORY_FIELDS) delete fields[key];
    update({ specialCategoryConsent: null, fields: fields as ProfileFields });
  };
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
              <CardTitle>{t("profile.completeness.title")}</CardTitle>
              {profile.completeness.complete && (
                <CardDescription>{t("profile.completeness.complete")}</CardDescription>
              )}
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
            numberOfLines={4}
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
          const spec = PROFILE_FIELDS[key];
          const value = (draft.fields as Record<string, unknown>)[key];
          const label = t(fieldLabelKey(key));
          // An article 9 field is offered only behind its consent (ADR-019 §4).
          if (spec.specialCategory && !SPECIAL_CATEGORY_VERSION) return null;
          const offered = !spec.specialCategory || consented;
          return (
            <Fragment key={key}>
              {key === firstSpecial && (
                <View className="gap-2">
                  <View className="flex-row items-center justify-between gap-3">
                    <Text variant="small" className="flex-1">
                      {t("legal.special_category.title")}
                    </Text>
                    <Switch
                      accessibilityLabel={t("legal.special_category.title")}
                      checked={consented}
                      onCheckedChange={(on) => {
                        tap();
                        setConsent(on);
                      }}
                    />
                  </View>
                  <Text variant="muted">{t("legal.special_category.summary")}</Text>
                </View>
              )}
              {offered && spec.kind === "flag" && (
                <View className="flex-row items-center justify-between gap-3">
                  <Text variant="small" className="flex-1">
                    {label}
                  </Text>
                  <Switch
                    accessibilityLabel={label}
                    checked={value === true}
                    onCheckedChange={(on) => {
                      tap();
                      setField(key, on ? true : undefined);
                    }}
                  />
                </View>
              )}
              {offered && spec.kind !== "flag" && (
                <View className="gap-2">
                  <Text variant="small">{label}</Text>
                  {spec.kind === "text" && (
                    <>
                      <Input
                        accessibilityLabel={label}
                        value={typeof value === "string" ? value : ""}
                        maxLength={spec.maxLength}
                        onChangeText={(text) => setField(key, text.length > 0 ? text : undefined)}
                      />
                      <Text variant="muted">{t("profile.text.hint", { max: spec.maxLength })}</Text>
                    </>
                  )}
                  {spec.kind === "number" && (
                    <>
                      <Input
                        accessibilityLabel={label}
                        value={typeof value === "number" ? String(value) : ""}
                        inputMode="numeric"
                        maxLength={3}
                        onChangeText={(text) => {
                          const n = Number.parseInt(text, 10);
                          setField(key, Number.isNaN(n) ? undefined : n);
                        }}
                      />
                      <Text variant="muted">
                        {t("profile.number.hint", { min: spec.min, max: spec.max })}
                      </Text>
                    </>
                  )}
                  {(spec.kind === "single" || spec.kind === "multi") && (
                    <View className="flex-row flex-wrap gap-2">
                      {spec.options.map((option) => {
                        const selected =
                          spec.kind === "multi"
                            ? Array.isArray(value) && value.includes(option)
                            : value === option;
                        return (
                          <Chip
                            key={option}
                            label={t(optionKey(key, option))}
                            selected={selected}
                            onPress={() => {
                              tap();
                              if (spec.kind === "multi") {
                                const current = Array.isArray(value) ? (value as string[]) : [];
                                const next = selected
                                  ? current.filter((v) => v !== option)
                                  : current.length < spec.max
                                    ? [...current, option]
                                    : current;
                                setField(key, next.length > 0 ? next : undefined);
                              } else {
                                setField(key, selected ? undefined : option);
                              }
                            }}
                          />
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
            </Fragment>
          );
        })}

        <View className="gap-3">
          <Text variant="small">{t("profile.prompts.label")}</Text>
          <Text variant="muted">{t("profile.prompts.hint", { max: PROMPTS_MAX })}</Text>
          {draft.prompts.map((prompt) => {
            const question = t(promptKey(prompt.key));
            return (
              <View key={prompt.key} className="gap-2">
                <Text>{question}</Text>
                <Input
                  accessibilityLabel={t("profile.prompts.answer", { prompt: question })}
                  value={prompt.answer}
                  maxLength={PROMPT_ANSWER_MAX}
                  multiline
                  onChangeText={(answer) =>
                    update({
                      prompts: draft.prompts.map((p) =>
                        p.key === prompt.key ? { ...p, answer } : p,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  accessibilityLabel={t("profile.prompts.remove", { prompt: question })}
                  onPress={() => {
                    tap();
                    update({ prompts: draft.prompts.filter((p) => p.key !== prompt.key) });
                  }}
                >
                  <Text>{t("profile.prompts.removeButton")}</Text>
                </Button>
              </View>
            );
          })}
          {draft.prompts.length < PROMPTS_MAX && (
            <View className="gap-2">
              <Text variant="small">{t("profile.prompts.pick")}</Text>
              <View className="flex-row flex-wrap gap-2">
                {PROMPT_KEYS.filter((key) => !chosenPrompts.has(key)).map((key) => (
                  <Chip
                    key={key}
                    label={t(promptKey(key))}
                    selected={false}
                    onPress={() => {
                      tap();
                      update({ prompts: [...draft.prompts, { key, answer: "" }] });
                    }}
                  />
                ))}
              </View>
            </View>
          )}
        </View>

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
      </ScrollView>
    </SafeAreaView>
  );
}
