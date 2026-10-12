import CircleCheck from "lucide-react-native/icons/circle-check";
import { cssInterop } from "nativewind";
import Svg, { Circle } from "react-native-svg";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { DECORATIVE } from "@/theme/a11y";
import { isDone, type Progress } from "./progress";

/** The two ways a part not yet done shows how far it is filled (#239): a ring filled in proportion, or a count. */
export type MarkStyle = "ring" | "count";

// The text colour class reaches the strokes as currentColor, the way Icon colours lucide's.
const Ring = cssInterop(Svg, { className: "style" });

const SIZE = 20;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How far one part of the profile is filled, at the end of its row on the
 * list (#239): a check mark once done; before that a ring filled in
 * proportion or a count such as 1/3. Neutral on purpose: the text colour, no
 * warning colour, nothing that reads as a task left undone (every field is
 * optional, ADR-019). Decorative: the row's accessibility value says it in
 * words, so the shape is never the only carrier.
 */
export function ProgressMark({ progress, style }: { progress: Progress; style: MarkStyle }) {
  const { t } = useT();
  if (isDone(progress)) {
    return <Icon as={CircleCheck} className="text-foreground" testID="progress-done" />;
  }
  if (style === "count") {
    return (
      <Text variant="muted" {...DECORATIVE}>
        {t("profile.progress.short", progress)}
      </Text>
    );
  }
  // Not done means something is counted, so the total is never 0 here.
  const filled = progress.answered / progress.total;
  return (
    <Ring
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="text-foreground"
      testID="progress-ring"
      {...DECORATIVE}
    >
      {/* The whole circle faint, the answered part over it from twelve o'clock. The
          faintness is the shape's opacity: iOS drew a currentColor stroke at full
          strength whatever its strokeOpacity (#239). */}
      <Circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        stroke="currentColor"
        opacity={0.25}
        strokeWidth={STROKE}
        fill="none"
      />
      {filled > 0 && (
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${CIRCUMFERENCE * filled} ${CIRCUMFERENCE}`}
          fill="none"
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      )}
    </Ring>
  );
}

/** What a screen reader hears for the same progress: the row's accessibility value. */
export function progressWords(t: ReturnType<typeof useT>["t"], progress: Progress): string {
  return isDone(progress) ? t("profile.progress.done") : t("profile.progress.answered", progress);
}
