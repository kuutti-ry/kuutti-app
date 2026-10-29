import type { PlainMessageKey } from "@kuutti/i18n";
import type { RoundChoice, RoundReason } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import Fish from "lucide-react-native/icons/fish";
import Heart from "lucide-react-native/icons/heart";
import Undo2 from "lucide-react-native/icons/undo-2";
import X from "lucide-react-native/icons/x";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  ScrollView,
  type Text as TextNode,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { fieldLabelKey, ProfileCardView } from "@/features/profile";
import { useDecisionButtons } from "@/lib/decision-buttons";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { useHapticTap } from "@/theme/haptics";
import { ShortPool } from "./ShortPool";
import { type RoundCard, useRound } from "./useRound";

/** Why a card is in the round, in words (TD-12): the label every card carries, never a score. */
const REASON: Readonly<Record<RoundReason, PlainMessageKey>> = {
  matches_filters: "round.reason.matches_filters",
  liked_you: "round.reason.liked_you",
  seen_before: "round.reason.seen_before",
  relaxed: "round.reason.relaxed",
  fish: "round.reason.fish",
};

/** The line above a card Undo brought back, by the decision it holds (ADR-034 §5). */
const REVISIT: Readonly<Record<RoundChoice, PlainMessageKey>> = {
  like: "round.revisit.like",
  pass: "round.revisit.pass",
  fish: "round.revisit.fish",
};

/** A card that answers somebody's like takes a like back, never a fish (ADR-039 §2). */
const ANSWERS_A_LIKE: ReadonlySet<RoundReason> = new Set(["liked_you", "fish"]);

/**
 * From this OS font scale, Undo in the header is its icon alone (#467, the
 * maintainer's of 28/10/2026): its word grows with the text and the title
 * beside it shrinks to fit, below body text from x1.45 on a 360 pt phone in
 * Finnish. Android's 130 % and iOS's largest standard size. It keeps its
 * spoken label and its 44 pt target; one-handed, at the thumb, it keeps its
 * word, having the room.
 */
const WORDLESS_UNDO_FONT_SCALE = 1.3;

/**
 * Today's round (#379, ADR-034): one card at a time through the card others
 * see (#47), with why it is there above it, and Block or report on it
 * (ADR-030 §11). Like and pass are buttons at the bottom, never a swipe: pass
 * an outlined rectangle at the left, like a filled pill at the right, each
 * with its word and its icon, no red and green; the fish (#378), a like with
 * a mark, a filled rounded square above them, on a card that answers nobody's
 * like, while a fish can go today and on the card that holds it (#475): once
 * the day's is sent it is left out, as on a liked-you card, and nothing says
 * when the next comes, with the next round. Undo in the header brings the last
 * card back. Where they sit is the
 * person's (#82): for the right hand as above, or mirrored for the left; and
 * one-handed, Undo, the fish, Pass and Like in one column at the bottom on
 * that side, Undo brought down from the header, within a thumb's reach. A like that
 * makes a match says so and leads to the conversation. The end of the round,
 * an empty one and one not built say to come back tomorrow, with no count
 * and no countdown, and nothing loads more; the end of a short round offers
 * to relax a deal-breaker for today (#99, ADR-042), each relaxed card says
 * the deal-breaker it came in by and undoes it in one tap, and every card
 * names the person's deal-breakers its person did not answer.
 *
 * As a card, the end or a match takes the place of what had the focus, the
 * screen reader is taken to its first line; a notice is spoken where it
 * appears, under the header, in sight however far the card was scrolled.
 */
