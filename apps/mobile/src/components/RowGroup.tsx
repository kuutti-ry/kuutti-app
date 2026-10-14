import ChevronRight from "lucide-react-native/icons/chevron-right";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export type Row = {
  key: string;
  title: string;
  /** What is in it, under the title; a screen reader hears it as the hint. */
  summary?: string;
  /** Its state in words, heard as the value (the profile's progress). */
  value?: string;
  /** A mark of its state, drawn before the chevron. */
  mark?: ReactNode;
  /** A fact at the right of a row that opens nothing (a version number). */
  detail?: string;
  /** Opens the row's screen; a row without one is read, not pressed. */
  onPress?: () => void;
};

/**
 * One group of rows, the profile's front page's and the settings' (#227,
 * #287): each a button that opens a screen, with the title naming it, the
 * summary saying what is in it, the mark or the value saying its state, and
 * the chevron saying it opens. The label stays the title alone, so a row is
 * found by its name whatever its state. A row with nothing to open is plain.
 */
export function RowGroup({ rows }: { rows: readonly Row[] }) {
  return (
    <Card className="gap-0 py-0">
      {rows.map((row, index) => {
        const edge = cn(
          "justify-between gap-3 rounded-none px-4 py-3",
          index < rows.length - 1 && "border-b border-border",
        );
        const words = (
          <View className="flex-1 gap-0.5">
            <Text>{row.title}</Text>
            {row.summary && (
              <Text className="text-sm font-normal text-muted-foreground">{row.summary}</Text>
            )}
          </View>
        );
        if (!row.onPress) {
          return (
            <View
              key={row.key}
              accessible
              accessibilityLabel={row.title}
              accessibilityValue={row.detail ? { text: row.detail } : undefined}
              className={cn("flex-row items-center", edge)}
            >
              {words}
              {row.detail && <Text className="text-muted-foreground">{row.detail}</Text>}
            </View>
          );
        }
        return (
          <Button
            key={row.key}
            variant="ghost"
            accessibilityLabel={row.title}
            accessibilityHint={row.summary}
            accessibilityValue={row.value ? { text: row.value } : undefined}
            className={edge}
            onPress={row.onPress}
          >
            {words}
            {row.mark}
            <Icon as={ChevronRight} className="text-muted-foreground" />
          </Button>
        );
      })}
    </Card>
  );
}
