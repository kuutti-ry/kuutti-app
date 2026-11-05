import CircleCheck from "lucide-react-native/icons/circle-check";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { DECORATIVE } from "@/theme/a11y";
import { isDone, type Progress } from "./progress";

/**
 * How far one part of the profile is filled, at the end of its row on the
 * list (#239): a check mark once done; before that a count such as 1/3, where
 * one question is one item (the maintainer, 04/11/2026). Neutral on purpose:
 * the text colour, no warning colour, nothing that reads as a task left undone
 * (every field is optional, ADR-019). Decorative: the row's accessibility value
 * says it in words, so the shape is never the only carrier.
 */
export function ProgressMark({ progress }: { progress: Progress }) {
  const { t } = useT();
  if (isDone(progress)) {
    return <Icon as={CircleCheck} className="text-foreground" testID="progress-done" />;
  }
  return (
    <Text variant="muted" {...DECORATIVE}>
      {t("profile.progress.short", progress)}
    </Text>
  );
}

/** What a screen reader hears for the same progress: the row's accessibility value. */
export function progressWords(t: ReturnType<typeof useT>["t"], progress: Progress): string {
  return isDone(progress) ? t("profile.progress.done") : t("profile.progress.answered", progress);
}
