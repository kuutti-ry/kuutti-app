import { CONSENT_VERSIONS, formatDate, type PlainMessageKey } from "@kuutti/i18n";
import {
  AGE_MAX,
  AGE_MIN,
  BIO_MAX,
  BIO_MIN_FOR_COMPLETENESS,
  type ConsentKind,
  DISPLAY_NAME_MAX,
  GENDERS,
  type Gender,
  type OnboardingStatus,
  type PondSummary,
  PROFILE_FIELDS,
  type ProfileFields,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { choosePond, fetchPonds, pondName } from "@/features/pond";
import { optionKey, PromptsEditor, useProfile } from "@/features/profile";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { consentLocale, declareGender, giveConsent, savePreferences } from "./client";
import { useOnboarding } from "./useOnboarding";

type Step =
  | "welcome"
  | "name"
  | "gender"
  | "identityLabel"
  | "seeks"
  | "intent"
  | "age"
  | "pond"
  | "photos"
  | "prompts"
  | "research"
  | "stuck"
  | "done";

/** The screens, for "Step x of n"; the identity label shares the gender's number. The pond is asked only where there is more than one (#174). */
const STEPS: Step[] = [
  "welcome",
  "name",
  "gender",
  "seeks",
  "intent",
  "age",
  "pond",
  "photos",
  "prompts",
  "research",
];

/** What the screen keeps between two status reads: the answers the API takes together with a later one. */
export type LocalAnswers = {
  researchOffered: boolean;
  /** The seek screen was left with its answer, which is saved with the age window (one PUT /preferences, ADR-010 §2). */
  seeksDone: boolean;
  /** A non-binary gender was just declared: the label is offered once, before the next step. */
  labelPending: boolean;
};

/**
 * The next question, from what the API says is missing, in the sheet's
 * order (#146, ADR-010 §10): the welcome screen with both consents first,
 * so nothing personal is asked before the person has read what happens to
 * it (ADR-010 §9); then the name, the gender, whom one seeks, the intent,
 * the age window, the photos, the prompts; research once, never required.
 * A step the screen cannot ask (a pond without a default) is "stuck".
 */
export function nextStep(status: OnboardingStatus, local: LocalAnswers): Step {
  const missing = new Set(status.missing);
  if (missing.has("terms") || missing.has("privacy")) return "welcome";
  if (missing.has("name")) return "name";
  if (missing.has("gender")) return "gender";
  if (local.labelPending) return "identityLabel";
  if (missing.has("seeks") && !local.seeksDone) return "seeks";
  if (missing.has("intent")) return "intent";
  if (missing.has("age_window") || missing.has("seeks")) return "age";
  // Open only where more than one pond exists (#174, ADR-010 §12); with one, the API assigned it.
  if (missing.has("pond")) return "pond";
  if (missing.has("photos")) return "photos";
  if (missing.has("prompts_or_bio")) return "prompts";
  if (!status.consents.research && !local.researchOffered) return "research";
  if (missing.size > 0) return "stuck";
  return "done";
}

/**
 * The version of a wording as built into this app: what the person actually
 * read, and therefore what a consent names (ADR-010 §4). When the API has a
 * newer wording, the app asks for an update instead of recording a consent
 * for a text it never showed.
 */
export function bundledVersion(kind: ConsentKind): string {
  return CONSENT_VERSIONS[kind] ?? "";
}

/** The age window the steppers start from: the person's own age, five years each way, inside the bounds. */
export function defaultAgeWindow(age: number): { min: number; max: number } {
  return {
    min: Math.min(Math.max(AGE_MIN, age - 5), AGE_MAX),
    max: Math.max(Math.min(AGE_MAX, age + 5), AGE_MIN),
  };
}

const GENDER_TEXT: Record<Gender, PlainMessageKey> = {
  woman: "onboarding.gender.woman",
  man: "onboarding.gender.man",
  non_binary: "onboarding.gender.non_binary",
};
const SEEKS_TEXT: Record<Gender, PlainMessageKey> = {
  woman: "onboarding.seeks.woman",
  man: "onboarding.seeks.man",
  non_binary: "onboarding.seeks.non_binary",
};

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
 * The first minutes after the bank login (#46, #146, ADR-010): one question
 * per screen in the field sheet's order, every answer a button, the consents
 * shown as the exact version the person accepts, the article 9 consent on
 * the screen that collects whom one seeks, the research opt-in on its own.
 * The API decides what is still missing; this screen asks the next thing and
 * leaves when nothing is. The profile's own draft carries the name, the
 * label, the intent and the prompts (#47).
 */
export function OnboardingScreen() {
  const { t, locale } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const { state, busy, failed, failedCode, reload, step } = useOnboarding();
  const profile = useProfile();
  const [researchOffered, setResearchOffered] = useState(false);
  const [seeks, setSeeks] = useState<Gender[]>([]);
  const [seeksDone, setSeeksDone] = useState(false);
  const [labelPending, setLabelPending] = useState(false);
  const [gender, setGender] = useState<Gender | null>(null);
  const [ages, setAges] = useState<{ min: number; max: number } | null>(null);

  const current: Step | null =
    state.status === "ready"
      ? nextStep(state.onboarding, { researchOffered, seeksDone, labelPending })
      : null;
  useEffect(() => {
    if (current === "done") router.replace("/");
  }, [current, router]);
  // Each step starts at its top: the ScrollView kept the last step's offset,
  // so a new step's title began under the status bar (10/10/2026).
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (current) scroll.current?.scrollTo({ y: 0, animated: false });
  }, [current]);
  const age = state.status === "ready" ? state.onboarding.age : null;
  // From when a refused change is possible (#147): the gender's for the gender
  // step, whom one seeks for the steps that save it (seeks, the age window).
  const changeFrom =
    state.status === "ready"
      ? state.onboarding.nextChange[current === "gender" ? "gender" : "seeks"]
      : null;
  // The stored window first: a withdrawal of the sensitive-answers consent asks
  // whom one seeks again, and the ages with it (#204), and the person keeps
  // the window they had. The default around their age is for the first time.
  const stored = state.status === "ready" ? state.onboarding.preferences.ageWindow : null;
  useEffect(() => {
    if (current === "age" && ages === null && age !== null) {
      setAges(stored ?? defaultAgeWindow(age));
    }
  }, [current, ages, age, stored]);
  // The ponds to choose from, read once the step is reached (#174): null while loading, [] when the read failed.
  const [ponds, setPonds] = useState<PondSummary[] | null>(null);
  useEffect(() => {
    if (current !== "pond" || ponds !== null) return;
    let live = true;
    fetchPonds()
      .then((list) => live && setPonds(list.ponds.filter((pond) => pond.parentId === null)))
      .catch(() => live && setPonds([]));
    return () => {
      live = false;
    };
  }, [current, ponds]);

  const setField = (key: keyof ProfileFields, value: string | undefined) => {
    const fields: Record<string, unknown> = { ...profile.draft.fields };
    if (value === undefined) delete fields[key];
    else fields[key] = value;
    profile.update({ fields: fields as ProfileFields });
  };
  /** A profile step: the draft is saved, then the status read again. */
  const saveProfileStep = () => step(() => profile.save());

  if (state.status === "loading" || profile.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("onboarding.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (
    state.status === "error" ||
    profile.status === "error" ||
    current === null ||
    current === "stuck"
  ) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <Text accessibilityLiveRegion="assertive">{t("onboarding.failed")}</Text>
          <Button
            onPress={() => {
              void reload();
              void profile.reload();
            }}
          >
            {t("onboarding.retry")}
          </Button>
        </View>
      </SafeAreaView>
    );
  }
  const { onboarding } = state;
  const { draft, update } = profile;
  const position = STEPS.indexOf(current === "identityLabel" ? "gender" : current) + 1;
  const specialConsented =
    onboarding.consents.specialCategory === bundledVersion("special_category");
  const specialOutdated =
    bundledVersion("special_category") !== onboarding.currentVersions.special_category;
  const profileFailed = profile.notice?.kind === "error";

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        ref={scroll}
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="h1" accessibilityRole="header">
          {t("onboarding.title")}
        </Text>
        {current !== "done" && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t("onboarding.progress", { step: position, total: STEPS.length })}
          </Text>
        )}
        {(failed || profileFailed) && (
          <Text accessibilityLiveRegion="assertive">
            {/* A change refused for its cadence is said as that (#147), the rest as a step that did not go through. */}
            {failedCode === "change_too_soon"
              ? t("errors.change_too_soon")
              : t("onboarding.failed")}
          </Text>
        )}
        {failed && failedCode === "change_too_soon" && changeFrom && (
          <Text>
            {t("onboarding.changeFrom", { date: formatDate(locale, new Date(changeFrom)) })}
          </Text>
        )}

        {current === "welcome" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.welcome.title")}</Text>
            <View className="gap-2">
              <Text>{t("onboarding.welcome.norm1")}</Text>
              <Text>{t("onboarding.welcome.norm2")}</Text>
              <Text>{t("onboarding.welcome.norm3")}</Text>
              <Text>{t("onboarding.welcome.norm4")}</Text>
            </View>
            <Text>{t("onboarding.consents.explain")}</Text>
            {locale !== "fi" && <Text variant="muted">{t("onboarding.consents.binding")}</Text>}
            {(["terms", "privacy"] as const).map((kind) => (
              <Card key={kind}>
                <CardHeader>
                  <CardTitle>
                    {t(kind === "terms" ? "legal.terms.title" : "legal.privacy.title")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="gap-2">
                  <Text>
                    {t(kind === "terms" ? "legal.terms.summary" : "legal.privacy.summary")}
                  </Text>
                  <Text variant="muted">
                    {t("onboarding.consents.version", { version: bundledVersion(kind) })}
                  </Text>
                </CardContent>
              </Card>
            ))}
            {(["terms", "privacy"] as const).some(
              (kind) => bundledVersion(kind) !== onboarding.currentVersions[kind],
            ) ? (
              <Text accessibilityLiveRegion="polite">{t("onboarding.consents.outdatedApp")}</Text>
            ) : (
              <Button
                disabled={busy}
                onPress={() => {
                  tap();
                  void step(async () => {
                    for (const kind of ["terms", "privacy"] as ConsentKind[]) {
                      await giveConsent(kind, bundledVersion(kind), consentLocale(locale));
                    }
                  });
                }}
              >
                {t("onboarding.welcome.accept")}
              </Button>
            )}
          </View>
        )}

        {current === "name" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.name.title")}</Text>
            <Text>{t("onboarding.name.explain")}</Text>
            <Input
              accessibilityLabel={t("profile.displayName.label")}
              value={draft.displayName}
              maxLength={DISPLAY_NAME_MAX}
              autoCapitalize="words"
              onChangeText={(displayName) => update({ displayName })}
            />
            <Button
              disabled={busy || profile.saving || draft.displayName.trim().length === 0}
              onPress={() => {
                tap();
                void saveProfileStep();
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "gender" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.gender.title")}</Text>
            <Text>{t("onboarding.gender.explain")}</Text>
            <View className="flex-row flex-wrap gap-2">
              {GENDERS.map((option) => (
                <Chip
                  key={option}
                  label={t(GENDER_TEXT[option])}
                  selected={gender === option}
                  onPress={() => {
                    tap();
                    setGender(option);
                  }}
                />
              ))}
            </View>
            <Button
              disabled={busy || gender === null}
              onPress={() => {
                tap();
                if (!gender) return;
                // The label is offered after a non-binary gender only, by design (ADR-019 §1).
                setLabelPending(gender === "non_binary");
                void step(() => declareGender(gender));
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "identityLabel" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.identityLabel.title")}</Text>
            <Text>{t("onboarding.identityLabel.explain")}</Text>
            <View className="flex-row flex-wrap gap-2">
              {PROFILE_FIELDS.identityLabel.options.map((option) => (
                <Chip
                  key={option}
                  label={t(optionKey("identityLabel", option))}
                  selected={draft.fields.identityLabel === option}
                  onPress={() => {
                    tap();
                    setField(
                      "identityLabel",
                      draft.fields.identityLabel === option ? undefined : option,
                    );
                  }}
                />
              ))}
            </View>
            <Button
              disabled={busy || profile.saving || draft.fields.identityLabel === undefined}
              onPress={() => {
                tap();
                setLabelPending(false);
                void saveProfileStep();
              }}
            >
              {t("onboarding.continue")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onPress={() => {
                tap();
                setField("identityLabel", undefined);
                setLabelPending(false);
              }}
            >
              {t("onboarding.identityLabel.skip")}
            </Button>
          </View>
        )}

        {current === "seeks" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.seeks.title")}</Text>
            <Text>{t("onboarding.seeks.explain")}</Text>
            <View className="flex-row flex-wrap gap-2">
              {GENDERS.map((option) => (
                <Chip
                  key={option}
                  label={t(SEEKS_TEXT[option])}
                  selected={seeks.includes(option)}
                  onPress={() => {
                    tap();
                    setSeeks((s) =>
                      s.includes(option) ? s.filter((g) => g !== option) : [...s, option],
                    );
                  }}
                />
              ))}
              <Chip
                label={t("onboarding.seeks.anyone")}
                selected={seeks.length === GENDERS.length}
                onPress={() => {
                  tap();
                  setSeeks([...GENDERS]);
                }}
              />
            </View>
            {/* Article 9: the consent on the screen that collects the answer (ADR-019 §4). */}
            <Card>
              <CardHeader>
                <CardTitle>{t("legal.special_category.title")}</CardTitle>
              </CardHeader>
              <CardContent className="gap-2">
                <Text>{t("legal.special_category.summary")}</Text>
                {locale !== "fi" && <Text variant="muted">{t("onboarding.consents.binding")}</Text>}
                <Text variant="muted">
                  {t("onboarding.consents.version", {
                    version: bundledVersion("special_category"),
                  })}
                </Text>
                {specialOutdated ? (
                  <Text accessibilityLiveRegion="polite">
                    {t("onboarding.consents.outdatedApp")}
                  </Text>
                ) : (
                  <View className="flex-row items-center justify-between gap-3">
                    <Text variant="small" className="flex-1">
                      {t("onboarding.seeks.allow")}
                    </Text>
                    <Switch
                      accessibilityLabel={t("onboarding.seeks.allow")}
                      checked={specialConsented}
                      disabled={busy || specialConsented}
                      onCheckedChange={(on) => {
                        tap();
                        // Recorded as soon as it is given, like the research opt-in; the account card withdraws it.
                        if (on && !specialConsented) {
                          void step(() =>
                            giveConsent(
                              "special_category",
                              bundledVersion("special_category"),
                              consentLocale(locale),
                            ),
                          );
                        }
                      }}
                    />
                  </View>
                )}
              </CardContent>
            </Card>
            {/* Seeks and the age window are one save: this button only moves on. */}
            <Button
              disabled={busy || seeks.length === 0 || !specialConsented}
              onPress={() => {
                tap();
                setSeeksDone(true);
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "intent" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.intent.title")}</Text>
            <Text>{t("onboarding.intent.explain")}</Text>
            <View className="flex-row flex-wrap gap-2">
              {PROFILE_FIELDS.intent.options.map((option) => (
                <Chip
                  key={option}
                  label={t(optionKey("intent", option))}
                  selected={draft.fields.intent === option}
                  onPress={() => {
                    tap();
                    setField("intent", option);
                  }}
                />
              ))}
            </View>
            <Button
              disabled={busy || profile.saving || draft.fields.intent === undefined}
              onPress={() => {
                tap();
                void saveProfileStep();
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "age" && ages && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.age.title")}</Text>
            <Text>{t("onboarding.age.explain", { min: AGE_MIN, max: AGE_MAX })}</Text>
            <View className="flex-row gap-3">
              <Stepper
                label={t("onboarding.age.youngest")}
                value={ages.min}
                shown={t("onboarding.age.years", { years: ages.min })}
                downLabel={t("onboarding.age.youngestDown")}
                upLabel={t("onboarding.age.youngestUp")}
                canDown={ages.min > AGE_MIN}
                canUp={ages.min < ages.max}
                onChange={(min) => setAges({ ...ages, min })}
              />
              <Stepper
                label={t("onboarding.age.oldest")}
                value={ages.max}
                shown={t("onboarding.age.years", { years: ages.max })}
                downLabel={t("onboarding.age.oldestDown")}
                upLabel={t("onboarding.age.oldestUp")}
                canDown={ages.max > ages.min}
                canUp={ages.max < AGE_MAX}
                onChange={(max) => setAges({ ...ages, max })}
              />
            </View>
            <Button
              disabled={busy || seeks.length === 0}
              onPress={() => {
                tap();
                void step(() => savePreferences({ seeks, ageWindow: ages }));
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "pond" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.pond.title")}</Text>
            <Text>{t("onboarding.pond.explain")}</Text>
            {ponds === null && (
              <Text accessibilityLiveRegion="polite">{t("onboarding.loading")}</Text>
            )}
            {ponds !== null && ponds.length === 0 && (
              <View className="gap-3">
                <Text accessibilityLiveRegion="assertive">{t("onboarding.failed")}</Text>
                <Button
                  variant="outline"
                  onPress={() => {
                    tap();
                    setPonds(null);
                  }}
                >
                  {t("onboarding.retry")}
                </Button>
              </View>
            )}
            {ponds !== null && ponds.length > 0 && (
              <View className="flex-row flex-wrap gap-2">
                {ponds.map((pond) => (
                  <Button
                    key={pond.id}
                    variant="outline"
                    disabled={busy}
                    onPress={() => {
                      tap();
                      void step(() => choosePond(pond.id));
                    }}
                  >
                    {pondName(t, pond)}
                  </Button>
                ))}
              </View>
            )}
          </View>
        )}

        {current === "photos" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.photos.title")}</Text>
            <Text>{t("onboarding.photos.explain")}</Text>
            <Button
              onPress={() => {
                tap();
                router.push("/photos");
              }}
            >
              {t("onboarding.photos.open")}
            </Button>
          </View>
        )}

        {current === "prompts" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.prompts.title")}</Text>
            <Text>{t("onboarding.prompts.explain", { min: BIO_MIN_FOR_COMPLETENESS })}</Text>
            <View className="gap-2">
              <Text variant="small">{t("profile.bio.label")}</Text>
              <Input
                accessibilityLabel={t("profile.bio.label")}
                value={draft.bio ?? ""}
                maxLength={BIO_MAX}
                multiline
                // Room for four lines and more as the bio grows (as on the profile screen).
                className="min-h-28"
                onChangeText={(text) =>
                  update({ bio: text.length > 0 ? text : null, bioPreset: null })
                }
              />
            </View>
            <PromptsEditor draft={draft} update={update} />
            <Button
              disabled={busy || profile.saving}
              onPress={() => {
                tap();
                void saveProfileStep();
              }}
            >
              {t("onboarding.prompts.save")}
            </Button>
          </View>
        )}

        {current === "research" && (
          <View className="gap-4">
            <Text variant="h2">{t("onboarding.research.title")}</Text>
            {locale !== "fi" && <Text variant="muted">{t("onboarding.consents.binding")}</Text>}
            <Card>
              <CardHeader>
                <CardTitle>{t("legal.research.title")}</CardTitle>
              </CardHeader>
              <CardContent className="gap-2">
                <Text>{t("legal.research.summary")}</Text>
                <Text variant="muted">
                  {t("onboarding.consents.version", { version: bundledVersion("research") })}
                </Text>
              </CardContent>
            </Card>
            <Text variant="muted">{t("onboarding.research.later")}</Text>
            {bundledVersion("research") !== onboarding.currentVersions.research ? (
              <Text accessibilityLiveRegion="polite">{t("onboarding.consents.outdatedApp")}</Text>
            ) : (
              <Button
                disabled={busy}
                onPress={() => {
                  tap();
                  // A recorded yes shows up in the status; only "Not now" marks the offer as made.
                  void step(() =>
                    giveConsent("research", bundledVersion("research"), consentLocale(locale)),
                  );
                }}
              >
                {t("onboarding.research.yes")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onPress={() => {
                tap();
                setResearchOffered(true);
              }}
            >
              {t("onboarding.research.no")}
            </Button>
          </View>
        )}

        {current === "done" && <Text accessibilityLiveRegion="polite">{t("onboarding.done")}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}
