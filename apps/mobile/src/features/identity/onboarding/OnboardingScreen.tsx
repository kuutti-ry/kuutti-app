import { CONSENT_VERSIONS, formatDate, realLocale } from "@kuutti/i18n";
import {
  AGE_MAX,
  AGE_MIN,
  BIO_MIN_FOR_COMPLETENESS,
  bioOrPromptsComplete,
  type ConsentKind,
  type Gender,
  type HomeSummary,
  type HomeUpdate,
  type InvitationReward,
  type OnboardingStatus,
  PROFILE_FIELDS,
  type ProfileFields,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { type ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Choice } from "@/components/Choice";
import { KeyboardScrollView } from "@/components/KeyboardScrollView";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { PhotosScreen } from "@/features/media";
import {
  BioEditor,
  GenderChips,
  IdentityLabelChips,
  NameEditor,
  optionKey,
  PlaceChoice,
  PlacePicker,
  PromptsEditor,
  profileErrorText,
  SeeksChips,
  saveGender,
  saveHome,
  savePreferences,
  useProfile,
  useSpokenOnIos,
} from "@/features/profile";
import { fetchInvitations, InvitationStep } from "@/features/rewards";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { rememberAgreed } from "../agreements";
import { NormsAndConsents } from "../BeforeSignIn";
import { LegalTextLink } from "../LegalTextLink";
import { consentLocale, giveConsent } from "./client";
import { useOnboarding } from "./useOnboarding";

type Step =
  | "welcome"
  | "invitation"
  | "name"
  | "gender"
  | "identityLabel"
  | "seeks"
  | "intent"
  | "age"
  | "home"
  | "homeShown"
  | "photos"
  | "prompts"
  | "stuck"
  | "done";

/**
 * The screens, for "Step x of n"; the identity label shares the gender's
 * number, and what the card shows shares the home's. The welcome step and a
 * friend's invitation code count no number: the consents come before the bank
 * login (#418), and the welcome step asks them again only when they did not
 * land or a wording changed since; the code is offered once and never required
 * (#107).
 */
const STEPS: Step[] = ["name", "gender", "seeks", "intent", "age", "home", "photos", "prompts"];

/** The steps that follow another under its number. */
const NUMBERED_AS: Partial<Record<Step, Step>> = { identityLabel: "gender", homeShown: "home" };

/**
 * A friend's invitation code (#107): not asked yet, asked of the API and
 * offered, or done with for this walk (skipped, used, not for this person, or
 * a read that failed, which Settings makes up for).
 */
type InvitationOffer = "unasked" | "offered" | "done";

/** What the screen keeps between two status reads: what the API's status does not say. */
type LocalAnswers = {
  invitation: InvitationOffer;
  /** A non-binary gender was just declared: the label is offered once, before the next step. */
  labelPending: boolean;
  /** The home the API just took: what the card will say is shown once, with the choice if there is one. */
  homeShown: HomeSummary | null;
  /**
   * The seeks step started from a stored answer, and only Continue ends it:
   * to the API the consent alone answers the step, which would go with a
   * change of its answer unsaved.
   */
  seeksHeld: boolean;
  /**
   * The photos step is open, and only its Continue ends it: to the API two
   * photos answer the step, and coming back from a photo's own screen reads the
   * status again, which would move on from under somebody still choosing (#581).
   */
  photosHeld: boolean;
};

/**
 * The next question, from what the API says is missing, in the sheet's
 * order (#146, ADR-010 §10): the welcome screen with both consents first,
 * so nothing personal is asked before the person has read what happens to
 * it (ADR-010 §9), though since #418 they are given before the bank login
 * and the welcome step is the fallback (ADR-010 §15); a friend's invitation
 * code once, before the name, never required (#107); then the name, the
 * gender, whom one seeks, the intent, the age window, the home, the photos,
 * the prompts. Research is not asked (#545, ADR-010 §19).
 * A step of the contract this screen has no question for is "stuck".
 */
function nextStep(status: OnboardingStatus, local: LocalAnswers): Step {
  const missing = new Set(status.missing);
  if (missing.has("terms") || missing.has("privacy")) return "welcome";
  // Right after the welcome, while the name is still to come: a walk resumed
  // further on goes on where it was, and Settings takes the code (ADR-044).
  if (missing.has("name") && local.invitation !== "done") return "invitation";
  if (missing.has("name")) return "name";
  if (missing.has("gender")) return "gender";
  if (local.labelPending) return "identityLabel";
  if (missing.has("seeks") || local.seeksHeld) return "seeks";
  if (missing.has("intent")) return "intent";
  if (missing.has("age_window")) return "age";
  if (missing.has("home")) return "home";
  if (local.homeShown) return "homeShown";
  if (missing.has("photos") || local.photosHeld) return "photos";
  if (missing.has("prompts_or_bio")) return "prompts";
  if (missing.size > 0) return "stuck";
  return "done";
}

/**
 * The version of a wording as built into this app: what the person actually
 * read, and therefore what a consent names (ADR-010 §4). When the API has a
 * newer wording, the app asks for an update instead of recording a consent
 * for a text it never showed.
 */
function bundledVersion(kind: ConsentKind): string {
  return CONSENT_VERSIONS[kind] ?? "";
}

/** The age window the steppers start from: the person's own age, five years each way, inside the bounds. */
export function defaultAgeWindow(age: number): { min: number; max: number } {
  return {
    min: Math.min(Math.max(AGE_MIN, age - 5), AGE_MAX),
    max: Math.max(Math.min(AGE_MAX, age + 5), AGE_MIN),
  };
}

/**
 * The first minutes after the bank login (#46, #146, ADR-010): one question
 * per screen in the field sheet's order, the question its heading (#581), every
 * answer a button, the consents shown as the exact version the person accepts
 * when they are asked again, the article 9 consent on the screen that collects
 * whom one seeks, the photos step the photos screen itself. The API decides what
 * is still missing; this screen asks the next thing and leaves when nothing is.
 * The profile's own draft carries the name, the label, the intent and the
 * prompts (#47).
 */
export function OnboardingScreen() {
  const { t, locale } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const { state, busy, failed, failedCode, reload, step } = useOnboarding();
  const profile = useProfile();
  const [invitation, setInvitation] = useState<InvitationOffer>("unasked");
  const [invitationReward, setInvitationReward] = useState<InvitationReward | null>(null);
  const [seeks, setSeeks] = useState<Gender[] | null>(null);
  const [seeksHeld, setSeeksHeld] = useState(false);
  const [photosHeld, setPhotosHeld] = useState(false);
  const [labelPending, setLabelPending] = useState(false);
  const [homeShown, setHomeShown] = useState<HomeSummary | null>(null);
  const [gender, setGender] = useState<Gender | null>(null);
  const [ages, setAges] = useState<{ min: number; max: number } | null>(null);
  const current: Step | null =
    state.status === "ready"
      ? nextStep(state.onboarding, { invitation, labelPending, homeShown, seeksHeld, photosHeld })
      : null;
  // Whether a code may still be typed, asked once the consents are given,
  // which the API's answer needs (ADR-044 §6): offered if so, and otherwise,
  // or when the read fails, the walk goes on without it.
  useEffect(() => {
    if (current !== "invitation" || invitation !== "unasked") return;
    let live = true;
    fetchInvitations()
      .then((answer) => {
        if (!live) return;
        setInvitationReward(answer.reward);
        setInvitation(answer.redeemable ? "offered" : "done");
      })
      .catch(() => live && setInvitation("done"));
    return () => {
      live = false;
    };
  }, [current, invitation]);
  useEffect(() => {
    if (current === "done") router.replace("/");
  }, [current, router]);
  // Each step starts at its top: the ScrollView kept the last step's offset,
  // so a new step's title began under the status bar (10/10/2026).
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (current) scroll.current?.scrollTo({ y: 0, animated: false });
  }, [current]);
  // A stored answer is where the step starts: only an outdated consent leaves
  // one here (a withdrawal takes it), and a new wording asks everybody at once.
  const storedSeeks = state.status === "ready" ? state.onboarding.preferences.seeks : null;
  useEffect(() => {
    if (current !== "seeks" || seeks !== null) return;
    setSeeks(storedSeeks ?? []);
    setSeeksHeld(storedSeeks !== null);
  }, [current, seeks, storedSeeks]);
  // Reached once, by the status: from here on the step stands until its Continue.
  useEffect(() => {
    if (current === "photos") setPhotosHeld(true);
  }, [current]);
  const age = state.status === "ready" ? state.onboarding.age : null;
  // From when a refused change of gender is possible (#147).
  const changeFrom = state.status === "ready" ? state.onboarding.nextChange.gender : null;
  // The age step is open only while no window is stored (ADR-010 §13): a
  // withdrawal asks whom one seeks again and keeps the window, so the default
  // around the person's age is all this step ever starts from.
  useEffect(() => {
    if (current === "age" && ages === null && age !== null) setAges(defaultAgeWindow(age));
  }, [current, ages, age]);

  const setField = (key: keyof ProfileFields, value: string | undefined) => {
    const fields: Record<string, unknown> = { ...profile.draft.fields };
    if (value === undefined) delete fields[key];
    else fields[key] = value;
    profile.update({ fields: fields as ProfileFields });
  };
  /** A profile step: the draft is saved, then the status read again. */
  const saveProfileStep = () => step(() => profile.save());
  /** The home's two steps: the API's answer says what the card will say, for the second. */
  const saveHomeStep = (update: HomeUpdate) =>
    step(async () => setHomeShown(await saveHome(update)));

  const profileFailed = profile.notice?.kind === "error";
  // A change refused for its cadence is said as that (#147), an answer refused
  // for its consent too (ADR-010 §16), a code the list lacks as that (ADR-061
  // §4), a refused profile save in the profile's own words (#223), the rest as
  // a step that did not go through. iOS has no live regions, so it is spoken.
  const failure = !(failed || profileFailed)
    ? null
    : failedCode === "change_too_soon"
      ? t("errors.change_too_soon")
      : failedCode === "consent_required"
        ? t("errors.special_category_locked")
        : failedCode === "postal_code_unknown"
          ? t("errors.postal_code_unknown")
          : failed
            ? t("onboarding.failed")
            : profileErrorText(profile.notice, t);
  useSpokenOnIos(failure);

  if (
    state.status === "loading" ||
    profile.status === "loading" ||
    // The invitation's own heading comes only with the answer that offers it.
    (current === "invitation" && !(invitation === "offered" && invitationReward))
  ) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
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
          <LoadFailed
            // A status that has no step for this person (`stuck`) is no failed
            // read: it reads as "other".
            error={
              state.status === "error"
                ? state.error
                : profile.status === "error"
                  ? profile.error
                  : null
            }
            onRetry={() => {
              void reload();
              void profile.reload();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }
  // Home takes over at once (the effect above), and says what comes next.
  if (current === "done") return <SafeAreaView className="flex-1 bg-background" />;
  const { onboarding } = state;
  const { draft, update } = profile;
  const position = STEPS.indexOf(NUMBERED_AS[current] ?? current) + 1;
  if (current === "photos") {
    return (
      <PhotosScreen
        step={{
          position,
          total: STEPS.length,
          reading: busy,
          onContinue: async () => {
            const read = await step(async () => undefined);
            // Only an answer that no longer lists photos ends the step: a photo refused meanwhile
            // keeps it, and the hold with it, so the next status read moves nobody on.
            if (read && !read.missing.includes("photos")) setPhotosHeld(false);
          },
        }}
      />
    );
  }
  const chosenSeeks = seeks ?? [];
  const specialConsented =
    onboarding.consents.specialCategory === bundledVersion("special_category");
  const specialOutdated =
    bundledVersion("special_category") !== onboarding.currentVersions.special_category;

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* The home's list lies under its field: a scroll reaches it past the keyboard. */}
      <KeyboardScrollView ref={scroll} contentContainerClassName="flex-grow gap-4 p-6">
        {current !== "welcome" && current !== "invitation" && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t("onboarding.progress", { step: position, total: STEPS.length })}
          </Text>
        )}
        {failure !== null && <Text accessibilityLiveRegion="assertive">{failure}</Text>}
        {failed && failedCode === "change_too_soon" && changeFrom && (
          <Text>
            {t("onboarding.changeFrom", { date: formatDate(locale, new Date(changeFrom)) })}
          </Text>
        )}

        {current === "welcome" && (
          <View className="gap-4">
            <NormsAndConsents />
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
                    // This phone has them now: the next sign-in here goes straight to the bank (#418).
                    await rememberAgreed();
                  });
                }}
              >
                {t("onboarding.welcome.accept")}
              </Button>
            )}
          </View>
        )}

        {current === "invitation" && invitationReward && (
          <InvitationStep reward={invitationReward} onDone={() => setInvitation("done")} />
        )}

        {current === "name" && (
          <View className="gap-4">
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.name.title")}
            </Text>
            <NameEditor draft={draft} update={update} />
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
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.gender.title")}
            </Text>
            <Text>{t("onboarding.gender.explain")}</Text>
            <GenderChips chosen={gender} onChoose={setGender} />
            <Button
              disabled={busy || gender === null}
              onPress={() => {
                tap();
                if (!gender) return;
                // The label is offered after a non-binary gender only, by design (ADR-019 §1).
                setLabelPending(gender === "non_binary");
                void step(() => saveGender(gender));
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "identityLabel" && (
          <View className="gap-4">
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.identityLabel.title")}
            </Text>
            <Text>{t("onboarding.identityLabel.explain")}</Text>
            <IdentityLabelChips
              chosen={draft.fields.identityLabel}
              onChange={(label) => setField("identityLabel", label)}
            />
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
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.seeks.title")}
            </Text>
            <Text>{t("onboarding.seeks.explain")}</Text>
            <SeeksChips chosen={chosenSeeks} onChange={setSeeks} />
            {/* Article 9: the consent on the screen that collects the answer (ADR-019 §4). */}
            <Card>
              <CardHeader>
                <CardTitle>{t("legal.special_category.title")}</CardTitle>
              </CardHeader>
              <CardContent className="gap-2">
                <Text>{t("legal.special_category.summary")}</Text>
                {realLocale(locale) !== "fi" && (
                  <Text variant="muted">{t("onboarding.consents.binding")}</Text>
                )}
                <LegalTextLink kind="special_category" />
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
                        // Recorded as soon as it is given; Settings withdraws it.
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
            {/* Saved on leaving the screen (ADR-010 §13): an app closed before the ages keeps it. */}
            <Button
              disabled={busy || chosenSeeks.length === 0 || !specialConsented}
              onPress={() => {
                tap();
                void step(async () => {
                  await savePreferences({ seeks: chosenSeeks });
                  setSeeksHeld(false);
                });
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "intent" && (
          <View className="gap-4">
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.intent.title")}
            </Text>
            <Text>{t("onboarding.intent.explain")}</Text>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={t("onboarding.intent.title")}
              className="gap-2"
            >
              {PROFILE_FIELDS.intent.options.map((option) => (
                <Choice
                  key={option}
                  label={t(optionKey("intent", option))}
                  chosen={draft.fields.intent === option}
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
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.age.title")}
            </Text>
            {/* One above the other, as on What you seek: side by side, with the minus and the plus further from the number, they overflow a small phone (#581). */}
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
            <Button
              disabled={busy}
              onPress={() => {
                tap();
                void step(() => savePreferences({ ageWindow: ages }));
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "home" && (
          <View className="gap-4">
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.home.title")}
            </Text>
            <Text>{t("profile.place.explain")}</Text>
            <PlacePicker
              busy={busy}
              refused={failedCode === "postal_code_unknown"}
              onPick={(postalCode) => void saveHomeStep({ postalCode })}
            />
          </View>
        )}

        {/* Local, as the identity label is: an app closed here leaves the town, and the profile's row still offers this. */}
        {current === "homeShown" && homeShown && (
          <View className="gap-4">
            <PlaceChoice
              heading="h1"
              home={homeShown}
              busy={busy}
              onChoose={(showArea) => void saveHomeStep({ showArea })}
            />
            {/* Through `step`, so that a choice that failed is not said on the step after. */}
            <Button
              disabled={busy}
              onPress={() => {
                tap();
                void step(async () => setHomeShown(null));
              }}
            >
              {t("onboarding.continue")}
            </Button>
          </View>
        )}

        {current === "prompts" && (
          <View className="gap-4">
            <Text variant="h1" accessibilityRole="header">
              {t("onboarding.prompts.title")}
            </Text>
            <Text>{t("onboarding.prompts.explain", { min: BIO_MIN_FOR_COMPLETENESS })}</Text>
            {/* The bio or a ready line, as in the basics: either finishes this step (#239). */}
            <BioEditor draft={draft} update={update} />
            <Text variant="small">{t("profile.prompts.label")}</Text>
            <PromptsEditor draft={draft} update={update} />
            {/* Waits for words that count (#223): a save of fewer would leave the step where it is, saying nothing. */}
            <Button
              disabled={
                busy ||
                profile.saving ||
                !bioOrPromptsComplete({
                  bio: draft.bio,
                  bioPreset: draft.bioPreset,
                  answeredPrompts: draft.prompts.filter((p) => p.answer.trim().length > 0).length,
                })
              }
              onPress={() => {
                tap();
                void saveProfileStep();
              }}
            >
              {t("onboarding.prompts.save")}
            </Button>
          </View>
        )}
      </KeyboardScrollView>
    </SafeAreaView>
  );
}
