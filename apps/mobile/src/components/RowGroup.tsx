import type { LucideIcon } from "lucide-react-native";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import ChevronUp from "lucide-react-native/icons/chevron-up";
import { type ReactNode, useRef } from "react";
import { Platform, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";

export type Row = {
  key: string;
  title: string;
  /** What is in it, or what is chosen, under the title; a screen reader hears it as the hint, unless it is the value. */
  summary?: string;
  /** Its state in words, heard as the value (the profile's progress, the theme chosen). */
  value?: string;
  /** A mark of its state, drawn before the chevron. */
  mark?: ReactNode;
  /** A picture before the title, decoration only (Settings' placeholders until #410's icons). */
  icon?: LucideIcon;
  /** A fact at the right of a row that opens nothing (a version number). */
  detail?: string;
  /** Opens the row's screen, or opens and closes its panel; a row without one is read, not pressed. */
  onPress?: () => void;
  /** What the row holds in place (#511): drawn under it while `expanded`, the press opening and closing it. */
  panel?: ReactNode;
  expanded?: boolean;
  /** Keeps a closed panel mounted and hidden, so what was typed in it waits for the row to open again. */
  kept?: boolean;
  /** Called once each time the panel opens, as it is first laid out, with the row's two parts. */
  onOpened?: (parts: { wrapper: View; header: View }) => void;
};

/**
 * One group of rows, the profile's front page's and the settings' (#227,
 * #287): each a button that opens a screen, with the title naming it, the
 * summary saying what is in it, the mark or the value saying its state, and
 * the chevron saying it opens. The label stays the title alone, so a row is
 * found by its name whatever its state. A row with nothing to open is plain.
 *
 * A row with a panel opens it under itself instead (#511): its chevron points
 * down while closed and up while open. Android and the web hear the state
 * from `expanded`, and TalkBack's actions open and close the row; iOS's
 * renderer says "expanded" but never "collapsed", so there the state is said
 * in words after the value, in the app's language. Nothing moves on the way:
 * the panel is there or not, so reduce motion has nothing to stop. A panel
 * once opened may stay mounted while closed (`kept`), out of sight and out of
 * a screen reader's reach.
 */
export function RowGroup({ rows }: { rows: readonly Row[] }) {
  return (
    <Card className="gap-0 py-0">
      {rows.map((row, index) => (
        <RowView key={row.key} row={row} last={index === rows.length - 1} />
      ))}
    </Card>
  );
}

function RowView({ row, last }: { row: Row; last: boolean }) {
  const { t } = useT();
  const wrapper = useRef<View>(null);
  const header = useRef<View>(null);
  // Whether the open panel has been laid out since it opened: onOpened is called once for each opening.
  const told = useRef(false);
  const holds = row.panel !== undefined;
  const open = holds && row.expanded === true;
  if (!open) told.current = false;
  const hairline = !last && "border-b border-border";
  // border-0: a Button has a 1 px border on every side (#239, #467), and a
  // row draws only the hairline under it; a row with a panel, under the panel.
  const edge = cn(
    "justify-between gap-3 rounded-none border-0 px-4 py-3",
    row.icon && "items-start",
    !holds && hairline,
  );
  const words = (
    <View className="flex-1 gap-0.5">
      <Text>{row.title}</Text>
      {row.summary && (
        <Text className="text-sm font-normal text-muted-foreground">{row.summary}</Text>
      )}
    </View>
  );
  // The picture and the chevron sit by the title's first line, however many lines the title takes.
  const picture = row.icon && <Icon as={row.icon} size={22} className="mt-0.5 text-foreground" />;

  if (!row.onPress) {
    return (
      <View
        accessible
        accessibilityLabel={row.title}
        // The label stands for the children, so the summary is said with the detail.
        accessibilityValue={
          row.detail || row.summary
            ? { text: [row.detail, row.summary].filter(Boolean).join(", ") }
            : undefined
        }
        className={cn("flex-row items-center", edge)}
      >
        {picture}
        {words}
        {row.detail && <Text className="text-muted-foreground">{row.detail}</Text>}
      </View>
    );
  }

  const ios = Platform.OS === "ios";
  const state = open ? t("row.state.open") : t("row.state.closed");
  const value =
    holds && ios
      ? row.value
        ? t("row.state.withValue", { value: row.value, state })
        : state
      : row.value;
  const button = (
    <Button
      ref={header}
      variant="ghost"
      accessibilityLabel={row.title}
      // A summary that is the state is heard once, as the value.
      accessibilityHint={row.summary !== row.value ? row.summary : undefined}
      accessibilityValue={value ? { text: value } : undefined}
      accessibilityState={holds && !ios ? { expanded: open } : undefined}
      // TalkBack offers expand and collapse from its actions; without a handler they would open nothing.
      accessibilityActions={
        holds && Platform.OS === "android"
          ? [{ name: open ? "collapse" : "expand", label: row.title }]
          : undefined
      }
      onAccessibilityAction={holds ? () => row.onPress?.() : undefined}
      // react-native-web reads the ARIA prop, not accessibilityState; on a
      // phone React Native turns it into the state, which iOS must not have.
      aria-expanded={holds && Platform.OS === "web" ? open : undefined}
      className={edge}
      onPress={row.onPress}
    >
      {picture}
      {words}
      {row.mark}
      <Icon
        as={holds ? (open ? ChevronUp : ChevronDown) : ChevronRight}
        className={cn("text-muted-foreground", row.icon && "mt-0.5")}
      />
    </Button>
  );
  if (!holds) return button;
  const shown = open || row.kept === true;
  return (
    <View ref={wrapper} className={cn(hairline)}>
      {button}
      {shown && (
        <View
          className={cn("gap-4 px-4 pb-4", !open && "hidden")}
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          onLayout={() => {
            if (!open || told.current || !wrapper.current || !header.current) return;
            told.current = true;
            row.onOpened?.({ wrapper: wrapper.current, header: header.current });
          }}
        >
          {row.panel}
        </View>
      )}
    </View>
  );
}
