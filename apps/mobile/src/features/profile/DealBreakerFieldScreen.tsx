import {
  DealBreakerField,
  type DealBreakersResponse,
  DISTANCE_FILTER_BANDS,
  dealBreakerOptions,
  PROFILE_FIELDS,
} from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Choice } from "@/components/Choice";
import { LoadFailed } from "@/components/LoadFailed";
import { Notice, sayAloud } from "@/components/Notice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { ConfirmLeaveDialog } from "./ConfirmLeave";
import { type DealBreakerFilter, fetchDealBreakers, saveDealBreaker } from "./client";
import { dealBreakerPath, isOpenToFilter, ownAnswerPath } from "./DealBreakerRows";
import { profileErrorText } from "./errorText";
import { Chip, ROWS_UP_TO, SEARCHABLE_FROM, visibleOptions } from "./FieldEditor";
import { fieldLabelKey, filterOptionKey } from "./keys";
import { SEEK_PATH } from "./seek/SeekScreen";
import { type ProfileNotice, useProfile } from "./useProfile";
import { useRefusedDraft, useSaveOnLeave } from "./useSaveOnLeave";

/** A new deal-breaker lets through who did not answer its field until switched off (TD-12, ADR-042 §8). */
const EVERYONE: DealBreakerFilter = { accept: [], includeUnknown: true };

/** A change the API refused after the screen had gone, and why. */
type HeldFilter = { filter: DealBreakerFilter; notice: NonNullable<ProfileNotice> };

/** The same filter, whatever order its answers were pressed in; Everyone has no switch to differ by. */
const sameFilter = (a: DealBreakerFilter, b: DealBreakerFilter): boolean =>
  a.accept.length === b.accept.length &&
  a.accept.every((option) => b.accept.includes(option)) &&
  (a.accept.length === 0 || a.includeUnknown === b.includeUnknown);

/** Height and the distance take one answer, a relation or a band; a list takes as many as are fine. */
const takesOne = (field: DealBreakerField): boolean =>
  field === "distance" || PROFILE_FIELDS[field].kind === "number";

/** A distance filter takes every band up to the one chosen (ADR-061 §7). */
const acceptOf = (field: DealBreakerField, answer: string): string[] =>
  field === "distance"
    ? DISTANCE_FILTER_BANDS.slice(
        0,
        (DISTANCE_FILTER_BANDS as readonly string[]).indexOf(answer) + 1,
      )
    : [answer];

/** Which buttons stand for an accepted list: on the distance, its farthest band alone. */
const isChosen = (field: DealBreakerField, option: string, accept: readonly string[]): boolean =>
  field === "distance"
    ? DISTANCE_FILTER_BANDS.filter((band) => accept.includes(band)).at(-1) === option
    : accept.includes(option);

/** How many options lead the accept list before the search: the languages' first ten, as in their picker (#239). */
const shownFirstOf = (field: DealBreakerField): number | undefined => {
  if (field === "distance") return undefined;
  const spec = PROFILE_FIELDS[field];
  return spec.kind === "multi" ? spec.shownFirst : undefined;
};

/**
 * One deal-breaker on a screen of its own (#551), saved on leaving as What you
 * seek's other screens are. Everyone comes first, which is having none, then
 * the answers that are fine, as whole-width rows unless the list is long (#581):
 * taking back the last one returns to Everyone, which fills by itself and is
 * said to a screen reader, so no filter can stand empty and no switch turns one
 * on. The disclose-to-filter rule (#149, TD-16) says itself here: a filter
 * already set whose own answer is missing is paused, its answers drawn
 * read-only, since the API refuses a change to it, with the way to that answer,
 * which comes back here. Everyone still takes it off, and then the line says a
 * new filter asks for that answer first, as it does for a typed address: a
 * row with no filter opens the question itself (DealBreakerRows). The distance
 * asks nothing of the kind, since everybody has a home (ADR-061 §7). What the
 * answer leaves is never counted (#502).
 */
