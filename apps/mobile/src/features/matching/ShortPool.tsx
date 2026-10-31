import type { DealBreakerField, Relaxation, RelaxationsResponse } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { fieldLabelKey } from "@/features/profile";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchRelaxations } from "./client";

/**
 * The short pool (#99, ADR-042), at the end of a short round or an empty one:
 * what the person may relax for today, each a button that says the
 * deal-breaker, the way and how much it widens their pool (in the counter's
 * steps, `waitlist_k`, never a count of cards), and what is relaxed today, each undone by one tap.
 * Read when it comes into sight, as the offers are counted on asking, and
 * again after each tap. Nothing relaxes but the person's tap; a read that
 * fails shows nothing, and the round's end says to come back tomorrow as
 * before.
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
    <View className="gap-3">
      {pool.offers.length > 0 && (
        <>
          <Text variant="h3" accessibilityRole="header">
            {t("round.short.title")}
          </Text>
          <Text>{t("round.short.explain")}</Text>
          {pool.offers.map((offer) => {
            const what = t(
              offer.kind === "unanswered" ? "round.short.unanswered" : "round.short.aside",
              { field: field(offer.field) },
            );
            const more = t("round.short.more", { more: offer.more });
            return (
              <Button
                key={`${offer.field}/${offer.kind}`}
                variant="outline"
                className="flex-col items-start py-3"
                disabled={busy}
                accessibilityLabel={`${what}. ${more}`}
                onPress={() => {
                  tap();
                  then(onRelax({ field: offer.field, kind: offer.kind }));
                }}
              >
                <Text>{what}</Text>
                <Text variant="muted">{more}</Text>
              </Button>
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
