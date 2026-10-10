import {
  DEAL_BREAKER_FIELDS,
  type DealBreakerField,
  type DealBreakersUpdate,
  LATER_FIELD_ORDER,
  PROFILE_FIELDS,
  type StoredDealBreaker,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchDealBreakers, saveDealBreakers } from "./client";
import { Chip, SEARCHABLE_FROM } from "./FieldEditor";
import { fieldLabelKey, optionKey } from "./keys";
import { laterPath } from "./later/LaterFieldScreen";
import { useProfile } from "./useProfile";

export const DEAL_BREAKERS_PATH = "/profile/deal-breakers" as const;

type Row = { on: boolean; accept: string[]; includeUnknown: boolean };
type Draft = Partial<Record<DealBreakerField, Row>>;
const OFF: Row = { on: false, accept: [], includeUnknown: false };

const draftOf = (stored: StoredDealBreaker[]): Draft => {
  const draft: Draft = {};
  for (const d of stored)
    draft[d.field] = { on: true, accept: d.accept, includeUnknown: d.includeUnknown };
  return draft;
};

/** What is sent: the deal-breakers that are on, in the registry's order. */
export const updateOf = (draft: Draft): DealBreakersUpdate => ({
  dealBreakers: DEAL_BREAKER_FIELDS.flatMap((field) => {
    const row = draft[field];
    return row?.on ? [{ field, accept: row.accept, includeUnknown: row.includeUnknown }] : [];
  }),
});

const optionsOf = (field: DealBreakerField): readonly string[] => {
  const spec = PROFILE_FIELDS[field];
  return spec.kind === "single" || spec.kind === "multi" ? spec.options : [];
};

/**
 * The deal-breakers under the disclose-to-filter rule (#149, TD-16): up to
 * `max`, each only on a field the person answered themselves, so the screen
 * doubles as profile completion ("to filter on this, share yours first",
 * with the way to that field's screen). A deal-breaker whose own answer was
 * taken back is paused, said in words; the rows stay. #87 applies them in
 * the pool, both ways.
 */
