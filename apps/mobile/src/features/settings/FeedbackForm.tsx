import type { PlainMessageKey } from "@kuutti/i18n";
import { FEEDBACK_TEXT_MAX, type FeedbackKind, type FeedbackPlatform } from "@kuutti/schema";
import { useState } from "react";
import { Platform, View } from "react-native";
import { Notice } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { ApiError } from "@/lib/api";
import { buildInfo } from "@/lib/build";
import { useT } from "@/lib/locale";
import { useReportUnsaved } from "@/lib/unsaved";
import { useHapticTap } from "@/theme/haptics";
import { Choice } from "./Choice";
import { sendFeedback } from "./feedback-client";

/** The four kinds in the order the person reads them; the panel's own order is the contract's. */
const KINDS: ReadonlyArray<{ value: FeedbackKind; label: PlainMessageKey }> = [
  { value: "bug", label: "feedback.kind.bug" },
  { value: "idea", label: "feedback.kind.idea" },
  { value: "complaint", label: "feedback.kind.complaint" },
  { value: "praise", label: "feedback.kind.praise" },
];

/** What the app runs on, as the contract names it; the web preview and anything else count as web. */
const platformOf = (os: string): FeedbackPlatform =>
  os === "ios" || os === "android" ? os : "web";

type State = "idle" | "sending" | "sent" | "failed" | "limited";

/**
 * Give feedback (#171, ADR-023), under its row in Settings (#511): a kind, a
 * few lines, Send. The app's version,
 * the platform and the language go along, read by the app and never typed.
 * The kind is chosen in words (the ticked option, never a colour alone);
 * after a send the screen says thank you and offers the empty form again.
 * The day's cap and a failure are said in their own words, the words kept.
 */
export function FeedbackForm() {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const session = useSession();
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<State>("idle");
  const words = text.trim();
  // Words not sent go nowhere: Settings asks before they are left (#511).
  useReportUnsaved("feedback", state !== "sent" && words.length > 0);

  const send = async () => {
    if (!kind || words.length === 0) return;
    setState("sending");
    try {
      await sendFeedback({
        kind,
        text: words,
        appVersion: buildInfo().version ?? "?",
        platform: platformOf(Platform.OS),
        locale,
      });
      setKind(null);
      setText("");
      setState("sent");
    } catch (error) {
      setState(error instanceof ApiError && error.status === 429 ? "limited" : "failed");
    }
  };

  return (
    <>
      {session.status !== "signed-in" ? (
        <Text variant="muted">{t("settings.session.none")}</Text>
      ) : state === "sent" ? (
        <View className="gap-3">
          <Text variant="title">{t("feedback.thanks.title")}</Text>
          <Notice words={t("feedback.thanks.body")} />
          <Button
            variant="outline"
            onPress={() => {
              tap();
              setState("idle");
            }}
          >
            {t("feedback.another")}
          </Button>
        </View>
      ) : (
        <>
          <Text>{t("feedback.explain")}</Text>
          {/* The question in sight above the four kinds; the group carries it as its name too. */}
          {/* role, not accessibilityRole: the primitive sets role from its variant, and small has none. */}
          <Text variant="small" role="heading" aria-level="3">
            {t("feedback.kind.label")}
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("feedback.kind.label")}
            className="flex-row flex-wrap gap-2"
          >
            {KINDS.map(({ value, label }) => (
              <Choice
                key={value}
                label={t(label)}
                chosen={kind === value}
                onPress={() => {
                  tap();
                  setKind(value);
                }}
              />
            ))}
          </View>
          {/* The field's name in sight too, not only for a screen reader. */}
          <Text variant="small">{t("feedback.text.label")}</Text>
          <Input
            accessibilityLabel={t("feedback.text.label")}
            value={text}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            maxLength={FEEDBACK_TEXT_MAX}
            editable={state !== "sending"}
            className="min-h-32"
            onChangeText={(value) => {
              if (state !== "sending") setState("idle");
              setText(value);
            }}
          />
          {(state === "failed" || state === "limited") && (
            <Notice
              refused
              words={state === "limited" ? t("feedback.limited") : t("feedback.failed")}
            />
          )}
          <Button
            disabled={!kind || words.length === 0 || state === "sending"}
            onPress={() => {
              tap();
              void send();
            }}
          >
            {state === "sending" ? t("feedback.sending") : t("feedback.send")}
          </Button>
        </>
      )}
    </>
  );
}
