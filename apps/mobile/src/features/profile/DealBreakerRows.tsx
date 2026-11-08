import {
  DealBreakerField,
  type DealBreakersResponse,
  dealBreakerOptions,
  LATER_FIELD_ORDER,
  type ProfileFields,
  type StoredDealBreaker,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { RowGroup } from "@/components/RowGroup";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchDealBreakers } from "./client";
import { FIELD_ICONS } from "./fieldIcons";
import { fieldLabelKey, filterOptionKey } from "./keys";
import { laterAnswerPath } from "./later/LaterFieldScreen";
import { sectionAnswerPath, sectionOf } from "./sections";

export const dealBreakerPath = (field: DealBreakerField) =>
  `/profile/deal-breakers/${field}` as const;

/**
 * Where the own answer a deal-breaker asks for is given, which comes back (#542):
 * a field of the later screens opens its own; the rest (monogamy) is answered
 * in the section that holds it (10/10/2026: its "Answer it" opened the first
 * unanswered later field instead).
 */
export const ownAnswerPath = (field: Exclude<DealBreakerField, "distance">) =>
  (LATER_FIELD_ORDER as readonly string[]).includes(field)
    ? laterAnswerPath(field)
    : sectionAnswerPath(sectionOf(field));

/** How many answers a row names before it says how many more: a filter takes sixty (#551). */
const ROW_ANSWERS = 3;

/** The own answer a deal-breaker asks for is given; the distance asks for none, since everybody has a home (ADR-061 §7). */
export const isOpenToFilter = (field: DealBreakerField, own: ProfileFields): boolean =>
  field === "distance" || own[field] !== undefined;

/**
 * The deal-breakers as stored; null until known, and when they could not be
 * read: the rows then say nothing of them, and each one's screen says what failed.
 */
export function useDealBreakers(): [DealBreakersResponse | null, () => void] {
  const [response, setResponse] = useState<DealBreakersResponse | null>(null);
  const read = useCallback(() => {
    fetchDealBreakers().then(setResponse, () => setResponse(null));
  }, []);
  return [response, read];
}

/** What a filter accepts, as a row says it; a distance by its farthest band, as its button does (ADR-061 §7). */
function acceptedWords(
  t: ReturnType<typeof useT>["t"],
  { field, accept }: StoredDealBreaker,
): string {
  const accepted = dealBreakerOptions(field).filter((option) => accept.includes(option));
  const words = (field === "distance" ? accepted.slice(-1) : accepted).map((option) =>
    t(filterOptionKey(field, option)),
  );
  if (words.length <= ROW_ANSWERS) return words.join(", ");
  return t("profile.dealBreakers.more", {
    answers: words.slice(0, ROW_ANSWERS).join(", "),
    more: words.length - ROW_ANSWERS,
  });
}

/**
 * A row per deal-breaker, the fields' order with the distance last (ADR-061
 * §7), each saying what it holds and opening its own screen (#551): the list
 * shows what a person has shared at the first glance. A row that says Share
 * yours first opens the question itself, since that screen would only say the
 * row again (#581), and a paused one keeps its screen. The state is the row's
 * value, drawn under the title and heard once, as on What you seek.
 */
export function DealBreakerRows({
  response,
  own,
}: {
  response: DealBreakersResponse | null;
  own: ProfileFields;
}) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const filterOf = (field: DealBreakerField) =>
    response?.dealBreakers.find((dealBreaker) => dealBreaker.field === field);
  const wordsOf = (field: DealBreakerField): string | undefined => {
    if (!response) return undefined;
    const filter = filterOf(field);
    if (filter?.paused) return t("profile.dealBreakers.paused");
    if (filter) return acceptedWords(t, filter);
    return t(
      isOpenToFilter(field, own)
        ? "profile.dealBreakers.everyone"
        : "profile.dealBreakers.shareFirst",
    );
  };
  return (
    <RowGroup
      rows={DealBreakerField.options.map((field) => {
        const words = wordsOf(field);
        return {
          key: field,
          icon: FIELD_ICONS[field],
          title: t(fieldLabelKey(field)),
          summary: words,
          value: words,
          onPress: () => {
            tap();
            router.push(
              // With nothing read, its screen says what failed.
              response && field !== "distance" && !filterOf(field) && !isOpenToFilter(field, own)
                ? ownAnswerPath(field)
                : dealBreakerPath(field),
            );
          },
        };
      })}
    />
  );
}
