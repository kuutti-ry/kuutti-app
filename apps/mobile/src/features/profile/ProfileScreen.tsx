import { useFocusEffect, useRouter } from "expo-router";
import Eye from "lucide-react-native/icons/eye";
import { useCallback, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { type Row, RowGroup } from "@/components/RowGroup";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { listPhotos } from "@/features/media";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { DEAL_BREAKERS_PATH } from "./DealBreakersScreen";
import { completenessText } from "./keys";
import { FIRST_LATER_FIELD, laterPath, laterProgress } from "./later/LaterFieldScreen";
import { type MarkStyle, ProgressMark, progressWords } from "./ProgressMark";
import { isDone, type Progress, photoProgress, sectionProgress } from "./progress";
import { PROFILE_SECTIONS, sectionPath, sectionSummaryKey, sectionTitleKey } from "./sections";
import { useProfile } from "./useProfile";

/**
 * Both marks side by side until the maintainer picks one (#239): a ring on
 * every other row, the count on the rest. The one he keeps stays, and this
 * alternation goes with the other.
 */
const markStyle = (index: number): MarkStyle => (index % 2 === 0 ? "ring" : "count");

/** A row of the profile's list with how far its part is filled: the mark drawn, the words heard. */
function filled(
  t: ReturnType<typeof useT>["t"],
  row: Row,
  index: number,
  progress: Progress | null | undefined,
  words?: string,
): Row {
  if (!progress) return row;
  return {
    ...row,
    mark: <ProgressMark progress={progress} style={markStyle(index)} />,
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
 * The profile as a list (#227, ADR-009, ADR-019): the eye at the top that
 * opens the card as others see it, what the card still needs (said only
 * while something is missing, #239), then the
 * profile's parts, each with how far it is filled: the photos, the sections
 * (each its own screen that saves on leaving), the deal-breakers (#149) and,
 * while a later question is unanswered, the later screens (#148). Nothing is
 * edited here, so there is nothing to save; the list reads the profile and
 * the photos again when a screen hands back, and the marks follow.
 */
export function ProfileScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const profile = useProfile();
  const { reload } = profile;
  const [approvedPhotos, readPhotos] = useApprovedPhotos();
  // The first focus is the mount, which the hook reads already.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
      readPhotos();
    }, [reload, readPhotos]),
  );
  const open = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };
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
          <LoadFailed
            headline={t("profile.failed")}
            error={profile.error}
            onRetry={() => {
              readPhotos();
              void profile.reload();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const later = laterProgress(profile.saved.fields);
  const photos = approvedPhotos === null ? undefined : photoProgress(approvedPhotos);
  const missing = profile.completeness?.complete === false ? profile.completeness.missing : [];

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("profile.title")}
        backLabel={t("profile.back")}
        onBack={() => router.back()}
      >
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
                summary: t("profile.section.photos.summary"),
                onPress: open("/photos"),
              },
              0,
              photos,
              // The photos are approved, not answered: their own words for a screen reader.
              photos && !isDone(photos) ? t("profile.progress.photos", photos) : undefined,
            ),
            ...PROFILE_SECTIONS.map((section, index) =>
              filled(
                t,
                {
                  key: section.id,
                  title: t(sectionTitleKey(section.id)),
                  summary: t(sectionSummaryKey(section.id)),
                  onPress: open(sectionPath(section.id)),
                },
                index + 1,
                sectionProgress(section, profile.saved),
              ),
            ),
          ]}
        />
        <RowGroup
          rows={[
            {
              key: "dealBreakers",
              title: t("profile.dealBreakers.open"),
              onPress: open(DEAL_BREAKERS_PATH),
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
      </ScrollView>
    </SafeAreaView>
  );
}
