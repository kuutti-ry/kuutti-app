import type { PlainMessageKey } from "@kuutti/i18n";
import { REPORT_NOTE_MAX, type SanctionReason } from "@kuutti/schema";
import Ellipsis from "lucide-react-native/icons/ellipsis";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  ScrollView,
  type Text as TextNode,
  useWindowDimensions,
  View,
} from "react-native";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { blockPerson, reportPerson } from "./client";

/** #106's six reasons in the order a person reads them; the values are the contract's. */
const REASONS: ReadonlyArray<{ value: SanctionReason; label: PlainMessageKey }> = [
  { value: "harassment", label: "safety.report.reason.harassment" },
  { value: "misrepresentation", label: "safety.report.reason.misrepresentation" },
  { value: "under_age", label: "safety.report.reason.under_age" },
  { value: "commercial_use", label: "safety.report.reason.commercial_use" },
  { value: "scraping", label: "safety.report.reason.scraping" },
  { value: "other", label: "safety.report.reason.other" },
];

/**
 * Where the dialog stands: the choice, the block's confirmation, the report,
 * what went through, or a card the API no longer has.
 */
type Step = "choose" | "block" | "report" | "blocked" | "reported" | "gone";
type Notice = "failed" | "limited" | null;

/** The steps after which the card leaves the screen. */
const FINAL: ReadonlySet<Step> = new Set(["blocked", "reported", "gone"]);

/** The dialog is bounded by the window, so its middle scrolls rather than overflows (2x text). */
const WINDOW_SHARE = 0.9;

/**
 * Block or report the person of someone else's card (#84, ADR-030 §11): an
 * icon button labelled in words, then one dialog. A block is confirmed in
 * words that say it is final, holds through either person's deletion and is
 * not told; a report asks for one of #106's reasons and, if the person likes,
 * a few lines, and says it blocks too, as finally. Each is a button, never a
 * swipe. Once one went through, closing the dialog hands the card to
 * `onGone`, and the screen takes it away; a card the API no longer has is
 * said so and handed back too. The day's cap on reports is said in words,
 * with a Block under it, so nobody is left facing the card. Nothing chosen
 * or typed is lost to a failure or to a stray dismissal: only Cancel and a
 * report that went through forget it. A failure that lands after the dialog
 * was closed opens it again where it was. Live regions speak each outcome on
 * Android; iOS has none, so the outcome is announced there, and the focus
 * moves to each step's title.
 */
