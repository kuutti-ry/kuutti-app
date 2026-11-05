import type { PlainMessageKey } from "@kuutti/i18n";
import type { RoundChoice, RoundReason } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import Fish from "lucide-react-native/icons/fish";
import Star from "lucide-react-native/icons/star";
import Undo2 from "lucide-react-native/icons/undo-2";
import { type ReactNode, type Ref, useCallback, useRef, useState } from "react";
import {
  AccessibilityInfo,
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
import { fieldLabelKey, ProfileCardView, SEEK_PATH, useSpokenOnIos } from "@/features/profile";
import { useDecisionButtons } from "@/lib/decision-buttons";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { useHapticTap } from "@/theme/haptics";
import { DECISION_ICONS, type DecisionIcons } from "./faceButtons";
import { ShortPool } from "./ShortPool";
import { type RoundCard, useRound } from "./useRound";

/**
 * Why a card is in the round, in words (TD-12): the label every card carries,
 * never a score. A relaxed card says the deal-breaker it came in by instead,
 * which the database holds it to (round_entries' check, #581).
 */
const REASON: Readonly<Record<Exclude<RoundReason, "relaxed">, PlainMessageKey>> = {
  matches_filters: "round.reason.matches_filters",
  liked_you: "round.reason.liked_you",
  seen_before: "round.reason.seen_before",
  fish: "round.reason.fish",
};

/** The line above a card Undo brought back, by the decision it holds (ADR-034 §5). */
const REVISIT: Readonly<Record<RoundChoice, PlainMessageKey>> = {
  like: "round.revisit.like",
  pass: "round.revisit.pass",
  skip: "round.revisit.skip",
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
 * The queue (#379, #502, ADR-034, ADR-062): one card at a time through the card
 * others see (#47), with why it is there above it, and Block or report on it
 * (ADR-030 §11), as far as the person likes, to the end of who fits them. Like
 * and pass are buttons at the bottom, never a swipe: pass an outlined rectangle
 * at the left, like a filled pill at the right, each with its word and its
 * icon, no red and green; the fish (#378), a like with a mark, a filled rounded
 * square above them, on a card that answers nobody's like, while a fish can go
 * today and on the card that holds it (#475): once the week's is sent it is
 * left out, as on a liked-you card, and nothing says when the next comes, which
 * is Monday's (the maintainer's of 29/10/2026). Later, a text button beside the
 * fish, moves on and costs nobody anything (ADR-062 §3). Beside them the bar
 * says in words how many of the day's likes are left (#524). Undo in the header
 * brings the last card back. Where they sit is the person's (#82): for the
 * right hand as above, or mirrored for the left; and one-handed, Undo, the fish,
 * Later, Pass and Like in one column at the bottom on that side, Undo brought
 * down from the header, within a thumb's reach. A like that makes a match says
 * so and leads to the conversation; one refused over the conversations waiting
 * says how many, and the card stays (ADR-062 §5). The queue's end says so, with
 * no count and nothing about tomorrow, which in a thin set would be false for a
 * month; then what may be relaxed for today (#99, ADR-042), and one plain way
 * into What you seek, the same words for everybody (ADR-062 §11). Each relaxed
 * card says the deal-breaker it came in by and undoes it in one tap, and every
 * card names the person's deal-breakers its person did not answer.
 *
 * A card that holds no like or pass takes a star (#575, ADR-064): beside the
 * reason, and one-handed at the thumb with Undo, its word and an outlined icon
 * against a filled one, so that the state is never colour alone. It decides
 * nothing and the card stays. Given `star`, the id of one on the Starred list, the
 * screen is that one card, and what comes after it is the way back to the list.
 *
 * As a card, the end or a match takes the place of what had the focus, the
 * screen reader is taken to its first line, and from a card of the Starred list
 * that is gone, to the way back (#581); a notice is spoken where it appears,
 * under the header, in sight however far the card was scrolled.
 */
export function RoundScreen({ star }: { star?: string }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const round = useRound(star);
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
  const focus = useCallback((node: TextNode | View | null) => {
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, "focus");
  }, []);
  const words =
    notice === null
      ? null
      : typeof notice === "string"
        ? t(notice)
        : t("round.yourTurn.refused", notice);
  useSpokenOnIos(words);
  // A read past the last card takes the place of the button the focus was on: iOS
  // has no live region for the line to speak through.
  useSpokenOnIos(round.readingOn ? t("load.loading") : null);

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
  // A like or a pass takes the star off, so a card holding one has none to offer.
  const starred = !!entry?.star;
  const starToggle = current && (entry?.decision === null || entry?.decision === "skip") && (
    <Button
      variant="ghost"
      className={cn(placement.oneHanded && "w-full")}
      disabled={round.busy}
      accessibilityLabel={t("round.star.label", { name: current.entry.card.displayName })}
      accessibilityState={{ selected: starred }}
      onPress={() => {
        tap();
        void round.toggleStar(current);
      }}
    >
      <Icon as={Star} fill={starred ? "currentColor" : "none"} />
      <Text>{t(starred ? "round.star.on" : "round.star")}</Text>
    </Button>
  );
  const backToStars = (ref?: Ref<View>) => (
    <Button
      ref={ref}
      variant="outline"
      onPress={() => {
        tap();
        router.back();
      }}
    >
      {t("stars.card.back")}
    </Button>
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t(star ? "stars.title" : "round.title")}
        backLabel={t(star ? "stars.card.back" : "round.back")}
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
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        )}
        {view.status === "failed" && (
          <LoadFailed error={view.error} onRetry={round.retry} />
        )}
        {view.status === "budget" && (
          <Text ref={focus} accessibilityLiveRegion="polite">
            {t("errors.card_budget_exceeded")}
          </Text>
        )}
        {view.status === "gone" && (
          <>
            <Text ref={focus} accessibilityLiveRegion="polite">
              {t("round.gone")}
            </Text>
            {backToStars()}
          </>
        )}
        {entries === null && <Text ref={focus}>{t("round.none")}</Text>}
        {match !== null && (
          <View className="gap-4">
            <Text ref={focus} variant="h2" accessibilityLiveRegion="polite">
              {t("round.match.title")}
            </Text>
            <Button
              onPress={() => {
                tap();
                away.current = true;
                router.push(`/chats/${match}`);
              }}
            >
              {t("round.match.open")}
            </Button>
            {star ? (
              backToStars()
            ) : (
              <Button
                variant="outline"
                onPress={() => {
                  tap();
                  round.closeMatch();
                }}
              >
                {t("round.match.continue")}
              </Button>
            )}
          </View>
        )}
        {match === null && current && (
          <View className="gap-3">
            <View className="flex-row flex-wrap items-center justify-between gap-2">
              <Text
                ref={focus}
                variant="small"
                className="rounded-full bg-secondary px-3 py-1 text-secondary-foreground"
              >
                {current.entry.relaxedField
                  ? t("round.reason.relaxedField", {
                      field: t(fieldLabelKey(current.entry.relaxedField)),
                    })
                  : t(REASON[current.entry.reason as Exclude<RoundReason, "relaxed">])}
              </Text>
              {!placement.oneHanded && starToggle}
            </View>
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
              distance={current.entry.distance}
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
        {/* A card of the Starred list, decided or blocked: the way back is all that stands, and the reader is taken to it (#581). */}
        {star &&
          match === null &&
          !entry &&
          entries &&
          view.status === "ready" &&
          backToStars(focus)}
        {/* The queue's end (ADR-062 §11): the line the reader is taken to, what may be relaxed for today (#99, ADR-042), and the same way into What you seek for everybody. */}
        {!star && match === null && !entry && entries && view.status === "ready" && (
          <>
            <Text ref={focus}>{t("round.done")}</Text>
            <ShortPool
              day={view.round.day}
              busy={round.busy}
              onRelax={(relaxation) => round.relax(view.round.day, relaxation)}
              onUndo={(field) => round.unrelax(view.round.day, field)}
            />
            <Button
              variant="outline"
              onPress={() => {
                tap();
                router.push(SEEK_PATH);
              }}
            >
              {t("profile.seek.title")}
            </Button>
          </>
        )}
      </ScrollView>
      {match === null && current && view.status === "ready" && (
        <DecisionBar
          card={current}
          fishToSend={view.round.fishToSend}
          likesLeft={view.round.likesLeft}
          busy={round.busy}
          left={placement.hand === "left"}
          oneHanded={placement.oneHanded}
          icons={DECISION_ICONS[placement.style]}
          undo={undo}
          star={starToggle}
          onChoose={choose}
        />
      )}
      {/* One-handed, Undo stays at the thumb when no card is left to decide:
          after the queue's last decision it can still be taken back (ADR-034 §5). */}
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
 * Like, Pass, Later and the fish at the bottom of the queue (#82): in a row for
 * the right hand (Pass, Like) or mirrored for the left, the fish and Later above
 * on the hand's side; one-handed, a column on that side, Undo first and Like
 * last, nearest the thumb. Each keeps its shape, word and icon wherever it sits.
 * The fish is there while one can go today, and on the card that holds it,
 * read back selected and open to change (#475). Later is there on every card,
 * a text button with no fill and no outline, plainer than the two that decide:
 * it spends nothing and answers nobody (ADR-062 §3), and a wide word in the row
 * of two would take their room, so it sits with the fish and wraps with it, never
 * on a line of its own while there is room beside the fish. How many of the
 * day's likes are left is plain text beside those two, above them where they do
 * not fit on one row, the same at ten as at one: no colour, no motion, and
 * nothing announces it after a decision (#524). The star is no decision and sits on
 * the card; one-handed it comes down with Undo, within the thumb's reach (#575).
 */
function DecisionBar({
  card,
  fishToSend,
  likesLeft,
  busy,
  left,
  oneHanded,
  icons,
  undo,
  star,
  onChoose,
}: {
  card: RoundCard;
  /** Whether a fish can go today, as the round and each decision's answer say (#475). */
  fishToSend: boolean;
  /** How many of the day's likes are left, as the round and each decision's answer say (#524). */
  likesLeft: number;
  busy: boolean;
  left: boolean;
  oneHanded: boolean;
  /** Like's and Pass's icons, in the person's style (#520); nothing else changes with it. */
  icons: DecisionIcons;
  /** Undo, which comes down from the header in one-handed mode; nothing while there is nothing to undo. */
  undo: ReactNode;
  /** The star, which comes down from the card in one-handed mode; nothing on a card holding a like or a pass. */
  star: ReactNode;
  onChoose: (card: RoundCard, decision: RoundChoice) => void;
}) {
  const { t } = useT();
  const { entry } = card;
  const likes = (
    <Text variant="muted" className={cn(!left && "text-right")}>
      {t("round.likesLeft", { likes: likesLeft })}
    </Text>
  );
  // A fish counts in the day's likes, so with none left it can go only on a
  // card whose like is paid for (#503, the maintainer's of 01/11/2026).
  const fishCanGo = fishToSend && (likesLeft > 0 || entry.decision === "like");
  const fish = !ANSWERS_A_LIKE.has(entry.reason) && (fishCanGo || entry.decision === "fish") && (
    <Button
      variant="secondary"
      className={cn("rounded-lg", oneHanded && "w-full")}
      disabled={busy}
      accessibilityLabel={t("round.fish")}
      accessibilityState={{ selected: entry.decision === "fish" }}
      onPress={() => onChoose(card, "fish")}
    >
      <Icon as={Fish} />
      <Text>{t("round.fish")}</Text>
    </Button>
  );
  const later = (
    <Button
      variant="ghost"
      className={cn(oneHanded && "w-full")}
      disabled={busy}
      accessibilityLabel={t("round.skip")}
      accessibilityState={{ selected: entry.decision === "skip" }}
      onPress={() => onChoose(card, "skip")}
    >
      {t("round.skip")}
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
      <Icon as={icons.pass} />
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
      <Icon as={icons.like} />
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
          {star}
          {likes}
          {fish}
          {later}
          {pass}
          {like}
        </View>
      ) : (
        <>
          <View
            testID="round-likes-row"
            className={cn(
              "flex-row flex-wrap items-center justify-end gap-x-4 gap-y-3",
              left && "flex-row-reverse",
            )}
          >
            {likes}
            <View
              className={cn(
                "flex-row flex-wrap items-center justify-end gap-x-4 gap-y-3",
                left && "flex-row-reverse",
              )}
            >
              {fish}
              {later}
            </View>
          </View>
          <View className="flex-row gap-4">{left ? [like, pass] : [pass, like]}</View>
        </>
      )}
    </View>
  );
}
