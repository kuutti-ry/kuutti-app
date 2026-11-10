import type { Gender } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import Eye from "lucide-react-native/icons/eye";
import { useCallback, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailedScreen, LoadingScreen } from "@/components/LoadFailed";
import { type Row, RowGroup } from "@/components/RowGroup";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { listPhotos } from "@/features/media";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchOwnGender } from "./client";
import { GENDER_PATH } from "./gender/GenderScreen";
import { completenessText, genderKey, shownPlaceName } from "./keys";
import { FIRST_LATER_FIELD, laterPath, laterProgress } from "./later/LaterFieldScreen";
import { NeededNote } from "./NeededNote";
import { ProgressMark, progressWords } from "./ProgressMark";
import { isDone, type Progress, photoProgress, sectionProgress } from "./progress";
import { LISTED_SECTIONS, sectionHintKey, sectionPath, sectionTitleKey } from "./sections";
import { SEEK_PATH } from "./seek/SeekScreen";
import { useProfile } from "./useProfile";

/** A row of the profile's list with how far its part is filled: the mark drawn, the words heard. */
function filled(
  t: ReturnType<typeof useT>["t"],
  row: Row,
  progress: Progress | null | undefined,
  words?: string,
): Row {
  if (!progress) return row;
  return {
    ...row,
    mark: <ProgressMark progress={progress} />,
    value: words ?? progressWords(t, progress),
  };
}

/**
 * The approved photos, for the photos row's mark; null until known, and when
 * the list could not be read: the row then shows no mark, the photos screen
 * says what failed. Read again whenever the list is back in front.
 */
function useApprovedPhotos(): [number | null, () => void] {
  const [approved, setApproved] = useState<number | null>(null);
  const read = useCallback(() => {
    listPhotos().then(
      (list) => setApproved(list.photos.filter((p) => p.state === "approved").length),
      () => setApproved(null),
    );
  }, []);
  return [approved, read];
}

/**
 * The gender, for its row; null until known, and when it could not be read:
 * the row then shows its title alone, and its screen says what failed. Read
 * again whenever the list is back in front.
 */
function useOwnGenderRow(): [Gender | null, () => void] {
  const [gender, setGender] = useState<Gender | null>(null);
  const read = useCallback(() => {
    fetchOwnGender().then(
      (own) => setGender(own.gender),
      () => setGender(null),
    );
  }, []);
  return [gender, read];
}

/**
 * The profile as a list (#227, ADR-009, ADR-019): the eye at the top that
 * opens the card as others see it, what the card still needs (said only
 * while something is missing, #239), then the
 * profile's parts, each with how far it is filled: the photos, the home
 * (ADR-061) and the gender (#552), which are never unfilled and carry their
 * answer instead, the sections (each its own screen that saves on leaving,
 * and what it holds heard as the row's hint, never drawn, #581), What you seek
 * (#542) and, while a later question is unanswered, the later screens (#148). Nothing is
 * edited here, so there is nothing to save; the list reads the profile and
 * the photos again when a screen hands back, and the marks follow.
 */
export function ProfileScreen() {
  const { t, locale } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const profile = useProfile();
  const { reload } = profile;
  const [approvedPhotos, readPhotos] = useApprovedPhotos();
  const [gender, readGender] = useOwnGenderRow();
  // The first focus is the mount, which the hook reads already.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
      readPhotos();
      readGender();
    }, [reload, readPhotos, readGender]),
  );
  const open = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };
  if (profile.status === "loading") {
    return <LoadingScreen />;
  }
  if (profile.status === "error") {
    return (
      <LoadFailedScreen
        error={profile.error}
        onRetry={() => {
          readPhotos();
          readGender();
          void profile.reload();
        }}
      />
    );
  }

  const later = laterProgress(profile.saved.fields);
  const photos = approvedPhotos === null ? undefined : photoProgress(approvedPhotos);
  const missing = profile.completeness?.complete === false ? profile.completeness.missing : [];
  const genderWord = gender ? t(genderKey(gender)) : undefined;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={t("profile.title")} backLabel={t("profile.back")}>
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel={t("profile.card.open")}
          onPress={open("/profile/card")}
        >
          <Icon as={Eye} />
        </Button>
      </ScreenHeader>
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        {/* Said only while the card cannot be shown, with what it lacks (#239). */}
        {missing.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("profile.completeness.title")}</CardTitle>
            </CardHeader>
            <CardContent className="gap-1">
              {missing.map((item) => (
                <Text key={item}>{completenessText(t, item)}</Text>
              ))}
            </CardContent>
          </Card>
        )}

        <RowGroup
          rows={[
            filled(
              t,
              {
                key: "photos",
                title: t("profile.section.photos.title"),
                needed: t("profile.needed.hint"),
                onPress: open("/photos"),
              },
              photos,
              // The photos are approved, not answered: their own words for a screen reader.
              photos && !isDone(photos) ? t("profile.progress.photos", photos) : undefined,
            ),
            {
              key: "place",
              title: t("profile.place.title"),
              summary: profile.home ? shownPlaceName(profile.home, locale) : undefined,
              onPress: open("/profile/place"),
            },
            {
              key: "gender",
              title: t("profile.gender.title"),
              summary: genderWord,
              value: genderWord,
              onPress: open(GENDER_PATH),
            },
            ...LISTED_SECTIONS.map((section) => {
              const hint = sectionHintKey(section.id);
              return filled(
                t,
                {
                  key: section.id,
                  title: t(sectionTitleKey(section.id)),
                  hint: hint && t(hint),
                  onPress: open(sectionPath(section.id)),
                },
                sectionProgress(section, profile.saved),
              );
            }),
          ]}
        />
        <RowGroup
          rows={[
            {
              key: "seek",
              title: t("profile.seek.title"),
              needed: t("profile.needed.hint"),
              onPress: open(SEEK_PATH),
            },
            // An invitation only while something is left to ask (#239).
            ...(later.answered < later.total
              ? [
                  {
                    key: "later",
                    title: t("profile.later.open"),
                    onPress: open(laterPath(FIRST_LATER_FIELD)),
                  },
                ]
              : []),
          ]}
        />
        {/* What the stars mean: what a card needs, starred where one row
            holds it, and never a section that also holds what it does not
            (#616); the name's star is on its field in The basics. */}
        <NeededNote />
      </ScrollView>
    </SafeAreaView>
  );
}