export function SafetyActions({
  accountId,
  open,
  onOpenChange,
  onGone,
}: {
  /** The card's person; sent to the API, never shown. */
  accountId: string;
  /** Held by the card, whose accessibility action opens the dialog too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A block or a report went through, or the card is gone: the screen takes it away. */
  onGone: (accountId: string) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const { height } = useWindowDimensions();
  const [step, setStep] = useState<Step>("choose");
  const [reason, setReason] = useState<SanctionReason | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // Whether the dialog is open when an answer lands: a block that went
  // through after it was closed takes the card at once, and anything else
  // opens it again to say so.
  const shown = useRef(open);
  useEffect(() => {
    shown.current = open;
  }, [open]);

  // Each step's title as it appears: the step replaced the button that had
  // the focus, so the screen reader goes to the title rather than to wherever
  // the removed button leaves it. Stable, so it runs as a title mounts, not
  // on every render.
  const focusTitle = useCallback((node: TextNode | null) => {
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, "focus");
  }, []);

  /** iOS has no live regions; Android's speak the same words already. */
  const say = (words: string) => {
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words);
  };

  const go = (next: Step) => {
    tap();
    setNotice(null);
    setStep(next);
  };

  const forget = () => {
    setStep("choose");
    setReason(null);
    setNote("");
    setNotice(null);
  };

  /** Cancel: closes and forgets what was chosen and typed. */
  const cancel = () => {
    onOpenChange(false);
    forget();
  };

  /** The corner, the scrim, the back gesture: closes and keeps the draft, or hands the card back after an outcome. */
  const dismiss = () => {
    onOpenChange(false);
    if (FINAL.has(step)) {
      forget();
      onGone(accountId);
    }
  };

  const send = async (
    outcome: "blocked" | "reported",
    request: () => Promise<void>,
    failed: PlainMessageKey,
  ) => {
    tap();
    setNotice(null);
    setSending(true);
    say(t("safety.sending"));
    try {
      await request();
      const words = t(outcome === "blocked" ? "safety.block.done" : "safety.report.done");
      if (shown.current) {
        setStep(outcome);
        say(words);
      } else {
        // Closed meanwhile: the card goes, and no live region is there to say
        // why, so the words are announced on both platforms.
        AccessibilityInfo.announceForAccessibility(words);
        forget();
        onGone(accountId);
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      if (code === "not_found") {
        // The card's person, or the photos it showed, are gone meanwhile: trying again cannot help.
        setStep("gone");
        say(t("safety.gone"));
      } else if (code === "report_budget_exceeded") {
        setNotice("limited");
        say(t("errors.report_budget_exceeded"));
      } else {
        setNotice("failed");
        say(t(failed));
      }
      if (!shown.current) onOpenChange(true);
    } finally {
      setSending(false);
    }
  };

  const block = () => send("blocked", () => blockPerson(accountId), "safety.block.failed");
  const report = (chosen: SanctionReason) => {
    // A blank note is left out; the contract refuses an empty one.
    const words = note.trim();
    return send(
      "reported",
      () => reportPerson({ accountId, reason: chosen, ...(words ? { note: words } : {}) }),
      "safety.report.failed",
    );
  };

  const working = sending && <Text accessibilityLiveRegion="polite">{t("safety.sending")}</Text>;
  const noteLabel = t("safety.report.noteLabel", { max: REPORT_NOTE_MAX });

  return (
    <>
      {/* Top right of the card's header, as far from like and pass as the card allows (D19). */}
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel={t("safety.actions.title")}
        onPress={() => {
          tap();
          onOpenChange(true);
        }}
      >
        <Icon as={Ellipsis} />
      </Button>

      {/* Nothing but its own controls opens it, so a change is always a close. */}
      <Dialog open={open} onOpenChange={dismiss}>
        <DialogContent
          closeLabel={t("safety.actions.close")}
          style={{ maxHeight: height * WINDOW_SHARE }}
        >
          {step === "choose" && (
            <>
              <DialogHeader>
                <DialogTitle ref={focusTitle}>{t("safety.actions.title")}</DialogTitle>
              </DialogHeader>
              <ScrollView style={{ flexShrink: 1 }} contentContainerClassName="gap-4">
                <View className="gap-1">
                  <Button variant="outline" onPress={() => go("block")}>
                    {t("safety.actions.block")}
                  </Button>
                  <Text variant="muted">{t("safety.actions.blockHint")}</Text>
                </View>
                <View className="gap-1">
                  <Button variant="outline" onPress={() => go("report")}>
                    {t("safety.actions.report")}
                  </Button>
                  <Text variant="muted">{t("safety.actions.reportHint")}</Text>
                </View>
              </ScrollView>
              <DialogFooter>
                <Button variant="ghost" onPress={cancel}>
                  {t("safety.actions.cancel")}
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "block" && (
            <>
              <DialogHeader>
                <DialogTitle ref={focusTitle}>{t("safety.block.title")}</DialogTitle>
              </DialogHeader>
              <ScrollView style={{ flexShrink: 1 }} contentContainerClassName="gap-4">
                <DialogDescription>{t("safety.block.body")}</DialogDescription>
                {notice && (
                  <Text accessibilityLiveRegion="assertive">{t("safety.block.failed")}</Text>
                )}
                {working}
              </ScrollView>
              <DialogFooter>
                <Button variant="outline" disabled={sending} onPress={cancel}>
                  {t("safety.actions.cancel")}
                </Button>
                {/* The word carries the meaning; the colour only repeats it. */}
                <Button variant="destructive" disabled={sending} onPress={() => void block()}>
                  {t("safety.actions.block")}
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "report" && (
            <>
              <DialogHeader>
                <DialogTitle ref={focusTitle}>{t("safety.actions.report")}</DialogTitle>
              </DialogHeader>
              {/* What it does, six reasons and a text field outgrow a phone's screen at a large
                  text size, and the keyboard covers the dialog's lower half: they scroll, a drag
                  puts the keyboard away, and the field scrolls into view above it. */}
              <ScrollView
                style={{ flexShrink: 1 }}
                contentContainerClassName="gap-3"
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                automaticallyAdjustKeyboardInsets
              >
                <DialogDescription>{t("safety.report.alsoBlocks")}</DialogDescription>
                {/* role, not accessibilityRole: the primitive sets role from its variant, and small has none. */}
                <Text variant="small" role="heading" aria-level="3">
                  {t("safety.report.reasonLabel")}
                </Text>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={t("safety.report.reasonLabel")}
                  className="gap-2"
                >
                  {REASONS.map(({ value, label }) => {
                    const chosen = reason === value;
                    const name = chosen ? t("settings.selected", { option: t(label) }) : t(label);
                    return (
                      <Button
                        key={value}
                        variant={chosen ? "default" : "outline"}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: chosen }}
                        // react-native-web reads the ARIA prop, not accessibilityState.
                        aria-checked={chosen}
                        accessibilityLabel={name}
                        disabled={sending}
                        onPress={() => {
                          tap();
                          setReason(value);
                        }}
                      >
                        {name}
                      </Button>
                    );
                  })}
                </View>
                <Text variant="small">{noteLabel}</Text>
                <Input
                  accessibilityLabel={noteLabel}
                  value={note}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  maxLength={REPORT_NOTE_MAX}
                  // A multiline field's return key would only add a line; here it puts the keyboard away.
                  submitBehavior="blurAndSubmit"
                  returnKeyType="done"
                  editable={!sending}
                  className="min-h-24"
                  onChangeText={setNote}
                />
              </ScrollView>
              {notice === "limited" && (
                <View className="gap-2" accessibilityLiveRegion="assertive">
                  <Text>{t("errors.report_budget_exceeded")}</Text>
                  <Button variant="outline" onPress={() => go("block")}>
                    {t("safety.actions.block")}
                  </Button>
                </View>
              )}
              {notice === "failed" && (
                <Text accessibilityLiveRegion="assertive">{t("safety.report.failed")}</Text>
              )}
              {working}
              <DialogFooter>
                <Button variant="outline" disabled={sending} onPress={cancel}>
                  {t("safety.actions.cancel")}
                </Button>
                <Button
                  disabled={reason === null || sending}
                  onPress={() => reason && void report(reason)}
                >
                  {t("safety.report.send")}
                </Button>
              </DialogFooter>
            </>
          )}

          {FINAL.has(step) && (
            <>
              <DialogHeader accessibilityLiveRegion="polite">
                <DialogTitle ref={focusTitle}>
                  {step === "blocked"
                    ? t("safety.block.done")
                    : step === "reported"
                      ? t("safety.report.done")
                      : t("safety.gone")}
                </DialogTitle>
              </DialogHeader>
              <DialogFooter>
                <Button onPress={dismiss}>{t("safety.done")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
