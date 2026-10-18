import type { PlainMessageKey } from "@kuutti/i18n";
import type { Notice, SanctionReason } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchNotices, markNoticeRead } from "./client";

/** A warning's reason in the words the export gives it (ADR-024 §8). */
const REASONS: Record<SanctionReason, PlainMessageKey> = {
  harassment: "account.export.sanction.reason.harassment",
  misrepresentation: "account.export.sanction.reason.misrepresentation",
  under_age: "account.export.sanction.reason.under_age",
  commercial_use: "account.export.sanction.reason.commercial_use",
  scraping: "account.export.sanction.reason.scraping",
  other: "account.export.sanction.reason.other",
};

/**
 * The notices on the home screen (#176, ADR-032): what must reach the person
 * even without a push, the unread ones only, newest first, under a heading of
 * their own; nothing at all when there are none. Today that is a moderator's
 * warning with its reason (ADR-024 §7). Each has Got it, a button, which marks
 * it read and takes it off the screen; a failure says so and keeps it. Read
 * again whenever the home screen comes into focus. A notice that cannot be
 * read is left out quietly: the home screen does not fail for it.
 */
export function Notices() {
  const { t } = useT();
  const tap = useHapticTap();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const focused = useRef(false);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      fetchNotices().then(
        (answer) => focused.current && setNotices(answer.notices.filter((n) => !n.readAt)),
        () => undefined,
      );
      return () => {
        focused.current = false;
      };
    }, []),
  );

  const read = async (notice: Notice) => {
    tap();
    setFailed(null);
    try {
      await markNoticeRead(notice.id);
      setNotices((shown) => shown.filter((n) => n.id !== notice.id));
    } catch {
      setFailed(notice.id);
      // Android's live region speaks it; iOS has none.
      if (Platform.OS === "ios")
        AccessibilityInfo.announceForAccessibility(t("notices.readFailed"));
    }
  };

  if (notices.length === 0) return null;
  return (
    <View className="gap-3">
      <Text variant="h4" accessibilityRole="header">
        {t("notices.title")}
      </Text>
      {notices.map((notice) => (
        <View key={notice.id} className="gap-2 rounded-lg border border-border p-4">
          <Text className="font-semibold">{t("notices.warning.title")}</Text>
          <Text>{t("notices.warning.body", { reason: t(REASONS[notice.reason]) })}</Text>
          {failed === notice.id && (
            <Text accessibilityLiveRegion="assertive">{t("notices.readFailed")}</Text>
          )}
          <Button variant="outline" onPress={() => void read(notice)}>
            {t("notices.read")}
          </Button>
        </View>
      ))}
    </View>
  );
}