export function DealBreakerFieldScreen({ field: key }: { field: string }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const field = DealBreakerField.safeParse(key).data;
  const path = dealBreakerPath(key as DealBreakerField);
  const held = useRefusedDraft<HeldFilter>(path);
  const profile = useProfile();
  const { reload } = profile;
  const [response, setResponse] = useState<DealBreakersResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [draft, setDraft] = useState<DealBreakerFilter | null>(held?.filter ?? null);
  const [search, setSearch] = useState("");
  // An option once pressed stays in view on this visit, accepted or not, as in the field editor (#239).
  const [seen, setSeen] = useState<readonly string[]>([]);
  // How many times an answer was pressed past the limit: each is said, and any other choice ends them.
  const [refused, setRefused] = useState(0);

  // Anything that is not a deal-breaker goes to the list: a typed address, an old link.
  useEffect(() => {
    if (!field) router.replace(SEEK_PATH);
  }, [field, router]);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      setResponse(await fetchDealBreakers());
    } catch (error) {
      setFailure(error);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // An answer given from "Answer it" opens the screen, so the person's own
  // answers are read again on the way back; the draft is this screen's and
  // stays. The first focus is the mount, which the hook reads already.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
    }, [reload]),
  );

  const stored = response?.dealBreakers.find((dealBreaker) => dealBreaker.field === field);
  const leaving = useSaveOnLeave<HeldFilter>({
    screen: path,
    path,
    held: held !== undefined,
    save: () => {
      // With nothing stored to compare with (the read failed too), a draft is tried again.
      if (!field || !draft || (response && sameFilter(draft, stored ?? EVERYONE))) return null;
      return saveDealBreaker(field, draft).then(
        () => null,
        (error: unknown) => ({
          filter: draft,
          notice: { kind: "error", code: error instanceof ApiError ? error.code : undefined },
        }),
      );
    },
  });

  if (!field) return null;

  const failed = profile.status === "error" || failure !== null;
  // A change brought back outlives a read that failed: see SeekWhomScreen.
  if (failed && !draft) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed
            error={profile.status === "error" ? profile.error : failure}
            onRetry={() => {
              void reload();
              void load();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }
  if (!failed && (profile.status === "loading" || !response)) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const filter = draft ?? stored ?? EVERYONE;
  const { accept, includeUnknown } = filter;
  const on = accept.length > 0;
  // Not known with the reads failed: the draft held then is shown to be changed or let go.
  const answered = profile.status !== "ready" || isOpenToFilter(field, profile.saved.fields);
  const textOf = (option: string) => t(filterOptionKey(field, option));
  const options = dealBreakerOptions(field);
  const change = (next: Partial<DealBreakerFilter>) =>
    setDraft({ accept, includeUnknown, ...next });
  const choose = (option: string) => {
    tap();
    const chosen = isChosen(field, option, accept);
    // Only a new field counts against the limit, as on the API: one stored may change, and come back after Everyone.
    if (!chosen && !stored && response && response.dealBreakers.length >= response.max) {
      setRefused((times) => times + 1);
      return;
    }
    setRefused(0);
    setSeen((was) => [...was, option]);
    const next = takesOne(field)
      ? chosen
        ? []
        : acceptOf(field, option)
      : chosen
        ? accept.filter((o) => o !== option)
        : [...accept, option];
    if (next.length === 0) sayAloud(t("profile.dealBreakers.everyoneAgain"));
    change({ accept: next });
  };
  // A short list stands as whole-width rows (FieldEditor's ROWS_UP_TO), the languages as chips.
  const rows = options.length <= ROWS_UP_TO;
  const drawn = (
    id: string,
    label: string,
    chosen: boolean,
    disabled: boolean,
    onPress: () => void,
  ) =>
    rows ? (
      <Choice
        key={id}
        label={label}
        chosen={chosen}
        several={!takesOne(field)}
        disabled={disabled}
        onPress={onPress}
      />
    ) : (
      <Chip key={id} label={label} selected={chosen} disabled={disabled} onPress={onPress} />
    );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t(fieldLabelKey(field))}
        backLabel={t("profile.dealBreakers.back")}
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        {/* The disclose-to-filter rule, at the moment it matters: the field's own screen is one tap away. */}
        {!answered && field !== "distance" && (
          <View className="gap-2">
            <Text>{t(on ? "profile.dealBreakers.paused" : "profile.dealBreakers.gated")}</Text>
            <Button
              variant="outline"
              onPress={() => {
                tap();
                router.push(ownAnswerPath(field));
              }}
            >
              {t("profile.dealBreakers.answer")}
            </Button>
          </View>
        )}

        {(answered || on) && (
          <View className="gap-2">
            <Text variant="muted">{t("profile.dealBreakers.accept")}</Text>
            {answered && options.length >= SEARCHABLE_FROM && (
              <Input
                accessibilityLabel={t("profile.later.search")}
                placeholder={t("profile.later.search")}
                value={search}
                autoCapitalize="none"
                onChangeText={setSearch}
              />
            )}
            <View
              accessibilityRole={rows && takesOne(field) ? "radiogroup" : undefined}
              accessibilityLabel={
                rows && takesOne(field) ? t("profile.dealBreakers.accept") : undefined
              }
              className={rows ? "gap-2" : "flex-row flex-wrap gap-2"}
            >
              {drawn("everyone", t("profile.dealBreakers.everyone"), !on, false, () => {
                tap();
                // Paused, the answers go and the line above them changes, with nothing left in focus.
                if (on && !answered) sayAloud(t("profile.dealBreakers.everyoneAgain"));
                setRefused(0);
                change({ accept: [] });
              })}
              {/* Paused, only what stands: every answer drawn alike read-only would not say which. */}
              {(answered
                ? visibleOptions(options, shownFirstOf(field), [...accept, ...seen], search, textOf)
                : options.filter((option) => isChosen(field, option, accept))
              ).map((option) =>
                drawn(option, textOf(option), isChosen(field, option, accept), !answered, () =>
                  choose(option),
                ),
              )}
            </View>
          </View>
        )}
        {refused > 0 && response && (
          <Notice
            words={t("profile.dealBreakers.limit", { max: response.max })}
            refused
            answer={refused}
          />
        )}

        {on && field !== "distance" && (
          <View className="flex-row items-center justify-between gap-3">
            <Text variant="small" className="flex-1">
              {t("profile.dealBreakers.includeUnknown")}
            </Text>
            <Switch
              accessibilityLabel={t("profile.dealBreakers.includeUnknown")}
              checked={includeUnknown}
              disabled={!answered}
              onCheckedChange={(next) => {
                tap();
                change({ includeUnknown: next });
              }}
            />
          </View>
        )}
      </ScrollView>
      <ConfirmLeaveDialog
        {...leaving}
        reason={held && profileErrorText(held.notice, t, "load.failed.press")}
      />
    </SafeAreaView>
  );
}
