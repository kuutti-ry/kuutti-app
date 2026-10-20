import type { PlainMessageKey } from "@kuutti/i18n";
import type { RoundDecision, RoundReason } from "@kuutti/schema";
import { useRouter } from "expo-router";
import Heart from "lucide-react-native/icons/heart";
import Undo2 from "lucide-react-native/icons/undo-2";
import X from "lucide-react-native/icons/x";
import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, ScrollView, type Text as TextNode, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { ProfileCardView } from "@/features/profile";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { type RoundCard, useRound } from "./useRound";

/** Why a card is in the round, in words (TD-12): the label every card carries, never a score. */
const REASON: Readonly<Record<RoundReason, PlainMessageKey>> = {
  matches_filters: "round.reason.matches_filters",
  liked_you: "round.reason.liked_you",
  seen_before: "round.reason.seen_before",
  relaxed: "round.reason.relaxed",
};

/**
 * Today's round (#379, ADR-034): one card at a time through the card others
 * see (#47), with why it is there above it, and Block or report on it
 * (ADR-030 §11). Like and pass are buttons at the bottom, never a swipe: pass
 * an outlined rectangle at the left, like a filled pill at the right, each
 * with its word and its icon, no red and green; #82 makes the places
 * configurable. Undo in the header brings the last card back. A like that
 * makes a match says so and leads to the conversation. The end of the round,
 * an empty one and one not built say to come back tomorrow, with no count
 * and no countdown, and nothing loads more.
 *
 * As a card, the end or a match takes the place of what had the focus, the
 * screen reader is taken to its first line; a notice is spoken where it
 * appears.
 */
export function RoundScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const round = useRound();
  const { view, current, notice, match } = round;
  // A photo URL the API refused (the day's photos, #52), for the card it was refused on.
  const [refused, setRefused] = useState<{ position: number; code: string } | null>(null);

  // Stable, so it runs as a line mounts rather than on every render.
  const focus = useCallback((node: TextNode | null) => {
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, "focus");
  }, []);
  // iOS has no live regions; Android's speak the same words already.
  useEffect(() => {
    if (notice && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(t(notice));
  }, [notice, t]);

  const entries = view.status === "ready" ? view.round.entries : undefined;
  const entry = current?.entry;
  const choose = (card: RoundCard, decision: RoundDecision) => {
    tap();
    void round.choose(card, decision);
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("round.title")}
        backLabel={t("round.back")}
        onBack={() => router.back()}
      >
        {round.canUndo && (
          <Button
            variant="ghost"
            accessibilityLabel={t("round.undo.label")}
            onPress={() => {
              tap();
              round.undo();
            }}
          >
            <Icon as={Undo2} />
            <Text>{t("round.undo")}</Text>
          </Button>
        )}
      </ScreenHeader>
      {/* Keyed by the card, so each one starts at its top. */}
      <ScrollView
        key={match ?? entry?.position ?? "round"}
        contentContainerClassName="flex-grow gap-4 p-6"
      >
        {notice && <Text accessibilityLiveRegion="polite">{t(notice)}</Text>}
        {view.status === "loading" && (
          <Text accessibilityLiveRegion="polite">{t("round.loading")}</Text>
        )}
        {view.status === "failed" && (
          <LoadFailed headline={t("round.failed")} error={view.error} onRetry={round.retry} />
        )}
        {view.status === "budget" && (
          <Text ref={focus} accessibilityLiveRegion="polite">
            {t("errors.card_budget_exceeded")}
          </Text>
        )}
        {entries === null && <Text ref={focus}>{t("round.none")}</Text>}
        {entries?.length === 0 && <Text ref={focus}>{t("round.empty")}</Text>}
        {match !== null && (
          <View className="gap-4">
            <Text ref={focus} variant="h2" accessibilityLiveRegion="polite">
              {t("round.match.title")}
            </Text>
            <Text>{t("round.match.body")}</Text>
            <Button
              onPress={() => {
                tap();
                round.closeMatch();
                router.push(`/chats/${match}`);
              }}
            >
              {t("round.match.open")}
            </Button>
            <Button
              variant="outline"
              onPress={() => {
                tap();
                round.closeMatch();
              }}
            >
              {t("round.match.continue")}
            </Button>
          </View>
        )}
        {match === null && entry && (
          <View className="gap-3">
            <Text
              ref={focus}
              variant="small"
              className="self-start rounded-full bg-secondary px-3 py-1 text-secondary-foreground"
            >
              {t(REASON[entry.reason])}
            </Text>
            {entry.decision !== null && (
              <Text>
                {t(entry.decision === "like" ? "round.revisit.like" : "round.revisit.pass")}
              </Text>
            )}
            <ProfileCardView
              card={entry.card}
              onGone={() => round.drop(entry.position)}
              onRefused={(code) => setRefused({ position: entry.position, code: code ?? "" })}
            />
            {refused?.position === entry.position && (
              <Text variant="muted" accessibilityLiveRegion="polite">
                {t(
                  refused.code === "photo_budget_exceeded"
                    ? "photos.error.photo_budget_exceeded"
                    : "photos.error.notShown",
                )}
              </Text>
            )}
          </View>
        )}
        {match === null && !entry && entries && entries.length > 0 && (
          <Text ref={focus}>{t("round.done")}</Text>
        )}
      </ScrollView>
      {match === null && current && (
        <View className="flex-row gap-4 border-t border-border bg-background px-6 py-3">
          <Button
            variant="outline"
            size="lg"
            className="flex-1 rounded-md"
            disabled={round.busy}
            accessibilityLabel={t("round.pass")}
            accessibilityState={{ selected: current.entry.decision === "pass" }}
            onPress={() => choose(current, "pass")}
          >
            <Icon as={X} />
            <Text>{t("round.pass")}</Text>
          </Button>
          <Button
            size="lg"
            className="flex-1 rounded-full"
            disabled={round.busy}
            accessibilityLabel={t("round.like")}
            accessibilityState={{ selected: current.entry.decision === "like" }}
            onPress={() => choose(current, "like")}
          >
            <Icon as={Heart} />
            <Text>{t("round.like")}</Text>
          </Button>
        </View>
      )}
    </SafeAreaView>
  );
}