export function DealBreakersScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const profile = useProfile();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [max, setMax] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [search, setSearch] = useState<Partial<Record<DealBreakerField, string>>>({});
  const [notice, setNotice] = useState<"saved" | "failed" | "limit" | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetchDealBreakers();
      setMax(response.max);
      setDraft(draftOf(response.dealBreakers));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (profile.status === "loading" || status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("profile.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (profile.status === "error" || status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <Text accessibilityLiveRegion="assertive">{t("profile.failed")}</Text>
          <Button
            onPress={() => {
              void profile.reload();
              void load();
            }}
          >
            {t("profile.retry")}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  const own = profile.draft.fields as Record<string, unknown>;
  const count = DEAL_BREAKER_FIELDS.filter((field) => draft[field]?.on).length;
  const incomplete = DEAL_BREAKER_FIELDS.some(
    (field) => draft[field]?.on && draft[field]?.accept.length === 0,
  );
  const set = (field: DealBreakerField, patch: Partial<Row>) => {
    setNotice(null);
    setDraft((previous) => ({ ...previous, [field]: { ...(previous[field] ?? OFF), ...patch } }));
  };
  const toggle = (field: DealBreakerField, on: boolean) => {
    if (on && count >= max) {
      setNotice("limit");
      return;
    }
    set(field, { on });
  };
  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const response = await saveDealBreakers(updateOf(draft));
      setMax(response.max);
      setDraft(draftOf(response.dealBreakers));
      setNotice("saved");
    } catch {
      setNotice("failed");
    } finally {
      setSaving(false);
    }
  };
  const answerIt = (field: DealBreakerField) => (
    <Button
      variant="outline"
      onPress={() => {
        tap();
        // A field of the later screens opens its own; the rest (monogamy) is
        // answered on the profile screen, which has every field (10/10/2026:
        // "Answer it" on relationship structure opened the first unanswered
        // later field instead).
        router.push(
          (LATER_FIELD_ORDER as readonly string[]).includes(field) ? laterPath(field) : "/profile",
        );
      }}
    >
      {t("profile.dealBreakers.answer")}
    </Button>
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="h1" accessibilityRole="header">
          {t("profile.dealBreakers.title")}
        </Text>
        <Text>{t("profile.dealBreakers.explain", { max })}</Text>

        {DEAL_BREAKER_FIELDS.map((field) => {
          const label = t(fieldLabelKey(field));
          const row = draft[field] ?? OFF;
          const answered = own[field] !== undefined;
          const options = optionsOf(field);
          const needle = (search[field] ?? "").trim().toLowerCase();
          const shown =
            needle === ""
              ? options
              : options.filter((option) =>
                  t(optionKey(field, option)).toLowerCase().includes(needle),
                );
          return (
            <View key={field} className="gap-2">
              <View className="flex-row items-center justify-between gap-3">
                <Text variant="small" className="flex-1">
                  {label}
                </Text>
                {(answered || row.on) && (
                  <Switch
                    accessibilityLabel={t("profile.dealBreakers.switch", { field: label })}
                    checked={row.on}
                    onCheckedChange={(on) => {
                      tap();
                      toggle(field, on);
                    }}
                  />
                )}
              </View>
              {/* The disclose-to-filter rule, at the moment it matters: the field's own screen is one tap away. */}
              {!answered && !row.on && (
                <>
                  <Text variant="muted">{t("profile.dealBreakers.gated")}</Text>
                  {answerIt(field)}
                </>
              )}
              {!answered && row.on && (
                <>
                  <Text accessibilityLiveRegion="polite">{t("profile.dealBreakers.paused")}</Text>
                  {answerIt(field)}
                </>
              )}
              {row.on && (
                <>
                  <Text variant="muted">{t("profile.dealBreakers.accept")}</Text>
                  {options.length >= SEARCHABLE_FROM && (
                    <Input
                      accessibilityLabel={t("profile.later.search")}
                      placeholder={t("profile.later.search")}
                      value={search[field] ?? ""}
                      onChangeText={(text) => setSearch((s) => ({ ...s, [field]: text }))}
                    />
                  )}
                  <View className="flex-row flex-wrap gap-2">
                    {shown.map((option) => {
                      const selected = row.accept.includes(option);
                      return (
                        <Chip
                          key={option}
                          label={t(optionKey(field, option))}
                          selected={selected}
                          onPress={() => {
                            tap();
                            set(field, {
                              accept: selected
                                ? row.accept.filter((o) => o !== option)
                                : [...row.accept, option],
                            });
                          }}
                        />
                      );
                    })}
                  </View>
                  <View className="flex-row items-center justify-between gap-3">
                    <Text variant="small" className="flex-1">
                      {t("profile.dealBreakers.includeUnknown")}
                    </Text>
                    <Switch
                      accessibilityLabel={t("profile.dealBreakers.includeUnknown")}
                      checked={row.includeUnknown}
                      onCheckedChange={(includeUnknown) => {
                        tap();
                        set(field, { includeUnknown });
                      }}
                    />
                  </View>
                </>
              )}
            </View>
          );
        })}

        {incomplete && <Text variant="muted">{t("profile.dealBreakers.pickOne")}</Text>}
        {notice === "limit" && (
          <Text accessibilityLiveRegion="assertive">
            {t("profile.dealBreakers.limit", { max })}
          </Text>
        )}
        {notice === "saved" && (
          <Text accessibilityLiveRegion="polite">{t("profile.dealBreakers.saved")}</Text>
        )}
        {notice === "failed" && (
          <Text accessibilityLiveRegion="assertive">{t("profile.dealBreakers.failed")}</Text>
        )}
        {saving && <Text accessibilityLiveRegion="polite">{t("profile.saving")}</Text>}
        <Button
          disabled={saving || incomplete}
          onPress={() => {
            tap();
            void save();
          }}
        >
          {t("profile.dealBreakers.save")}
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}
