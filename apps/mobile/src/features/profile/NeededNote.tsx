import { NEEDED_MARK } from "@/components/RowGroup";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";

/**
 * The footnote under starred rows and fields (#616): what the star means. A
 * screen reader hears the words without the star, and each starred item says
 * the same words itself. Nothing starred is refused: a card that lacks one is
 * only not shown (the maintainer, 07/11/2026).
 */
export function NeededNote() {
  const { t } = useT();
  const words = t("profile.needed.hint");
  return (
    <Text variant="muted" accessibilityLabel={words}>
      {NEEDED_MARK.trim()} {words}
    </Text>
  );
}
