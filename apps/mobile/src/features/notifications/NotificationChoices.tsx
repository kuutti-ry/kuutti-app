import type { PlainMessageKey } from "@kuutti/i18n";
import type { NotificationChoice, NotificationKind } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Notice } from "@/components/Notice";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useRowData } from "@/lib/row-data";
import { useHapticTap } from "@/theme/haptics";
import { fetchChoices, saveChoice } from "./client";
import { PhoneLine } from "./PhoneLine";
import { usePhonePermission } from "./usePhonePermission";

/** A kind's name; a line under it only where the switch does less than it seems to. */
const WORDS: Record<NotificationKind, { label: PlainMessageKey; hint?: PlainMessageKey }> = {
  message: { label: "notifications.kind.message.label" },
  match: { label: "notifications.kind.match.label" },
  moderation: {
    label: "notifications.kind.moderation.label",
    hint: "notifications.kind.moderation.hint",
  },
  // Off stops the push and the email, never the notice (#573, ADR-068 §6).
  announcement: {
    label: "notifications.kind.announcement.label",
    hint: "notifications.kind.announcement.hint",
  },
};

type ChoicesView =
  | { status: "loading" }
  | { status: "failed"; error: unknown }
  | { status: "ready"; choices: NotificationChoice[] };

/**
 * What a person may be notified of (#176, ADR-032): one switch per kind, in
 * the API's order, each on until switched off, stored on the server so every
 * phone of the person's and every later sender reads the same. A press saves
 * at once; while it is on its way the switch waits, and a failure is said in
 * words with the switch as it was. First, what this phone's answer leaves to
 * do (#102, ADR-055 §9), then what a notification says. The choices as read
 * or stored go to `onStored`, for the row above (#511).
 */
export function NotificationChoices({
  onStored,
}: {
  onStored?: (choices: readonly NotificationChoice[]) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const [view, setView] = useState<ChoicesView>({ status: "loading" });
  const [busy, setBusy] = useState<NotificationKind | null>(null);
  const [failed, setFailed] = useState(false);
  // Which failure the words are, so a second one is said again.
  const [failures, setFailures] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(() => {
    setView({ status: "loading" });
    fetchChoices().then(
      ({ choices }) => mounted.current && setView({ status: "ready", choices }),
      (error: unknown) => mounted.current && setView({ status: "failed", error }),
    );
  }, []);
  useEffect(read, [read]);
  useEffect(() => {
    if (view.status === "ready") onStored?.(view.choices);
  }, [view, onStored]);

  const set = async (kind: NotificationKind, enabled: boolean) => {
    tap();
    setFailed(false);
    setBusy(kind);
    try {
      const { choices } = await saveChoice(kind, enabled);
      if (mounted.current) setView({ status: "ready", choices });
    } catch {
      if (mounted.current) {
        setFailed(true);
        setFailures((n) => n + 1);
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <>
      <PhoneLine />
      <Text>{t("notifications.intro")}</Text>
      {view.status === "loading" && (
        <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
      )}
      {view.status === "failed" && <LoadFailed error={view.error} onRetry={read} />}
      {view.status === "ready" &&
        view.choices.map(({ kind, enabled }) => {
          const { label: labelKey, hint } = WORDS[kind];
          const label = t(labelKey);
          return (
            <View key={kind} className="gap-1">
              <View className="flex-row items-center justify-between gap-4">
                <Label onPress={() => busy === null && void set(kind, !enabled)}>{label}</Label>
                <Switch
                  accessibilityLabel={label}
                  checked={enabled}
                  disabled={busy !== null}
                  onCheckedChange={(on) => void set(kind, on)}
                />
              </View>
              {hint && <Text variant="muted">{t(hint)}</Text>}
            </View>
          );
        })}
      {failed && <Notice refused words={t("load.failed.press")} answer={failures} />}
    </>
  );
}

/** The choices alone, for the row's value; a module's function, so the row's read stays the same one. */
const readChoices = () => fetchChoices().then(({ choices }) => choices);

/**
 * The Notifications row's value in Settings (#376, #511): that the phone
 * refuses them, marked, since nothing then reaches the person whatever the
 * switches say; that the phone was not asked yet; or all on, all off, or how
 * many of them are on.
 */
export function useNotificationsSummary(enabled: boolean) {
  const { t } = useT();
  const { data, stored } = useRowData<readonly NotificationChoice[]>(readChoices, enabled);
  const { permission } = usePhonePermission();
  const on = data?.filter((choice) => choice.enabled).length ?? 0;
  const blocked = enabled && permission === "denied";
  const summary = !enabled
    ? undefined
    : blocked
      ? t("settings.notifications.blocked")
      : permission === "undetermined"
        ? t("settings.notifications.notAsked")
        : data === undefined
          ? undefined
          : on === data.length
            ? t("settings.notifications.allOn")
            : on === 0
              ? t("settings.notifications.allOff")
              : t("settings.notifications.someOn", { on, off: data.length - on });
  return { summary, alert: blocked, stored };
}
