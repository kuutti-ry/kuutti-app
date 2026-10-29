import type { PlainMessageKey } from "@kuutti/i18n";
import type { NotificationChoice, NotificationKind } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useRowData } from "@/lib/row-data";
import { useHapticTap } from "@/theme/haptics";
import { fetchChoices, saveChoice } from "./client";
import { PhoneLine } from "./PhoneLine";

const WORDS: Record<NotificationKind, { label: PlainMessageKey; hint: PlainMessageKey }> = {
  round: { label: "notifications.kind.round.label", hint: "notifications.kind.round.hint" },
  message: { label: "notifications.kind.message.label", hint: "notifications.kind.message.hint" },
  match: { label: "notifications.kind.match.label", hint: "notifications.kind.match.hint" },
  moderation: {
    label: "notifications.kind.moderation.label",
    hint: "notifications.kind.moderation.hint",
  },
};

type ChoicesView =
  | { status: "loading" }
  | { status: "failed"; error: unknown }
  | { status: "ready"; choices: NotificationChoice[] };

/**
 * What a person may be notified of (#176, ADR-032): one switch per kind, in
 * the API's order, each with its line, each on until switched off, stored on
 * the server so every phone of the person's and every later sender reads the
 * same. A press saves at once; while it is on its way the switch waits, and a
 * failure is said in words with the switch as it was. Above the switches,
 * whether this phone lets Kuutti notify it at all (#102, ADR-055 §9). The
 * choices as read or stored go to `onStored`, for the row above (#511).
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
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <>
      <Text>{t("notifications.intro")}</Text>
      <PhoneLine />
      {view.status === "loading" && (
        <Text accessibilityLiveRegion="polite">{t("notifications.loading")}</Text>
      )}
      {view.status === "failed" && (
        <LoadFailed headline={t("notifications.failed")} error={view.error} onRetry={read} />
      )}
      {view.status === "ready" &&
        view.choices.map(({ kind, enabled }) => {
          const label = t(WORDS[kind].label);
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
              <Text variant="muted">{t(WORDS[kind].hint)}</Text>
            </View>
          );
        })}
      {failed && <Text accessibilityLiveRegion="assertive">{t("notifications.saveFailed")}</Text>}
    </>
  );
}

/** The choices alone, for the row's value; a module's function, so the row's read stays the same one. */
const readChoices = () => fetchChoices().then(({ choices }) => choices);

/** The Notifications row's value in Settings (#376, #511): all on, all off, or how many of them are on. */
export function useNotificationsSummary(enabled: boolean) {
  const { t } = useT();
  const { data, stored } = useRowData<readonly NotificationChoice[]>(readChoices, enabled);
  const on = data?.filter((choice) => choice.enabled).length ?? 0;
  const summary =
    data === undefined
      ? undefined
      : on === data.length
        ? t("settings.notifications.allOn")
        : on === 0
          ? t("settings.notifications.allOff")
          : t("settings.notifications.someOn", { on, off: data.length - on });
  return { summary, stored };
}
