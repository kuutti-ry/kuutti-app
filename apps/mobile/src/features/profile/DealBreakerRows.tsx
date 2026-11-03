import {
  DealBreakerField,
  type DealBreakersResponse,
  dealBreakerOptions,
  type ProfileFields,
  type StoredDealBreaker,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { RowGroup } from "@/components/RowGroup";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchDealBreakers } from "./client";
import { FIELD_ICONS } from "./fieldIcons";
import { fieldLabelKey, filterOptionKey } from "./keys";

export const DEAL_BREAKERS_PATH = "/profile/deal-breakers" as const;

export const dealBreakerPath = (field: DealBreakerField) =>
  `${DEAL_BREAKERS_PATH}/${field}` as const;

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
 * shows what a person has shared at the first glance. The state is the row's
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
  const wordsOf = (field: DealBreakerField): string | undefined => {
    if (!response) return undefined;
    const filter = response.dealBreakers.find((dealBreaker) => dealBreaker.field === field);
    if (filter?.paused) return t("profile.dealBreakers.paused");
    if (filter) return acceptedWords(t, filter);
    return t(
      isOpenToFilter(field, own)
        ? "profile.dealBreakers.everyone"
        : "profile.dealBreakers.shareFirst",
    );
  };
  return (
    <>
      {response && <Text>{t("profile.dealBreakers.explain", { max: response.max })}</Text>}
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
              router.push(dealBreakerPath(field));
            },
          };
        })}
      />
    </>
  );
}