export function RoundScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const round = useRound();
  const { view, current, notice, match } = round;
  // A photo URL the API refused (the day's photos, #52), for the card it was
  // refused on, by its day and place: a new day's card there starts without it.
  const [refused, setRefused] = useState<{ day: string; position: number; code: string } | null>(
    null,
  );

  // The conversation is pushed over the round, which stays mounted under it:
  // the match stays in front of the next card until the round is in sight
  // again, so that card is neither shown nor reported seen meanwhile (ADR-034 §2).
  const away = useRef(false);
  const { closeMatch } = round;
  useFocusEffect(
    useCallback(() => {
      if (!away.current) return;
      away.current = false;
      closeMatch();
    }, [closeMatch]),
  );

  // Stable, so it runs as a line mounts rather than on every render.
  const focus = useCallback((node: TextNode | null) => {
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, "focus");
  }, []);
  const words = notice === null ? null : t(notice);
  // iOS has no live regions; Android's speak the same words already.
  useEffect(() => {
    if (words !== null && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words);
  }, [words]);

  const entries = view.status === "ready" ? view.round.entries : undefined;
  const entry = current?.entry;
  const choose = (card: RoundCard, decision: RoundChoice) => {
    tap();
    void round.choose(card, decision);
  };

  // Where the decision buttons sit (#82): for the right hand or the left,
  // and one-handed in a column on that side with Undo among them.
  const { settings: placement } = useDecisionButtons();
  const { fontScale } = useWindowDimensions();
  // Android sends its scale as a float: 130 % arrives as 1.2999999523.
  const wordless = !placement.oneHanded && fontScale >= Math.fround(WORDLESS_UNDO_FONT_SCALE);
  const undo = round.canUndo && (
    <Button
      variant="ghost"
      size={wordless ? "icon" : "default"}
      className={cn(placement.oneHanded && "w-full")}
      accessibilityLabel={t("round.undo.label")}
      onPress={() => {
        tap();
        round.undo();
      }}
    >
      <Icon as={Undo2} />
      {!wordless && <Text>{t("round.undo")}</Text>}
    </Button>
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("round.title")}
        backLabel={t("round.back")}
        onBack={() => router.back()}
      >
        {!placement.oneHanded && undo}
      </ScreenHeader>
      {words !== null && (
        <Text accessibilityLiveRegion="polite" className="px-6 pt-4">
          {words}
        </Text>
      )}
      {/* Keyed by the card, so each one starts at its top. */}
      <ScrollView
        key={match ?? entry?.position ?? "round"}
        contentContainerClassName="flex-grow gap-4 p-6"
      >
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
                away.current = true;
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
        {match === null && current && (
          <View className="gap-3">
            <Text
              ref={focus}
              variant="small"
              className="self-start rounded-full bg-secondary px-3 py-1 text-secondary-foreground"
            >
              {current.entry.relaxedField
                ? t("round.reason.relaxedField", {
                    field: t(fieldLabelKey(current.entry.relaxedField)),
                  })
                : t(REASON[current.entry.reason])}
            </Text>
            {(current.entry.notAnswered ?? []).map((field) => (
              <Text key={field} variant="muted">
                {t("round.notAnswered", { field: t(fieldLabelKey(field)) })}
              </Text>
            ))}
            {current.entry.relaxedField && current.entry.decision === null && (
              <Button
                variant="ghost"
                className="self-start"
                disabled={round.busy}
                accessibilityLabel={t("round.relaxed.undo", {
                  field: t(fieldLabelKey(current.entry.relaxedField)),
                })}
                onPress={() => {
                  tap();
                  const field = current.entry.relaxedField;
                  if (field) void round.unrelax(current.day, field);
                }}
              >
                {t("round.relaxed.undo", { field: t(fieldLabelKey(current.entry.relaxedField)) })}
              </Button>
            )}
            {current.entry.decision !== null && <Text>{t(REVISIT[current.entry.decision])}</Text>}
            <ProfileCardView
              card={current.entry.card}
              // No block or report while a decision is on its way: one finishing
              // after the next card took this one's place would never take the
              // blocked person off, and Undo would bring them back (ADR-030 §11).
              onGone={
                round.busy ? undefined : () => round.drop(current.day, current.entry.position)
              }
              onRefused={(code) =>
                setRefused({ day: current.day, position: current.entry.position, code: code ?? "" })
              }
            />
            {refused?.day === current.day && refused.position === current.entry.position && (
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
        {/* A short or empty round's end offers to relax a deal-breaker for today (#99, ADR-042), after the line the reader is taken to. */}
        {match === null && !entry && entries && view.status === "ready" && (
          <ShortPool
            day={view.round.day}
            busy={round.busy}
            onRelax={(relaxation) => round.relax(view.round.day, relaxation)}
            onUndo={(field) => round.unrelax(view.round.day, field)}
          />
        )}
      </ScrollView>
      {match === null && current && view.status === "ready" && (
        <DecisionBar
          card={current}
          fishToSend={view.round.fishToSend}
          busy={round.busy}
          left={placement.hand === "left"}
          oneHanded={placement.oneHanded}
          undo={undo}
          onChoose={choose}
        />
      )}
      {/* One-handed, Undo stays at the thumb when no card is left to decide:
          after the round's last decision it can still be taken back (ADR-034 §5). */}
      {match === null && !current && placement.oneHanded && undo && (
        <View className="border-t border-border bg-background px-6 py-3">
          <View
            testID="round-one-handed"
            className={cn("w-2/3", placement.hand === "left" ? "self-start" : "self-end")}
          >
            {undo}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

/**
 * Like, Pass and the fish at the bottom of the round (#82): in a row for the
 * right hand (Pass, Like) or mirrored for the left, the fish above on the
 * hand's side; one-handed, a column on that side, Undo first and Like last,
 * nearest the thumb. Each keeps its shape, word and icon wherever it sits.
 * The fish is there while one can go today, and on the card that holds it,
 * read back selected and open to change (#475).
 */
function DecisionBar({
  card,
  fishToSend,
  busy,
  left,
  oneHanded,
  undo,
  onChoose,
}: {
  card: RoundCard;
  /** Whether a fish can go today, as the round and each decision's answer say (#475). */
  fishToSend: boolean;
  busy: boolean;
  left: boolean;
  oneHanded: boolean;
  /** Undo, which comes down from the header in one-handed mode; nothing while there is nothing to undo. */
  undo: ReactNode;
  onChoose: (card: RoundCard, decision: RoundChoice) => void;
}) {
  const { t } = useT();
  const { entry } = card;
  // shortcut: nothing says when the next fish comes, which is right while
  // fish_window_days is 1 and the next round brings it; a longer window would
  // need the day it comes back, a field of its own (ADR-039 Consequences).
  const fish = !ANSWERS_A_LIKE.has(entry.reason) && (fishToSend || entry.decision === "fish") && (
    <Button
      variant="secondary"
      className={cn("rounded-lg", oneHanded ? "w-full" : left ? "self-start" : "self-end")}
      disabled={busy}
      accessibilityLabel={t("round.fish")}
      accessibilityState={{ selected: entry.decision === "fish" }}
      onPress={() => onChoose(card, "fish")}
    >
      <Icon as={Fish} />
      <Text>{t("round.fish")}</Text>
    </Button>
  );
  const pass = (
    <Button
      key="pass"
      variant="outline"
      size="lg"
      className={cn("rounded-md", oneHanded ? "w-full" : "flex-1")}
      disabled={busy}
      accessibilityLabel={t("round.pass")}
      accessibilityState={{ selected: entry.decision === "pass" }}
      onPress={() => onChoose(card, "pass")}
    >
      <Icon as={X} />
      <Text>{t("round.pass")}</Text>
    </Button>
  );
  const like = (
    <Button
      key="like"
      size="lg"
      className={cn("rounded-full", oneHanded ? "w-full" : "flex-1")}
      disabled={busy}
      accessibilityLabel={t("round.like")}
      accessibilityState={{ selected: entry.decision === "like" }}
      onPress={() => onChoose(card, "like")}
    >
      <Icon as={Heart} />
      <Text>{t("round.like")}</Text>
    </Button>
  );
  return (
    <View className="gap-3 border-t border-border bg-background px-6 py-3">
      {oneHanded ? (
        <View
          testID="round-one-handed"
          className={cn("w-2/3 gap-3", left ? "self-start" : "self-end")}
        >
          {undo}
          {fish}
          {pass}
          {like}
        </View>
      ) : (
        <>
          {fish}
          <View className="flex-row gap-4">{left ? [like, pass] : [pass, like]}</View>
        </>
      )}
    </View>
  );
}
