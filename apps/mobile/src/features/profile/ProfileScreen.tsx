import type { TipKind } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import { useCallback, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { useHapticTap } from "@/theme/haptics";
import { DEAL_BREAKERS_PATH } from "./DealBreakersScreen";
import { completenessText, tipText } from "./keys";
import { FIRST_LATER_FIELD, laterPath } from "./later/LaterFieldScreen";
import { PROFILE_SECTIONS, sectionPath, sectionSummaryKey, sectionTitleKey } from "./sections";
import { useProfile } from "./useProfile";

type Row = { key: string; title: string; summary?: string; onPress: () => void };

/**
 * One group of rows, each a button that opens a screen: the title names it,
 * the summary says what is in it (a screen reader hears it as the hint), and
 * the chevron says it opens.
 */
function RowGroup({ rows }: { rows: readonly Row[] }) {
  return (
    <Card className="gap-0 py-0">
      {rows.map((row, index) => (
        <Button
          key={row.key}
          variant="ghost"
          accessibilityLabel={row.title}
          accessibilityHint={row.summary}
          className={cn(
            "justify-between gap-3 rounded-none px-4 py-3",
            index < rows.length - 1 && "border-b border-border",
          )}
          onPress={row.onPress}
        >
          <View className="flex-1 gap-0.5">
            <Text>{row.title}</Text>
            {row.summary && (
              <Text className="text-sm font-normal text-muted-foreground">{row.summary}</Text>
            )}
          </View>
          <Icon as={ChevronRight} className="text-muted-foreground" />
        </Button>
      ))}
    </Card>
  );
}

/**
 * Tips dismissed in this run of the app (#56): kept outside the screen, so
 * leaving the profile and coming back does not bring one back. Nothing is
 * stored; the next start shows them again.
 */
const dismissedTips = new Set<TipKind>();

/**
 * The profile as a list (#227, ADR-009, ADR-019): what the card still needs,
 * then one advisory photo tip (#56), then the sections, each its own screen
 * that saves on leaving, then the card preview, the later questions (#148)
 * and the deal-breakers (#149). Nothing is edited here, so there is nothing
 * to save; the list reads the profile again when a section hands back, and
 * the checklist and tip follow.
 */
export function ProfileScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const profile = useProfile();
  const { reload } = profile;
  // Renders again after a dismissal; the kinds themselves are in dismissedTips.
  const [, setDismissals] = useState(0);
  // The first focus is the mount, which the hook reads already.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
    }, [reload]),
  );
  const open = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };
  // One at a time (#56): the first that applies and was not dismissed.
  const tip = profile.tips.find((kind) => !dismissedTips.has(kind)) ?? null;

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
            onRetry={() => void profile.reload()}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <View className="flex-row items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel={t("profile.back")}
            onPress={() => {
              tap();
              router.back();
            }}
          >
            <Icon as={ArrowLeft} />
          </Button>
          <Text variant="h1" accessibilityRole="header" className="flex-1">
            {t("profile.title")}
          </Text>
        </View>
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

        {tip && (
          <Card>
            <CardHeader>
              <CardTitle>{t("profile.tip.title")}</CardTitle>
            </CardHeader>
            <CardContent className="gap-3">
              <Text>{tipText(t, tip, profile.fishSpecies)}</Text>
              <Button
                variant="outline"
                onPress={() => {
                  tap();
                  dismissedTips.add(tip);
                  setDismissals((n) => n + 1);
                }}
              >
                {t("profile.tip.dismiss")}
              </Button>
            </CardContent>
          </Card>
        )}

        <RowGroup
          rows={PROFILE_SECTIONS.map(({ id }) => ({
            key: id,
            title: t(sectionTitleKey(id)),
            summary: t(sectionSummaryKey(id)),
            onPress: open(sectionPath(id)),
          }))}
        />
        <RowGroup
          rows={[
            { key: "card", title: t("profile.card.open"), onPress: open("/profile/card") },
            {
              key: "later",
              title: t("profile.later.open"),
              onPress: open(laterPath(FIRST_LATER_FIELD)),
            },
            {
              key: "dealBreakers",
              title: t("profile.dealBreakers.open"),
              onPress: open(DEAL_BREAKERS_PATH),
            },
          ]}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
