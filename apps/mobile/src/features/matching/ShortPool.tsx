import type { DealBreakerField, Relaxation, RelaxationsResponse } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { fieldLabelKey } from "@/features/profile";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchRelaxations } from "./client";

/** The two ways to relax a deal-breaker, in the order they are offered: each says its words once, over its rows (#581). */
const WAYS = [
  {
    kind: "unanswered",
    heading: "round.short.unanswered.title",
    spoken: "round.short.unanswered",
  },
  { kind: "aside", heading: "round.short.aside.title", spoken: "round.short.aside" },
] as const;

/**
 * The short pool (#99, ADR-042, ADR-062 §10), at the queue's end: what the
 * person may relax for today, a group for each way under a heading that says it,
 * its "today" carrying that nothing changes tomorrow (#581), and in it a button
 * for each deal-breaker that says the field and how much it widens their pool
 * (in the counter's steps, `pond_counter_k`, never a count of cards), its whole
 * sentence its spoken label; and what is relaxed today, each undone by one tap.
 * Only the heading is bold: a button's text is by default, so the field says
 * medium and how much regular (the maintainer's note on too much bold, #581).
 * Read when it comes into sight, as the offers are counted on asking, and
 * again after each tap. Nothing relaxes but the person's tap; a read that
 * fails shows nothing, and the end stands as it does without offers.
 */
export function ShortPool({
  day,
  busy,
  onRelax,
  onUndo,
}: {
  day: string;
  busy: boolean;
  onRelax: (relaxation: Relaxation) => Promise<void>;
  onUndo: (field: DealBreakerField) => Promise<void>;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const [pool, setPool] = useState<RelaxationsResponse | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let live = true;
    fetchRelaxations(day).then(
      (read) => live && setPool(read),
      () => live && setPool(null),
    );
    return () => {
      live = false;
    };
    // `asked` reads again after each tap.
  }, [day, asked]);

  if (!pool || (pool.offers.length === 0 && pool.relaxed.length === 0)) return null;
  const field = (key: DealBreakerField) => t(fieldLabelKey(key));
  const then = (done: Promise<void>) => {
    void done.finally(() => setAsked((n) => n + 1));
  };

  return (
    <View className="gap-4">
      {pool.offers.length > 0 && (
        <>
          <Text variant="h3" accessibilityRole="header">
            {t("round.short.title")}
          </Text>
          {WAYS.map(({ kind, heading, spoken }) => {
            const offers = pool.offers.filter((offer) => offer.kind === kind);
            if (offers.length === 0) return null;
            return (
              <View key={kind} className="gap-2">
                <Text variant="title">{t(heading)}</Text>
                {offers.map((offer) => {
                  const what = t(spoken, { field: field(offer.field) });
                  const more = t("round.short.more", { more: offer.more });
                  return (
                    <Button
                      key={offer.field}
                      variant="outline"
                      className="flex-col items-start py-3"
                      disabled={busy}
                      accessibilityLabel={`${what}. ${more}`}
                      onPress={() => {
                        tap();
                        then(onRelax({ field: offer.field, kind }));
                      }}
                    >
                      <Text className="font-medium">{field(offer.field)}</Text>
                      <Text className="font-normal">{more}</Text>
                    </Button>
                  );
                })}
              </View>
            );
          })}
        </>
      )}
      {pool.relaxed.map((relaxation) => (
        <Button
          key={relaxation.field}
          variant="ghost"
          disabled={busy}
          accessibilityLabel={t("round.relaxed.undo", { field: field(relaxation.field) })}
          onPress={() => {
            tap();
            then(onUndo(relaxation.field));
          }}
        >
          {t("round.relaxed.undo", { field: field(relaxation.field) })}
        </Button>
      ))}
    </View>
  );
}
